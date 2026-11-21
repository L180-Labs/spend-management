import { buildTrendSeries, OTHER_ID, SpendTrendResponse } from './spend-trend';

function response(toolCount: number): SpendTrendResponse {
  const tools = Array.from({ length: toolCount }, (_, i) => ({ id: `t${i + 1}`, name: `Tool ${i + 1}`, color: null, total: 100 - i }));
  return {
    granularity: 'month',
    points: [
      { key: '2026-10', label: 'Oct 2026', byTool: Object.fromEntries(tools.map((t) => [t.id, 1])), total: toolCount },
      { key: '2026-11', label: 'Nov 2026', byTool: { t1: 2.345 }, total: 2.345 },
    ],
    tools,
  };
}

describe('buildTrendSeries', () => {
  it('gives each tool its own fixed-order color and one row per period', () => {
    const { series, rows } = buildTrendSeries(response(3));
    expect(series.map((s) => s.color)).toEqual(['var(--series-1)', 'var(--series-2)', 'var(--series-3)']);
    expect(rows).toEqual([
      { label: 'Oct 2026', total: 3, t1: 1, t2: 1, t3: 1 },
      { label: 'Nov 2026', total: 2.345, t1: 2.35, t2: 0, t3: 0 },
    ]);
  });

  it('keeps exactly 8 tools as 8 lines without folding', () => {
    expect(buildTrendSeries(response(8)).series.map((s) => s.id)).not.toContain(OTHER_ID);
  });

  it('folds the smallest tools into a single "Other" line past 8, never reusing a color', () => {
    const { series, rows } = buildTrendSeries(response(10));
    expect(series).toHaveLength(8);
    expect(new Set(series.map((s) => s.color)).size).toBe(8);
    expect(series[7]).toMatchObject({ id: OTHER_ID, name: 'Other (3)', total: 93 + 92 + 91 });
    expect(rows[0][OTHER_ID]).toBe(3);
  });
});
