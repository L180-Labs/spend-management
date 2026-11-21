import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IntegrationProvider } from './provider.interface';
import { RailwayProvider } from './providers/railway.provider';
import { ClaudeProvider } from './providers/claude.provider';
import { HeyGenProvider } from './providers/heygen.provider';
import { GCPProvider } from './providers/gcp.provider';
import { AWSProvider } from './providers/aws.provider';
import { GitHubProvider } from './providers/github.provider';
import { MetaAdsProvider } from './providers/meta-ads.provider';

// Register new providers here - no other file needs to change.
export const PROVIDERS: Record<string, IntegrationProvider> = {
  RAILWAY: new RailwayProvider(),
  CLAUDE: new ClaudeProvider(),
  HEYGEN: new HeyGenProvider(),
  GCP: new GCPProvider(),
  AWS: new AWSProvider(),
  GITHUB: new GitHubProvider(),
  META_ADS: new MetaAdsProvider(),
};

/**
 * Whether the hourly scheduler should sync now, honouring the provider's
 * minSyncIntervalMinutes. Failed attempts count too (lastFailedSyncAt), so a
 * broken connection is retried on the same slow schedule as a working one
 * rather than every hour.
 */
export function isDueForScheduledSync(
  provider: IntegrationProvider | undefined,
  lastSyncAt: Date | null,
  now = Date.now(),
  lastFailedSyncAt?: string | Date | null,
): boolean {
  const minMinutes = provider?.minSyncIntervalMinutes;
  if (!minMinutes) return true;
  const attempts = [lastSyncAt, lastFailedSyncAt].map((d) => (d ? new Date(d).getTime() : NaN)).filter((t) => !Number.isNaN(t));
  if (attempts.length === 0) return true;
  return now - Math.max(...attempts) >= minMinutes * 60_000 - 60_000; // 1 min slack for cron jitter
}

/**
 * Whether a sync may replace the tool's cap with the provider-reported one.
 * `lastProviderCap` comes from the lastProviderCapUSD / providerCapTracked
 * columns (see providerCapState):
 *  - a number: the cap the provider set last time. The tool still having it
 *    means nobody changed it, so follow the provider (including a new budget).
 *    Anything else was typed in by hand, and is kept.
 *  - null: saved by the current code, but no provider cap applied yet. Adopt
 *    only if the tool has no cap, or already matches - a different cap was
 *    entered by hand when connecting.
 *  - undefined: connected before caps were remembered. Keep the old behaviour
 *    (always follow the provider), then remember it from here on.
 */
export function shouldAdoptProviderCap(currentCap: number, providerCap: number, lastProviderCap: number | null | undefined): boolean {
  if (!(currentCap > 0)) return true;
  if (lastProviderCap === undefined) return true;
  const reference = lastProviderCap ?? providerCap;
  return Math.abs(currentCap - reference) < 0.005;
}

/** The tri-state shouldAdoptProviderCap expects, from the integration's columns. */
export function providerCapState(row: { lastProviderCapUSD: number | null; providerCapTracked: boolean } | null): number | null | undefined {
  if (!row?.providerCapTracked) return undefined;
  return row.lastProviderCapUSD;
}

/** The integration fields a sync needs. configUpdatedAt is what was saved when the sync started. */
export interface SyncableIntegration {
  id: string;
  toolId: string;
  provider: string;
  config: any;
  configUpdatedAt?: Date;
}

@Injectable()
export class IntegrationRunnerService {
  private readonly logger = new Logger(IntegrationRunnerService.name);

  constructor(private prisma: PrismaService) { }

  /** Run all active integrations that are due. Called by the scheduler cron. */
  async runAll() {
    const integrations = await this.prisma.toolIntegration.findMany({
      where: { isActive: true, tool: { deletedAt: null } },
    });
    const now = Date.now();
    const due = integrations.filter((i) =>
      isDueForScheduledSync(PROVIDERS[i.provider], i.lastSyncAt, now, i.lastFailedSyncAt));
    await Promise.allSettled(due.map((i) => this.runOne(i)));
  }

