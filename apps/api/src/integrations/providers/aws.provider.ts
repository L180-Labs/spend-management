import { Logger } from '@nestjs/common';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { BudgetsClient, DescribeBudgetsCommand } from '@aws-sdk/client-budgets';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IntegrationProvider, ProjectBreakdownItem, SpendResult, UsageBreakdownItem } from '../provider.interface';

// AWS Cost Explorer - https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html
// Authenticated with an IAM access key. Minimum IAM policy:
//   ce:GetCostAndUsage          (spend + history)
//   budgets:ViewBudget, sts:GetCallerIdentity   (optional - reads the cap from AWS Budgets)
// Cost Explorer is a global service served from us-east-1, and AWS charges
// $0.01 per GetCostAndUsage request - one sync costs one request (more only if
// the result is paginated). Data lags ~24h behind real usage and Cost Explorer
// only refreshes a few times a day, so scheduled syncs run every 6 hours rather
// than hourly (~4 requests/day, about $1.20 a month per connected account).
const CE_REGION = 'us-east-1';
const MIN_SYNC_INTERVAL_MINUTES = 6 * 60;
const METRIC = 'UnblendedCost';
// Cost Explorer includes credits and refunds by default, netting them against
// usage - an account running on AWS credits would then read ~$0 however much it
// uses. Excluding those two record types reports what the usage actually cost.
// (Free-tier and bundled discounts are different record types and still apply.)
export const EXCLUDE_CREDITS_AND_REFUNDS = {
  Not: { Dimensions: { Key: 'RECORD_TYPE' as const, Values: ['Credit', 'Refund'] } },
};
// Each AWS request gets 15s; one retry on a transient failure, not the SDK's default two.
const CLIENT_OPTIONS = {
  region: CE_REGION,
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 5_000, requestTimeout: 15_000 },
};

