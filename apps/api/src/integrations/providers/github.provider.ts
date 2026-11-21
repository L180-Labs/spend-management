import { Logger } from '@nestjs/common';
import { IntegrationProvider, ProjectBreakdownItem, SpendResult, UsageBreakdownItem } from '../provider.interface';
import { fetchWithTimeout } from './http';

// GitHub enhanced billing platform - billing usage report:
//   GET /organizations/{org}/settings/billing/usage   (org: fine-grained PAT with
//       "Administration" org permission = read, or a classic PAT with admin:org)
//   GET /users/{username}/settings/billing/usage      (personal: "Plan" user permission = read)
// https://docs.github.com/en/rest/billing/enhanced-billing
// Returns metered line items (Actions minutes, Packages, Codespaces, Copilot,
// LFS, seats...) with a netAmount in USD after discounts/included quotas.
const API = 'https://api.github.com';

export interface GitHubConfig {
  token: string;
  accountType: 'org' | 'user';
  accountName: string;
}

interface UsageItem {
  date: string; // YYYY-MM-DD (or an ISO timestamp)
  product: string;
  sku: string;
  quantity: number;
  netAmount: number;
  repositoryName?: string;
}

/** Every [year, month] (1-based) touched by an inclusive date range, oldest first. */
export function monthsInRange(startDate: Date, endDate: Date): [number, number][] {
  const result: [number, number][] = [];
  let y = startDate.getUTCFullYear();
  let m = startDate.getUTCMonth() + 1;
  const endY = endDate.getUTCFullYear();
  const endM = endDate.getUTCMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    result.push([y, m]);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return result;
}

export class GitHubProvider implements IntegrationProvider {
  private readonly logger = new Logger(GitHubProvider.name);

  async fetchSpendUSD(config: Record<string, any>): Promise<SpendResult> {
    const now = new Date();
    const items = await this.fetchUsage(config, now.getUTCFullYear(), now.getUTCMonth() + 1);
    const result = this.summarise(items);
    this.logger.log(`GitHub ${config.accountName} month-to-date: $${result.amountUSD.toFixed(2)}`);
    return result;
  }

  async fetchHistoricalSpendUSD(config: Record<string, any>, range: { startDate: Date; endDate: Date }) {
    const start = range.startDate.toISOString().slice(0, 10);
    const end = range.endDate.toISOString().slice(0, 10);
    const items: UsageItem[] = [];
    for (const [year, month] of monthsInRange(range.startDate, range.endDate)) {
      for (const item of await this.fetchUsage(config, year, month)) {
        const day = String(item.date).slice(0, 10);
        if (day >= start && day <= end) items.push(item);
      }
    }
    return this.summarise(items);
  }

  private summarise(items: UsageItem[]): { amountUSD: number; breakdown: UsageBreakdownItem[]; byProject: ProjectBreakdownItem[] } {
    const byProduct = new Map<string, number>();
    const byRepo = new Map<string, number>();
    let total = 0;
    for (const item of items) {
      const amount = Number(item.netAmount) || 0;
      total += amount;
      byProduct.set(item.product, (byProduct.get(item.product) ?? 0) + amount);
      if (item.repositoryName) byRepo.set(item.repositoryName, (byRepo.get(item.repositoryName) ?? 0) + amount);
    }
    const breakdown = [...byProduct.entries()]
      .map(([measurement, amountUSD]) => ({ measurement, amountUSD, rawValue: amountUSD }))
      .filter((b) => b.amountUSD > 0)
      .sort((a, b) => b.amountUSD - a.amountUSD);
    const byProject = [...byRepo.entries()]
      .map(([repo, amountUSD]) => ({ projectId: repo, projectName: repo, amountUSD }))
      .filter((p) => p.amountUSD > 0)
      .sort((a, b) => b.amountUSD - a.amountUSD);
    // Total from every line item; the breakdown lists only products with a charge.
    return { amountUSD: Math.max(0, total), breakdown, byProject };
  }

  private async fetchUsage(config: Record<string, any>, year: number, month: number): Promise<UsageItem[]> {
    const { token, accountType, accountName } = config as GitHubConfig;
    if (!token || !accountName) throw new Error('GitHub config missing token or account name');
    const owner = encodeURIComponent(accountName.trim());
    const path = accountType === 'user' ? `/users/${owner}/settings/billing/usage` : `/organizations/${owner}/settings/billing/usage`;

    const resp = await fetchWithTimeout(`${API}${path}?year=${year}&month=${month}`, {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'spend-management',
      },
    }, 'GitHub');
    const json = (await resp.json().catch(() => null)) as any;
    if (!resp.ok) {
      const message = json?.message ?? `HTTP ${resp.status}`;
      if (resp.status === 401) throw new Error('GitHub rejected the token - check it hasn\'t expired.');
      if (resp.status === 403) {
        throw new Error(accountType === 'user'
          ? `GitHub token can't read billing for ${accountName} - it needs the "Plan" (read) user permission.`
          : `GitHub token can't read billing for ${accountName} - it needs the "Administration" (read) organization permission, and you must be an org owner or billing manager.`);
      }
      if (resp.status === 404) {
        throw new Error(`GitHub ${accountType === 'user' ? 'user' : 'organization'} "${accountName}" not found, or it isn't on the enhanced billing platform.`);
      }
      throw new Error(`GitHub API error: ${message}`);
    }
    if (!Array.isArray(json?.usageItems)) throw new Error('GitHub response missing usageItems');
    return json.usageItems as UsageItem[];
  }
}
