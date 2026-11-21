import { MetaAdsProvider, metaErrorMessage, normaliseAdAccountId, todayInTimeZone } from './meta-ads.provider';
import { fetchWithTimeout } from './http';

function mockFetch(responses: { status?: number; body: any }[]) {
  const fn = jest.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({ ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body });
  }
  global.fetch = fn as any;
  return fn;
}

const config = { accessToken: 'EAAtest', adAccountId: '12345' };

describe('MetaAdsProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sums campaign spend across pages for a USD account, never putting the token in the URL', async () => {
    const fetchMock = mockFetch([
      { body: { name: 'Acme Ads', currency: 'USD' } },
      { body: { data: [{ campaign_id: 'c1', campaign_name: 'Launch', spend: '10.50' }], paging: { next: 'https://graph.facebook.com/next-page' } } },
      { body: { data: [{ campaign_id: 'c2', campaign_name: 'Retarget', spend: '4.25' }] } },
    ]);

    const result = await new MetaAdsProvider().fetchSpendUSD(config);
    expect(result.amountUSD).toBeCloseTo(14.75);
    expect(result.byProject?.map((p) => p.projectName)).toEqual(['Launch', 'Retarget']);
    expect(fetchMock.mock.calls[1][0]).toContain('/act_12345/insights?');
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).not.toContain('EAAtest');
      expect(init.headers.Authorization).toBe('Bearer EAAtest');
    }
  });

  it('converts a non-USD account to USD', async () => {
    mockFetch([
      { body: { currency: 'INR' } },
      { body: { data: [{ campaign_id: 'c1', campaign_name: 'Diwali', spend: '1000' }] } },
      { body: { rates: { USD: 0.012 } } },
    ]);
    const result = await new MetaAdsProvider().fetchSpendUSD(config);
    expect(result.amountUSD).toBeCloseTo(12);
  });

  it('turns an expired-token error into an actionable message', async () => {
    mockFetch([{ status: 400, body: { error: { code: 190, message: 'Session has expired' } } }]);
    await expect(new MetaAdsProvider().fetchSpendUSD(config)).rejects.toThrow(/System User token/);
  });

  it("uses the ad account's own time zone for month-to-date dates", async () => {
    const fetchMock = mockFetch([
      { body: { currency: 'USD', timezone_name: 'Asia/Kolkata' } },
      { body: { data: [] } },
    ]);
    await new MetaAdsProvider().fetchSpendUSD(config);
    const range = JSON.parse(new URL(fetchMock.mock.calls[1][0]).searchParams.get('time_range')!);
    const today = todayInTimeZone('Asia/Kolkata');
    expect(range).toEqual({ since: `${today.slice(0, 7)}-01`, until: today });
    expect(fetchMock.mock.calls[0][0]).toContain('timezone_name');
  });

  it("todayInTimeZone crosses the month boundary in the account's zone, not UTC", () => {
    const lateOct31Utc = new Date('2026-10-31T20:00:00Z'); // already Nov 1 in India, still Oct 31 in LA
    expect(todayInTimeZone('Asia/Kolkata', lateOct31Utc)).toBe('2026-11-01');
    expect(todayInTimeZone('America/Los_Angeles', lateOct31Utc)).toBe('2026-10-31');
    expect(todayInTimeZone('Not/AZone', lateOct31Utc)).toBe('2026-10-31'); // unknown zone -> UTC
  });

  it("only blames the ad account ID when Meta says the object doesn't exist", () => {
    expect(metaErrorMessage({ code: 100, error_subcode: 33, message: 'Unsupported get request' }, 400)).toMatch(/could not find that ad account/);
    const other = metaErrorMessage({ code: 100, message: '(#100) time_range must be a valid range' }, 400);
    expect(other).toBe('Meta rejected the request: (#100) time_range must be a valid range');
    expect(other).not.toMatch(/find/);
  });

  it('gives up on a hung request with a readable timeout error', async () => {
    global.fetch = jest.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    })) as any;
    await expect(fetchWithTimeout('https://graph.facebook.com/x', {}, 'Meta', 20)).rejects.toThrow('Meta did not respond within 0 seconds');
  });

  it('normalises ad account IDs with or without the act_ prefix', () => {
    expect(normaliseAdAccountId('123')).toBe('act_123');
    expect(normaliseAdAccountId(' act_123 ')).toBe('act_123');
  });
});
