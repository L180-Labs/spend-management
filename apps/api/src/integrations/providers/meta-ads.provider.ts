import { Logger } from '@nestjs/common';
import { IntegrationProvider, ProjectBreakdownItem, SpendResult } from '../provider.interface';
import { fetchWithTimeout } from './http';

// Meta Marketing API - ad account insights:
//   GET /act_{ad_account_id}?fields=name,currency,timezone_name
//   GET /act_{ad_account_id}/insights?fields=spend&level=campaign&time_range=...
// https://developers.facebook.com/docs/marketing-api/insights
// Authenticated with an access token holding the `ads_read` permission - best
// a System User token from Business Settings, which doesn't expire the way a
// personal user token does.
// No fetchLimitsUSD: an ad account's spend_cap is a LIFETIME cap measured
// against lifetime amount_spent, not a monthly budget - treating it as this
// tool's monthly cap would be wrong, so the cap is entered manually.
const GRAPH_VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const FX_URL = 'https://api.frankfurter.app/latest';

export interface MetaAdsConfig {
  accessToken: string;
  adAccountId: string;
}

/** Accepts "123", "act_123" or " act_123 " and returns "act_123". */
export function normaliseAdAccountId(id: string): string {
  const trimmed = String(id ?? '').trim();
  return trimmed.startsWith('act_') ? trimmed : `act_${trimmed}`;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Today's date (YYYY-MM-DD) in the ad account's time zone. Meta reports and
 * buckets spend by the ACCOUNT's local day, so "this month" must start on the
 * 1st there, not in UTC - otherwise the month boundary is off by a day for any
 * account far from UTC. Falls back to UTC for a missing/unknown zone name.
 */
export function todayInTimeZone(timeZone: string | undefined, now = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return ymd(now);
  }
}

/** Maps a Graph API error object to a message that points at the actual problem. */
export function metaErrorMessage(err: { code?: number; error_subcode?: number; message?: string }, status: number): string {
  if (err.code === 190) return 'Meta rejected the access token - it may have expired. Generate a System User token with ads_read.';
  if (err.code === 200 || err.code === 10) return 'Meta access token lacks the ads_read permission for this ad account.';
  // 100/33: the object doesn't exist or this token can't see it.
  if (err.code === 100 && err.error_subcode === 33) {
    return 'Meta could not find that ad account, or this token has no access to it - check the Ad Account ID and that the ad account is assigned to the system user.';
  }
  if (err.code === 100) return `Meta rejected the request: ${err.message ?? 'invalid parameter'}`;
  return `Meta Marketing API error: ${err.message ?? `HTTP ${status}`}`;
}

export class MetaAdsProvider implements IntegrationProvider {
  private readonly logger = new Logger(MetaAdsProvider.name);

  async fetchSpendUSD(config: Record<string, any>): Promise<SpendResult> {
    // Month-to-date in the account's own time zone.
    const result = await this.querySpend(config, (timeZone) => {
      const today = todayInTimeZone(timeZone);
      return { since: `${today.slice(0, 7)}-01`, until: today };
    });
    this.logger.log(`Meta Ads month-to-date: $${result.amountUSD.toFixed(2)}`);
    return { amountUSD: result.amountUSD, byProject: result.byProject };
  }

  async fetchHistoricalSpendUSD(config: Record<string, any>, range: { startDate: Date; endDate: Date }) {
    // The caller's range is a pair of calendar dates; Meta reads them as days in the account's zone.
    const result = await this.querySpend(config, () => ({ since: ymd(range.startDate), until: ymd(range.endDate) }));
    return { amountUSD: result.amountUSD, breakdown: [], byProject: result.byProject };
  }

  private async querySpend(
    config: Record<string, any>,
    dateRange: (accountTimeZone: string | undefined) => { since: string; until: string },
  ): Promise<{ amountUSD: number; byProject: ProjectBreakdownItem[] }> {
    const { accessToken, adAccountId } = config as MetaAdsConfig;
    if (!accessToken || !adAccountId) throw new Error('Meta Ads config missing access token or ad account ID');
    const account = normaliseAdAccountId(adAccountId);

    const info = await this.graph(`/${account}`, { fields: 'name,currency,timezone_name' }, accessToken);
    const currency = String(info.currency ?? 'USD').toUpperCase();
    const { since, until } = dateRange(info.timezone_name);

    // Campaign level so the tool can show where the spend went; summed for the total.
    const byCampaign = new Map<string, { name: string; spend: number }>();
    let url: string | null = this.url(`/${account}/insights`, {
      fields: 'campaign_id,campaign_name,spend',
      level: 'campaign',
      time_range: JSON.stringify({ since, until }),
      limit: '200',
    });
    while (url) {
      const page = await this.get(url, accessToken);
      for (const row of page.data ?? []) {
        const id = String(row.campaign_id ?? 'unknown');
        const prev = byCampaign.get(id);
        byCampaign.set(id, { name: row.campaign_name ?? id, spend: (prev?.spend ?? 0) + (Number(row.spend) || 0) });
      }
      url = page.paging?.next ?? null;
    }

    const rate = await this.toUsdRate(currency);
    const byProject = [...byCampaign.entries()]
      .map(([projectId, c]) => ({ projectId, projectName: c.name, amountUSD: c.spend * rate }))
      .filter((p) => p.amountUSD > 0)
      .sort((a, b) => b.amountUSD - a.amountUSD);
    return { amountUSD: byProject.reduce((s, p) => s + p.amountUSD, 0), byProject };
  }

  /** Multiplier from the ad account's billing currency to USD (1 for USD accounts). */
  private async toUsdRate(currency: string): Promise<number> {
    if (currency === 'USD') return 1;
    const resp = await fetchWithTimeout(`${FX_URL}?from=${encodeURIComponent(currency)}&to=USD`, {}, 'The currency-rate service');
    const json = (await resp.json().catch(() => null)) as any;
    const rate = json?.rates?.USD;
    if (!resp.ok || typeof rate !== 'number') throw new Error(`Could not convert Meta Ads spend from ${currency} to USD.`);
    return rate;
  }

  private url(path: string, params: Record<string, string>): string {
    return `${GRAPH}${path}?${new URLSearchParams(params).toString()}`;
  }

  private graph(path: string, params: Record<string, string>, token: string) {
    return this.get(this.url(path, params), token);
  }

  // Token goes in the Authorization header, not the query string, so it never
  // ends up in a logged URL.
  private async get(url: string, token: string): Promise<any> {
    const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token.trim()}` } }, 'Meta');
    const json = (await resp.json().catch(() => null)) as any;
    if (!resp.ok || json?.error) throw new Error(metaErrorMessage(json?.error ?? {}, resp.status));
    return json;
  }
}
