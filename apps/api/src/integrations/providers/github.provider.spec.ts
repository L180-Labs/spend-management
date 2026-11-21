import { GitHubProvider, monthsInRange } from './github.provider';

function mockFetch(responses: { status?: number; body: any }[]) {
  const fn = jest.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({ ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body });
  }
  global.fetch = fn as any;
  return fn;
}

const orgConfig = { token: 'ghp_test', accountType: 'org', accountName: 'acme' };

describe('GitHubProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sums netAmount for the current month, broken down by product and repository', async () => {
    const fetchMock = mockFetch([{ body: { usageItems: [
      { date: '2026-11-02', product: 'Actions', sku: 'Linux', quantity: 100, netAmount: 0.8, repositoryName: 'acme/api' },
      { date: '2026-11-03', product: 'Actions', sku: 'Linux', quantity: 50, netAmount: 0.4, repositoryName: 'acme/web' },
      { date: '2026-11-03', product: 'Copilot', sku: 'Business', quantity: 1, netAmount: 19 },
      { date: '2026-11-04', product: 'Packages', sku: 'Storage', quantity: 1, netAmount: 0 }, // within included quota
    ] } }]);

    const result = await new GitHubProvider().fetchSpendUSD(orgConfig);
    expect(result.amountUSD).toBeCloseTo(20.2);
    expect(result.breakdown?.map((b) => b.measurement)).toEqual(['Copilot', 'Actions']);
    expect(result.byProject?.map((p) => p.projectName)).toEqual(['acme/api', 'acme/web']);
    expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/api\.github\.com\/organizations\/acme\/settings\/billing\/usage\?year=\d{4}&month=\d{1,2}$/);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer ghp_test');
  });

  it('uses the /users endpoint for a personal account', async () => {
    const fetchMock = mockFetch([{ body: { usageItems: [] } }]);
    await new GitHubProvider().fetchSpendUSD({ ...orgConfig, accountType: 'user', accountName: 'octo' });
    expect(fetchMock.mock.calls[0][0]).toContain('/users/octo/settings/billing/usage');
  });

  it('history: queries each month in the range and keeps only items inside it', async () => {
    const fetchMock = mockFetch([
      { body: { usageItems: [{ date: '2026-09-29', product: 'Actions', netAmount: 5 }, { date: '2026-09-30', product: 'Actions', netAmount: 1 }] } },
      { body: { usageItems: [{ date: '2026-10-01', product: 'Actions', netAmount: 2 }, { date: '2026-10-02', product: 'Actions', netAmount: 7 }] } },
    ]);
    const result = await new GitHubProvider().fetchHistoricalSpendUSD(orgConfig, {
      startDate: new Date('2026-09-30T00:00:00Z'), endDate: new Date('2026-10-01T23:59:59Z'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.amountUSD).toBe(3);
  });

  it('explains a 403 in terms of the permission the token needs', async () => {
    mockFetch([{ status: 403, body: { message: 'Resource not accessible by personal access token' } }]);
    await expect(new GitHubProvider().fetchSpendUSD(orgConfig)).rejects.toThrow(/Administration/);
  });

  it('monthsInRange spans year boundaries', () => {
    expect(monthsInRange(new Date('2025-11-15Z'), new Date('2026-02-01Z'))).toEqual([[2025, 11], [2025, 12], [2026, 1], [2026, 2]]);
  });
});