export interface AWSConfig {
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional - only needed when the key is temporary (STS) credentials. */
  sessionToken?: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Cost Explorer takes [Start, End) as YYYY-MM-DD with End EXCLUSIVE, so an
 * inclusive end date (today, or a range's last day) becomes End = that day + 1.
 */
export function costExplorerPeriod(startDate: Date, endDateInclusive: Date): { Start: string; End: string } {
  const end = new Date(Date.UTC(endDateInclusive.getUTCFullYear(), endDateInclusive.getUTCMonth(), endDateInclusive.getUTCDate() + 1));
  return { Start: ymd(startDate), End: ymd(end) };
}

/**
 * Budgets that cover the whole account - no cost filters (a budget scoped to
 * one service, tag or linked account would understate the account's real cap).
 */
export function isAccountWideBudget(budget: { CostFilters?: Record<string, string[]>; FilterExpression?: unknown }): boolean {
  const hasCostFilters = Object.values(budget.CostFilters ?? {}).some((values) => (values ?? []).length > 0);
  return !hasCostFilters && !budget.FilterExpression;
}

export class AWSProvider implements IntegrationProvider {
  private readonly logger = new Logger(AWSProvider.name);
  readonly minSyncIntervalMinutes = MIN_SYNC_INTERVAL_MINUTES;

  private credentials(config: Record<string, any>) {
    const { accessKeyId, secretAccessKey, sessionToken } = config as AWSConfig;
    if (!accessKeyId || !secretAccessKey) throw new Error('AWS config missing accessKeyId or secretAccessKey');
    return { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(), sessionToken: sessionToken?.trim() || undefined };
  }

  /** Month-to-date spend, broken down by AWS service. */
  async fetchSpendUSD(config: Record<string, any>): Promise<SpendResult> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const { amountUSD, breakdown } = await this.queryCost(config, monthStart, now);
    this.logger.log(`AWS month-to-date: $${amountUSD.toFixed(2)} across ${breakdown.length} services`);
    return { amountUSD, breakdown };
  }

  async fetchHistoricalSpendUSD(config: Record<string, any>, range: { startDate: Date; endDate: Date }) {
    const { amountUSD, breakdown } = await this.queryCost(config, range.startDate, range.endDate);
    return { amountUSD, breakdown, byProject: [] as ProjectBreakdownItem[] };
  }

  /**
   * Reads an account-wide monthly USD COST budget from AWS Budgets as the cap
   * (alert at 80%). Budgets filtered to one service/tag/account are skipped -
   * they don't describe the whole account's spend. Returns null when the key
   * can't read budgets or there's no account-wide one - a budget is optional
   * in AWS, so this must never block connecting (the UI falls back to a manual cap).
   */
  async fetchLimitsUSD(config: Record<string, any>): Promise<Record<string, any> | null> {
    try {
      const credentials = this.credentials(config);
      const identity = await new STSClient({ ...CLIENT_OPTIONS, credentials }).send(new GetCallerIdentityCommand({}));
      if (!identity.Account) return null;
      const res = await new BudgetsClient({ ...CLIENT_OPTIONS, credentials }).send(new DescribeBudgetsCommand({ AccountId: identity.Account }));
      const budget = (res.Budgets ?? []).find((b) =>
        b.BudgetType === 'COST' && b.TimeUnit === 'MONTHLY' && b.BudgetLimit?.Unit === 'USD' && isAccountWideBudget(b as any));
      const hard = Number(budget?.BudgetLimit?.Amount ?? 0);
      if (!budget || !(hard > 0)) return null;
      return { computeHardLimitUSD: hard, computeSoftLimitUSD: hard * 0.8, budgetName: budget.BudgetName };
    } catch (err: any) {
      this.logger.warn(`AWS budget lookup skipped: ${err.message}`);
      return null;
    }
  }

  private async queryCost(config: Record<string, any>, startDate: Date, endDateInclusive: Date): Promise<{ amountUSD: number; breakdown: UsageBreakdownItem[] }> {
    const client = new CostExplorerClient({ ...CLIENT_OPTIONS, credentials: this.credentials(config) });
    const byService = new Map<string, number>();
    let nextPageToken: string | undefined;
    try {
      do {
        const res = await client.send(new GetCostAndUsageCommand({
          TimePeriod: costExplorerPeriod(startDate, endDateInclusive),
          Granularity: 'MONTHLY',
          Metrics: [METRIC],
          GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
          Filter: EXCLUDE_CREDITS_AND_REFUNDS,
          NextPageToken: nextPageToken,
        }));
        for (const period of res.ResultsByTime ?? []) {
          for (const group of period.Groups ?? []) {
            const metric = group.Metrics?.[METRIC];
            if (metric?.Unit && metric.Unit !== 'USD') throw new Error(`AWS returned cost in ${metric.Unit}; only USD billing is supported`);
            const service = group.Keys?.[0] ?? 'Other';
            byService.set(service, (byService.get(service) ?? 0) + Number(metric?.Amount ?? 0));
          }
        }
        nextPageToken = res.NextPageToken;
      } while (nextPageToken);
    } catch (err: any) {
      const name = err?.name ?? '';
      if (name === 'AccessDeniedException') throw new Error('AWS key is missing the ce:GetCostAndUsage permission.');
      if (name === 'UnrecognizedClientException' || name === 'InvalidClientTokenId' || name === 'SignatureDoesNotMatch') {
        throw new Error('AWS rejected the access key - check the Access Key ID and Secret Access Key.');
      }
      if (name === 'DataUnavailableException') return { amountUSD: 0, breakdown: [] }; // brand-new account: no cost data yet
      if (name === 'TimeoutError' || name === 'RequestTimeout' || err?.code === 'ETIMEDOUT') {
        throw new Error('AWS Cost Explorer did not respond in time - try again later.');
      }
      throw new Error(`AWS Cost Explorer error: ${err.message}`);
    }

    // Total from EVERY service, including sub-cent ones - many tiny charges can
    // add up. Only the displayed breakdown drops items under half a cent.
    const net = [...byService.values()].reduce((sum, amount) => sum + amount, 0);
    // Free-tier offsets show up as negative line items (e.g. -$0.035 Data Transfer
    // against +$0.035 EC2), which can leave the net a hair below zero. Round to
    // cents and floor at $0 so the dashboard never shows "-$0.00".
    const amountUSD = Math.max(0, Math.round(net * 100) / 100);
    const breakdown = [...byService.entries()]
      .map(([measurement, amount]) => ({ measurement, amountUSD: amount, rawValue: amount }))
      .filter((b) => Math.abs(b.amountUSD) >= 0.005)
      .sort((a, b) => b.amountUSD - a.amountUSD);
    return { amountUSD, breakdown };
  }
}