  /**
   * Run a single integration and update the tool's usedAmount + barPct (and
   * capAmount/alertThresholdPct, if the provider exposes a budget). All amounts
   * are USD - the app's base currency.
   *
   * `applyLimits: false` leaves the cap alone - for the sync that runs when an
   * integration is saved, where the Add Tool / Configure screens set the cap
   * themselves. Otherwise a slow sync finishing after them could overwrite it.
   *
   * A sync never rewrites config (the credentials). Its results are written
   * only if the config it started with is still the saved one: if the user
   * re-saved the integration meanwhile (e.g. corrected a mistyped secret), the
   * stale result is discarded, so it can't show an error for, or data from,
   * credentials that are no longer in use.
   */
  async runOne(integration: SyncableIntegration, options: { applyLimits?: boolean } = {}) {
    const applyLimits = options.applyLimits ?? true;
    const provider = PROVIDERS[integration.provider];
    if (!provider) {
      this.logger.warn(`No provider registered for "${integration.provider}"`);
      return;
    }

    try {
      const config = integration.config as Record<string, any>;
      const { amountUSD, breakdown, byProject, providerState, remainingBalanceUSD } = await provider.fetchSpendUSD(config);

      // Pull the latest budget cap too, if this provider can report one - keeps the
      // dashboard's cap in sync with whatever's configured on the provider's side,
      // not just whatever was captured when the tool was first connected.
      let hardLimitUSD: number | null = null;
      let softLimitUSD: number | null = null;
      if (applyLimits && provider.fetchLimitsUSD) {
        try {
          const limits = await provider.fetchLimitsUSD(config);
          if (limits && limits.computeHardLimitUSD > 0) {
            hardLimitUSD = limits.computeHardLimitUSD;
            softLimitUSD = limits.computeSoftLimitUSD ?? null;
          }
        } catch (limitsErr: any) {
          this.logger.warn(`Could not refresh limits for tool ${integration.toolId}: ${limitsErr.message}`);
        }
      }

      const stale = await this.prisma.$transaction(async (tx) => {
        // Claim the write: only if the credentials haven't been re-saved since this sync started.
        const claimed = await tx.toolIntegration.updateMany({
          where: this.unchangedSince(integration),
          data: {
            lastSyncAt: new Date(),
            lastSyncAmountUSD: amountUSD,
            lastSyncBreakdown: (breakdown as unknown as Prisma.InputJsonValue) ?? undefined,
            lastSyncByProject: (byProject as unknown as Prisma.InputJsonValue) ?? undefined,
            // A plain scalar - explicitly null (not undefined/"don't touch") for a
            // provider that doesn't report a balance, so a tool that stops having
            // one (or switches provider) doesn't keep showing a stale figure.
            lastSyncRemainingBalanceUSD: remainingBalanceUSD ?? null,
            lastError: null,
          },
        });
        if (claimed.count === 0) return true;

        // Only providers that can't recompute spend from scratch each sync (e.g.
        // HeyGen's balance-delta tracking) return providerState. Merged into config
        // in the database (jsonb ||), touching only those keys - never written back
        // from this sync's copy of config, which holds the credentials.
        if (providerState && Object.keys(providerState).length > 0) {
          await tx.$executeRaw`UPDATE "tool_integrations" SET "config" = "config" || ${JSON.stringify(providerState)}::jsonb WHERE "id" = ${integration.id}`;
        }

        const [tool, capRow] = await Promise.all([
          tx.tool.findUnique({ where: { id: integration.toolId }, select: { capAmount: true, alertThresholdPct: true } }),
          tx.toolIntegration.findUnique({ where: { id: integration.id }, select: { lastProviderCapUSD: true, providerCapTracked: true } }),
        ]);

        const currentCap = Number(tool?.capAmount ?? 0);
        const lastProviderCap = providerCapState(capRow);
        const adoptCap = hardLimitUSD !== null && shouldAdoptProviderCap(currentCap, hardLimitUSD, lastProviderCap);
        const capAmount = adoptCap ? hardLimitUSD! : currentCap;
        const alertThresholdPct = adoptCap && softLimitUSD !== null
          ? Math.round((softLimitUSD / hardLimitUSD!) * 100)
          : tool?.alertThresholdPct;
        if (hardLimitUSD !== null && !adoptCap) {
          this.logger.log(`Keeping hand-entered cap $${currentCap} for tool ${integration.toolId} (provider reports $${hardLimitUSD})`);
        }
        const barPct = capAmount > 0
          ? Math.min(100, Math.round((amountUSD / capAmount) * 100))
          : 0;

        await tx.tool.update({
          where: { id: integration.toolId },
          // Cap fields are written only when the provider's cap is being adopted -
          // never re-written with the value just read, which could clobber a cap
          // saved by someone else in the meantime.
          data: { usedAmount: amountUSD, barPct, ...(adoptCap ? { capAmount, alertThresholdPct } : {}) },
        });
        // Remember the cap the provider set, so a later hand edit can be told apart from it.
        if (adoptCap && (lastProviderCap !== hardLimitUSD || !capRow?.providerCapTracked)) {
          await tx.toolIntegration.update({
            where: { id: integration.id },
            data: { lastProviderCapUSD: hardLimitUSD, providerCapTracked: true },
          });
        }
        return false;
      });

      if (stale) {
        this.logger.log(`Discarded ${integration.provider} sync for tool ${integration.toolId}: its settings were re-saved while it ran`);
        return;
      }
      const capLog = hardLimitUSD !== null ? ` · cap $${hardLimitUSD.toLocaleString('en-US')}` : '';
      this.logger.log(`Synced ${integration.provider} → tool ${integration.toolId}: $${amountUSD.toFixed(2)}${capLog}`);
    } catch (err: any) {
      // Same guard: a failure from credentials that have since been replaced is
      // not an error with the current ones. Only the two status columns change.
      const recorded = await this.prisma.toolIntegration.updateMany({
        where: this.unchangedSince(integration),
        data: { lastError: err.message, lastFailedSyncAt: new Date() },
      });
      if (recorded.count === 0) {
        this.logger.log(`Ignored failed ${integration.provider} sync for tool ${integration.toolId}: its settings were re-saved while it ran (${err.message})`);
      } else {
        this.logger.error(`Sync failed for ${integration.provider} (tool ${integration.toolId}): ${err.message}`);
      }
    }
  }

  /** Matches the integration only while its config is the one this sync started with. */
  private unchangedSince(integration: SyncableIntegration): Prisma.ToolIntegrationWhereInput {
    return integration.configUpdatedAt
      ? { id: integration.id, configUpdatedAt: integration.configUpdatedAt }
      : { id: integration.id };
  }
}
