const ceSend = jest.fn();
const budgetsSend = jest.fn();
const stsSend = jest.fn();

jest.mock('@aws-sdk/client-cost-explorer', () => ({
  CostExplorerClient: jest.fn(() => ({ send: ceSend })),
  GetCostAndUsageCommand: jest.fn((input) => ({ input })),
}));
jest.mock('@aws-sdk/client-budgets', () => ({
  BudgetsClient: jest.fn(() => ({ send: budgetsSend })),
  DescribeBudgetsCommand: jest.fn((input) => ({ input })),
}));
jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn(() => ({ send: stsSend })),
  GetCallerIdentityCommand: jest.fn((input) => ({ input })),
}));

import { AWSProvider, costExplorerPeriod, EXCLUDE_CREDITS_AND_REFUNDS, isAccountWideBudget } from './aws.provider';

const config = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' };

function group(service: string, amount: string) {
  return { Keys: [service], Metrics: { UnblendedCost: { Amount: amount, Unit: 'USD' } } };
}

describe('AWSProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sums month-to-date cost per service across pages, largest first', async () => {
    ceSend
      .mockResolvedValueOnce({ ResultsByTime: [{ Groups: [group('Amazon EC2', '12.5'), group('Tax', '0.001')] }], NextPageToken: 'p2' })
      .mockResolvedValueOnce({ ResultsByTime: [{ Groups: [group('Amazon S3', '20'), group('Amazon EC2', '1.5')] }] });

    const result = await new AWSProvider().fetchSpendUSD(config);
    expect(result.amountUSD).toBe(34);
    expect(result.breakdown?.map((b) => [b.measurement, b.amountUSD])).toEqual([['Amazon S3', 20], ['Amazon EC2', 14]]);
    expect(ceSend.mock.calls[1][0].input.NextPageToken).toBe('p2');
  });

  it('floors a free-tier net (credits slightly exceeding usage) at $0 instead of a negative total', async () => {
    ceSend.mockResolvedValueOnce({ ResultsByTime: [{ Groups: [group('EC2 - Other', '0.0352047808'), group('AWS Data Transfer', '-0.0353603801')] }] });

    const result = await new AWSProvider().fetchSpendUSD(config);
    expect(result.amountUSD).toBe(0);
    expect(result.breakdown).toHaveLength(2); // the line items themselves are still shown
  });

  it('maps an access-denied error to the missing IAM permission', async () => {
    ceSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(new AWSProvider().fetchSpendUSD(config)).rejects.toThrow('ce:GetCostAndUsage');
  });

  it('reads the monthly USD cost budget as the cap, and returns null (never throws) when budgets are unreadable', async () => {
    stsSend.mockResolvedValue({ Account: '111122223333' });
    budgetsSend.mockResolvedValueOnce({ Budgets: [
      { BudgetType: 'USAGE', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '5', Unit: 'GB' } },
      { BudgetName: 'Monthly', BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '200', Unit: 'USD' } },
    ] });
    expect(await new AWSProvider().fetchLimitsUSD(config)).toEqual({ computeHardLimitUSD: 200, computeSoftLimitUSD: 160, budgetName: 'Monthly' });

    budgetsSend.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await new AWSProvider().fetchLimitsUSD(config)).toBeNull();
  });

  it('excludes credits and refunds, so an account running on AWS credits still shows what its usage cost', async () => {
    ceSend.mockResolvedValueOnce({ ResultsByTime: [{ Groups: [group('Amazon EC2', '40')] }] });
    await new AWSProvider().fetchSpendUSD(config);
    expect(ceSend.mock.calls[0][0].input.Filter).toEqual(EXCLUDE_CREDITS_AND_REFUNDS);
    expect(EXCLUDE_CREDITS_AND_REFUNDS.Not.Dimensions).toEqual({ Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] });
  });

  it('counts sub-cent services in the total even though the breakdown hides them', async () => {
    const tiny = Array.from({ length: 10 }, (_, i) => group(`Service ${i}`, '0.004'));
    ceSend.mockResolvedValueOnce({ ResultsByTime: [{ Groups: [group('Amazon S3', '1'), ...tiny] }] });

    const result = await new AWSProvider().fetchSpendUSD(config);
    expect(result.amountUSD).toBe(1.04);
    expect(result.breakdown).toHaveLength(1);
  });

  it('only uses an account-wide budget as the cap, never one filtered to a single service', async () => {
    stsSend.mockResolvedValue({ Account: '111122223333' });
    budgetsSend.mockResolvedValueOnce({ Budgets: [
      { BudgetName: 'EC2 only', BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '50', Unit: 'USD' }, CostFilters: { Service: ['Amazon Elastic Compute Cloud - Compute'] } },
      { BudgetName: 'Tagged', BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '75', Unit: 'USD' }, FilterExpression: { Tags: { Key: 'team', Values: ['x'] } } },
      { BudgetName: 'Whole account', BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '500', Unit: 'USD' }, CostFilters: {} },
    ] });
    expect(await new AWSProvider().fetchLimitsUSD(config)).toEqual(expect.objectContaining({ computeHardLimitUSD: 500, budgetName: 'Whole account' }));

    budgetsSend.mockResolvedValueOnce({ Budgets: [
      { BudgetName: 'EC2 only', BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '50', Unit: 'USD' }, CostFilters: { Service: ['EC2'] } },
    ] });
    expect(await new AWSProvider().fetchLimitsUSD(config)).toBeNull(); // falls back to a manual cap
  });

  it('isAccountWideBudget ignores empty filter lists', () => {
    expect(isAccountWideBudget({})).toBe(true);
    expect(isAccountWideBudget({ CostFilters: { Service: [] } })).toBe(true);
    expect(isAccountWideBudget({ CostFilters: { Service: ['EC2'] } })).toBe(false);
  });

  it('asks the scheduler to sync only every 6 hours ($0.01 per Cost Explorer call)', () => {
    expect(new AWSProvider().minSyncIntervalMinutes).toBe(360);
  });

  it('Cost Explorer periods use an exclusive end date', () => {
    expect(costExplorerPeriod(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T15:00:00Z'))).toEqual({ Start: '2026-11-01', End: '2026-11-02' });
    expect(costExplorerPeriod(new Date('2026-12-01Z'), new Date('2026-12-31Z'))).toEqual({ Start: '2026-12-01', End: '2027-01-01' });
  });
});
