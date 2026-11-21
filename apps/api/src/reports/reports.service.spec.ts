import { ReportsService, subscriptionCountsForMonth, trendBuckets } from './reports.service';

describe('ReportsService', () => {
  let prisma: any;
  let service: ReportsService;

  beforeEach(() => {
    prisma = {
      tool: { findMany: jest.fn().mockResolvedValue([]) },
      billingRecord: { aggregate: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new ReportsService(prisma);
  });

  describe('periodSpendByTool', () => {
    it('this_month: keys by toolId, using live pro-rated spend, skipping NOBUDGET tools', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't1', paymentKind: 'PREPAID', billingCycle: 'MONTHLY', usedAmount: 15, monthlyAmount: 0, createdAt: new Date('2020-01-01'), deletedAt: null },
        { id: 't2', paymentKind: 'MOSUB', billingCycle: 'YEARLY', usedAmount: 0, monthlyAmount: 120, createdAt: new Date('2020-01-01'), deletedAt: null }, // -> 10/mo
        { id: 't3', paymentKind: 'NOBUDGET', billingCycle: 'MONTHLY', usedAmount: 0, monthlyAmount: 0, createdAt: new Date('2020-01-01'), deletedAt: null },
      ]);

      const result = await service.periodSpendByTool('org1', 'this_month');
      expect(result).toEqual({ t1: 15, t2: 10 });
    });

    it('last_month: sums closed billing records per toolId for the prior monthKey', async () => {
      prisma.billingRecord.findMany.mockResolvedValue([
        { toolId: 't1', amount: 20 },
        { toolId: 't2', amount: 5 },
      ]);

      const result = await service.periodSpendByTool('org1', 'last_month');
      expect(result).toEqual({ t1: 20, t2: 5 });
      expect(prisma.billingRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ orgId: 'org1' }) }),
      );
    });

    it('last_month: falls back to a MOSUB tool\'s flat rate when the roll-forward cron has not logged that month yet (regression: showed $0 for an active subscription instead of its monthly fee)', async () => {
      prisma.billingRecord.findMany.mockResolvedValue([]); // cron hasn't closed this month out yet
      prisma.tool.findMany.mockImplementation(({ where }: any) =>
        where.paymentKind === 'MOSUB'
          ? [{ id: 't1', paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 10, usedAmount: 0, createdAt: new Date('2020-01-01'), deletedAt: null }]
          : [],
      );

      const result = await service.periodSpendByTool('org1', 'last_month');
      expect(result).toEqual({ t1: 10 });
    });

    it('last_month: does NOT fall back for PREPAID/CAPSUB - current usedAmount is a live figure, not what was actually used in a past closed month', async () => {
      prisma.billingRecord.findMany.mockResolvedValue([]);
      prisma.tool.findMany.mockImplementation(({ where }: any) =>
        where.paymentKind === 'MOSUB' ? [] : [{ id: 't1', paymentKind: 'PREPAID', billingCycle: 'MONTHLY', monthlyAmount: 0, usedAmount: 15, createdAt: new Date('2020-01-01'), deletedAt: null }],
      );

      const result = await service.periodSpendByTool('org1', 'last_month');
      expect(result).toEqual({});
    });

    it('last_month: queries MOSUB fallback candidates with createdAt before the start of the following month, so a tool created after that month is excluded server-side', async () => {
      prisma.billingRecord.findMany.mockResolvedValue([]);
      const now = new Date();
      const startOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); // UTC, same basis as month keys

      await service.periodSpendByTool('org1', 'last_month');

      expect(prisma.tool.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ paymentKind: 'MOSUB', createdAt: { lt: startOfThisMonth } }),
        }),
      );
    });

    it('this_month: a tool with a closed current-month record contributes ONLY that record, not the record plus its live figure too (regression: was double-counted - $8 closed + $15 live showed as $23 instead of $8)', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't1', paymentKind: 'PREPAID', billingCycle: 'MONTHLY', usedAmount: 15, monthlyAmount: 0, createdAt: new Date('2020-01-01'), deletedAt: null },
        { id: 't2', paymentKind: 'MOSUB', billingCycle: 'MONTHLY', usedAmount: 0, monthlyAmount: 20, createdAt: new Date('2020-01-01'), deletedAt: null }, // no closed record - still uses its live figure
      ]);
      prisma.billingRecord.findMany.mockResolvedValue([{ toolId: 't1', amount: 8 }]);

      const result = await service.periodSpendByTool('org1', 'this_month');

      expect(result).toEqual({ t1: 8, t2: 20 });
    });

    it('always sums to the same total as periodSpend, for every period (regression: table rows must sum to the KPI card)', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't1', paymentKind: 'PREPAID', billingCycle: 'MONTHLY', usedAmount: 15, monthlyAmount: 0, createdAt: new Date('2020-01-01'), deletedAt: null },
      ]);
      prisma.billingRecord.findMany.mockResolvedValue([{ toolId: 't1', amount: 8 }]);
      prisma.billingRecord.aggregate.mockImplementation(({ where }: any) => {
        // Same synthetic per-month data behind both the aggregate (periodSpend)
        // and findMany (periodSpendByTool) code paths, so the two must agree.
        if (where.monthKey === undefined) return { _sum: { amount: 0 } };
        return { _sum: { amount: 8 } };
      });

      for (const period of ['this_month', 'last_month', 'this_quarter', 'year_to_date'] as const) {
        const { total } = await service.periodSpend('org1', period);
        const byTool = await service.periodSpendByTool('org1', period);
        const sum = Object.values(byTool).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(total, 6);
      }
    });
  });

  describe('billingHistory', () => {
    function monthsAgo(n: number): string {
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    it('backfills a MOSUB tool\'s flat rate for a past month with no billing record yet (regression: the month vanished entirely from Reports/Billing History instead of showing the tool\'s monthly fee)', async () => {
      prisma.tool.findMany.mockImplementation(({ where }: any) =>
        where.paymentKind === 'MOSUB'
          ? [{
            id: 't1', name: 'Namecheap', category: 'OTHER', monoInitials: 'NC', monoBgColor: '#000',
            paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 10, usedAmount: 0,
            renewalDate: null, createdAt: new Date(monthsAgo(6)),
          }]
          : [],
      );

      const { items } = await service.billingHistory('org1', {});
      const backfilled = items.find((r: any) => r.toolId === 't1' && r.monthKey === monthsAgo(1));
      expect(backfilled?.amount).toBe(10);
      expect(backfilled?.status).toBe('PAID'); // auto-renewing subscription in a closed month - not awaiting payment
    });

    it('does not duplicate a month that already has a real billing record', async () => {
      prisma.billingRecord.findMany.mockResolvedValue([
        {
          id: 'r1', toolId: 't1', monthKey: monthsAgo(1), monthLabel: 'x', amount: 10, status: 'PAID',
          tool: { name: 'Namecheap', monoInitials: 'NC', monoBgColor: '#000', category: 'OTHER', billingCycle: 'MONTHLY', renewalDate: null },
          toolSnapshotJson: null,
        },
      ]);
      prisma.tool.findMany.mockImplementation(({ where }: any) =>
        where.paymentKind === 'MOSUB'
          ? [{
            id: 't1', name: 'Namecheap', category: 'OTHER', monoInitials: 'NC', monoBgColor: '#000',
            paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 10, usedAmount: 0,
            renewalDate: null, createdAt: new Date(monthsAgo(6)),
          }]
          : [],
      );

      const { items } = await service.billingHistory('org1', {});
      const rowsForMonth = items.filter((r: any) => r.toolId === 't1' && r.monthKey === monthsAgo(1));
      expect(rowsForMonth).toHaveLength(1);
      expect(rowsForMonth[0].status).toBe('PAID'); // the real record, not a synthesized one
    });

    it('does not backfill months before the tool existed', async () => {
      prisma.tool.findMany.mockImplementation(({ where }: any) =>
        where.paymentKind === 'MOSUB'
          ? [{
            id: 't1', name: 'New Tool', category: 'OTHER', monoInitials: 'NT', monoBgColor: '#000',
            paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 10, usedAmount: 0,
            renewalDate: null, createdAt: new Date(), // created this month
          }]
          : [],
      );

      const { items } = await service.billingHistory('org1', {});
      expect(items.filter((r: any) => r.toolId === 't1')).toHaveLength(0);
    });
  });

  describe('deleted subscriptions agree across every report', () => {
    const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

    it('subscriptionCountsForMonth: counts months from creation up to and including the month it was deleted', () => {
      const t = { createdAt: new Date('2026-03-10T00:00:00Z'), deletedAt: new Date('2026-06-20T00:00:00Z') };
      expect(subscriptionCountsForMonth(t, '2026-02')).toBe(false); // not created yet
      expect(subscriptionCountsForMonth(t, '2026-03')).toBe(true);
      expect(subscriptionCountsForMonth(t, '2026-06')).toBe(true);  // deleted part-way through: still paid that month
      expect(subscriptionCountsForMonth(t, '2026-07')).toBe(false); // gone
      expect(subscriptionCountsForMonth({ ...t, deletedAt: null }, '2030-01')).toBe(true);
    });

    it('Billing History (which feeds Spend Analysis and the Excel export) and the Dashboard give the same total for last month', async () => {
      const deletedThisMonth = new Date(); // a subscription deleted this month was still active last month
      const tools = [
        { id: 'kept', name: 'Kept', category: 'SAAS', monoInitials: 'K', monoBgColor: null, paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 10, usedAmount: 0, renewalDate: null, createdAt: new Date('2020-01-01'), deletedAt: null },
        { id: 'gone', name: 'Gone', category: 'SAAS', monoInitials: 'G', monoBgColor: null, paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 25, usedAmount: 0, renewalDate: null, createdAt: new Date('2020-01-01'), deletedAt: deletedThisMonth },
      ];
      prisma.tool.findMany.mockImplementation(({ where }: any) => (where.paymentKind === 'MOSUB' ? tools : []));

      const history = await service.billingHistory('org1', { monthKey: lastMonth(), limit: 100 });
      const historyTotal = history.items.reduce((sum: number, r: any) => sum + r.amount, 0);
      const dashboard = await service.periodSpend('org1', 'last_month');

      expect(history.items.map((r: any) => r.toolId).sort()).toEqual(['gone', 'kept']);
      expect(historyTotal).toBe(35);
      expect(dashboard.total).toBe(historyTotal);
    });
  });

  describe('trendBuckets', () => {
    it('month: last N months ending with the current one, oldest first', () => {
      expect(trendBuckets('2026-02', 'month', 3).map((b) => [b.key, b.label, b.monthKeys])).toEqual([
        ['2025-12', 'Dec 2025', ['2025-12']],
        ['2026-01', 'Jan 2026', ['2026-01']],
        ['2026-02', 'Feb 2026', ['2026-02']],
      ]);
    });

    it('quarter: the current quarter only includes months up to now (never future months)', () => {
      expect(trendBuckets('2026-11', 'quarter', 2).map((b) => [b.key, b.monthKeys])).toEqual([
        ['2026-Q3', ['2026-07', '2026-08', '2026-09']],
        ['2026-Q4', ['2026-10', '2026-11']],
      ]);
    });

    it('year: calendar years, the current one partial', () => {
      const buckets = trendBuckets('2026-03', 'year', 2);
      expect(buckets.map((b) => b.key)).toEqual(['2025', '2026']);
      expect(buckets[0].monthKeys).toHaveLength(12);
      expect(buckets[1].monthKeys).toEqual(['2026-01', '2026-02', '2026-03']);
    });
  });

  describe('spendTrend', () => {
    it('sums per-tool spend into buckets (closed records for past months, live for the current one) and lists tools by total', async () => {
      const lastMonth = trendBuckets(new Date().toISOString().slice(0, 7), 'month', 2)[0].key;
      prisma.billingRecord.findMany.mockResolvedValue([
        { toolId: 't1', amount: 20, monthKey: lastMonth },
        { toolId: 't2', amount: 5, monthKey: lastMonth },
      ]);
      prisma.tool.findMany.mockImplementation(({ where }: any) => {
        if (where.id) return [{ id: 't1', name: 'AWS', monoBgColor: '#f90' }, { id: 't2', name: 'GitHub', monoBgColor: '#333' }];
        if (where.paymentKind === 'MOSUB') return [];
        return [{ id: 't2', paymentKind: 'PREPAID', billingCycle: 'MONTHLY', usedAmount: 7, monthlyAmount: 0, createdAt: new Date('2020-01-01'), deletedAt: null }];
      });

      const trend = await service.spendTrend('org1', 'month', 2);
      expect(trend.points.map((p) => p.byTool)).toEqual([{ t1: 20, t2: 5 }, { t2: 7 }]);
      expect(trend.points.map((p) => p.total)).toEqual([25, 7]);
      expect(trend.tools).toEqual([
        { id: 't1', name: 'AWS', color: '#f90', total: 20 },
        { id: 't2', name: 'GitHub', color: '#333', total: 12 },
      ]);
    });

    it('makes the same handful of queries however many months it covers (was ~2 per month, one after another)', async () => {
      await service.spendTrend('org1', 'year', 5); // up to 60 months
      expect(prisma.billingRecord.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.tool.findMany.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('keeps a since-deleted subscription in the months it was active, but not after it was deleted', async () => {
      const months = trendBuckets(new Date().toISOString().slice(0, 7), 'month', 4).map((b) => b.key);
      const [y, m] = months[2].split('-').map(Number);
      const deletedAt = new Date(y, m - 1, 15); // deleted mid-way through the 3rd month
      prisma.tool.findMany.mockImplementation(({ where }: any) => {
        if (where.id) return [{ id: 'sub', name: 'Old SaaS', monoBgColor: null }];
        if (where.paymentKind === 'MOSUB') {
          return [{ id: 'sub', paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 10, usedAmount: 0, createdAt: new Date(2020, 0, 1), deletedAt }];
        }
        return []; // current-month live figures only cover non-deleted tools
      });

      const trend = await service.spendTrend('org1', 'month', 4);
      expect(trend.points.map((p) => p.byTool.sub ?? 0)).toEqual([10, 10, 10, 0]);
      expect(trend.tools[0]).toEqual(expect.objectContaining({ name: 'Old SaaS', total: 30 }));
      expect(prisma.tool.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ OR: [{ deletedAt: null }, { deletedAt: { gte: expect.any(Date) } }] }),
      }));
    });

    it('clamps the bucket count to a sane range', async () => {
      expect((await service.spendTrend('org1', 'year', 99)).points).toHaveLength(5);
      expect((await service.spendTrend('org1', 'quarter', 0)).points).toHaveLength(1);
    });
  });
});
