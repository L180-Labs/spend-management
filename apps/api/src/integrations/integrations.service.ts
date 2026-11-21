import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IntegrationRunnerService, PROVIDERS } from './integration-runner.service';

/** Longest Save waits for the first sync before returning (the sync keeps running after). */
export const SAVE_SYNC_WAIT_MS = 20_000;

@Injectable()
export class IntegrationsService {
  constructor(
    private prisma: PrismaService,
    private runner: IntegrationRunnerService,
  ) { }

  async get(toolId: string, orgId: string) {
    await this.assertToolOwnership(toolId, orgId);
    const integration = await this.prisma.toolIntegration.findUnique({ where: { toolId } });
    if (!integration) return null;
    // Return config with apiToken masked - never expose raw secrets over the API
    const { config, ...rest } = integration;
    const safeConfig = this.maskConfig(config as Record<string, any>);
    return { ...rest, config: safeConfig };
  }

  async upsert(toolId: string, orgId: string, body: { provider: string; config: Record<string, any>; isActive?: boolean }) {
    await this.assertToolOwnership(toolId, orgId);
    // Bookkeeping lives in its own columns, never inside config (the credentials):
    //  - configUpdatedAt: a new version of the credentials. A sync still running
    //    on the previous ones discards its result instead of writing it.
    //  - lastProviderCapUSD null + providerCapTracked: "no provider cap applied
    //    since this save" (see shouldAdoptProviderCap). It also drops any cap
    //    remembered from before, so re-saving the integration is how a
    //    hand-entered cap is handed back to the provider (the Configure screen
    //    applies the provider's limit on save).
    //  - lastFailedSyncAt cleared: new credentials shouldn't inherit the old back-off.
    const bookkeeping = {
      configUpdatedAt: new Date(),
      lastProviderCapUSD: null,
      providerCapTracked: true,
      lastFailedSyncAt: null,
      lastError: null,
    };
    const saved = await this.prisma.toolIntegration.upsert({
      where: { toolId },
      update: {
        provider: body.provider,
        config: body.config,
        isActive: body.isActive ?? true,
        ...bookkeeping,
      },
      create: {
        toolId,
        provider: body.provider,
        config: body.config,
        isActive: body.isActive ?? true,
        ...bookkeeping,
      },
    });

    // Sync straight away rather than waiting for the hourly scheduler, so a newly
    // connected tool shows its spend (or a specific error) as soon as it's saved.
    // runOne never throws - a failed fetch is recorded on lastError instead. The
    // wait is capped: if the provider is slow, Save returns anyway and the sync
    // finishes in the background (each request also has its own timeout).
    // applyLimits: false - the Add Tool / Configure screens set the cap
    // themselves, and a slow sync finishing after them must not overwrite it.
    if (saved.isActive) {
      let timer: NodeJS.Timeout | undefined;
      const capped = new Promise<void>((resolve) => { timer = setTimeout(resolve, SAVE_SYNC_WAIT_MS); });
      await Promise.race([this.runner.runOne(saved, { applyLimits: false }), capped]);
      clearTimeout(timer);
    }

    // Never echo the saved credentials back - same masking as GET.
    return this.get(toolId, orgId);
  }

  async remove(toolId: string, orgId: string) {
    await this.assertToolOwnership(toolId, orgId);
    return this.prisma.toolIntegration.delete({ where: { toolId } });
  }

  async fetchLimits(toolId: string, orgId: string) {
    await this.assertToolOwnership(toolId, orgId);
    const integration = await this.prisma.toolIntegration.findUnique({ where: { toolId } });
    if (!integration) throw new NotFoundException('No integration configured for this tool');

    const provider = PROVIDERS[integration.provider];
    if (!provider?.fetchLimitsUSD) {
      return null; // this provider doesn't expose usage limits via API
    }

    const limits = await provider.fetchLimitsUSD(integration.config as Record<string, any>);
    if (!limits) return null;

    return {
      computeHardLimitUSD: limits.computeHardLimitUSD,
      computeSoftLimitUSD: limits.computeSoftLimitUSD,
      alertThresholdPct: limits.computeHardLimitUSD > 0
        ? Math.round((limits.computeSoftLimitUSD / limits.computeHardLimitUSD) * 100)
        : 80,
    };
  }

  async previewLimits(providerName: string, config: Record<string, any>) {
    const provider = PROVIDERS[providerName];
    if (!provider?.fetchLimitsUSD) return null;

    const limits = await provider.fetchLimitsUSD(config);
    if (!limits) return null;

    return {
      computeHardLimitUSD: limits.computeHardLimitUSD,
      computeSoftLimitUSD: limits.computeSoftLimitUSD,
      alertThresholdPct: limits.computeHardLimitUSD > 0
        ? Math.round((limits.computeSoftLimitUSD / limits.computeHardLimitUSD) * 100)
        : 80,
    };
  }

  async getUsageHistory(toolId: string, orgId: string, startDate: Date, endDate: Date) {
    await this.assertToolOwnership(toolId, orgId);
    const integration = await this.prisma.toolIntegration.findUnique({ where: { toolId } });
    if (!integration) throw new NotFoundException('No integration configured for this tool');

    const provider = PROVIDERS[integration.provider];
    if (!provider?.fetchHistoricalSpendUSD) {
      throw new NotFoundException('Usage history is not available for this provider yet');
    }

    let result: { amountUSD: number; breakdown: any[]; byProject: any[] };
    try {
      result = await provider.fetchHistoricalSpendUSD(
        integration.config as Record<string, any>,
        { startDate, endDate },
      );
    } catch (err: any) {
      // A plain Error thrown by a provider (e.g. "token lacks permission") would
      // otherwise be swallowed by Nest's default filter into a generic "Internal
      // server error," hiding a message that's actually specific and actionable -
      // surface it to the client instead.
      throw new BadRequestException(err.message || 'Could not fetch usage history from the provider.');
    }

    return { ...result, startDate, endDate };
  }

  async syncNow(toolId: string, orgId: string) {
    await this.assertToolOwnership(toolId, orgId);
    const integration = await this.prisma.toolIntegration.findUnique({ where: { toolId } });
    if (!integration) throw new NotFoundException('No integration configured for this tool');
    await this.runner.runOne(integration);
    return this.get(toolId, orgId);
  }

  private async assertToolOwnership(toolId: string, orgId: string) {
    const tool = await this.prisma.tool.findFirst({ where: { id: toolId, orgId, deletedAt: null } });
    if (!tool) throw new NotFoundException('Tool not found');
  }

  private maskConfig(config: Record<string, any>): Record<string, any> {
    const masked: Record<string, any> = {};
    for (const [k, v] of Object.entries(config)) {
      if (typeof v === 'string' && v.length > 8) {
        masked[k] = v.slice(0, 4) + '••••' + v.slice(-4);
      } else {
        masked[k] = v;
      }
    }
    return masked;
  }
}
