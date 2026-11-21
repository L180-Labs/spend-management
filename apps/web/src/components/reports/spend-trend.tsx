'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '@/lib/api';

export type TrendGranularity = 'month' | 'quarter' | 'year';

export interface SpendTrendResponse {
  granularity: TrendGranularity;
  points: { key: string; label: string; byTool: Record<string, number>; total: number }[];
  tools: { id: string; name: string; color: string | null; total: number }[];
}

export interface TrendSeries { id: string; name: string; color: string; total: number }

// Fixed categorical order (see --series-* in globals.css). Never cycled: past
// 8 series the smallest tools fold into "Other".
const SERIES_COLORS = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const MAX_SERIES = SERIES_COLORS.length;
export const OTHER_ID = '__other__';

const GRANULARITIES: { value: TrendGranularity; label: string; sub: string }[] = [
  { value: 'month', label: 'Monthly', sub: 'last 12 months' },
  { value: 'quarter', label: 'Quarterly', sub: 'last 8 quarters' },
  { value: 'year', label: 'Yearly', sub: 'last 3 years' },
];

/**
 * Turns the API response into chart rows + series. Colors follow the tool (its
 * rank in the response's by-total order), and tools beyond the 7th fold into a
 * single "Other" line so no color is ever reused.
 */
export function buildTrendSeries(data: SpendTrendResponse): { series: TrendSeries[]; rows: Record<string, number | string>[] } {
  const fold = data.tools.length > MAX_SERIES;
  const kept = fold ? data.tools.slice(0, MAX_SERIES - 1) : data.tools;
  const folded = fold ? data.tools.slice(MAX_SERIES - 1) : [];

  const series: TrendSeries[] = kept.map((t, i) => ({ id: t.id, name: t.name, color: SERIES_COLORS[i], total: t.total }));
  if (fold) {
    series.push({
      id: OTHER_ID,
      name: `Other (${folded.length})`,
      color: SERIES_COLORS[MAX_SERIES - 1],
      total: folded.reduce((s, t) => s + t.total, 0),
    });
  }

  const rows = data.points.map((p) => {
    const row: Record<string, number | string> = { label: p.label, total: p.total };
    for (const t of kept) row[t.id] = round2(p.byTool[t.id] ?? 0);
    if (fold) row[OTHER_ID] = round2(folded.reduce((s, t) => s + (p.byTool[t.id] ?? 0), 0));
    return row;
  });
  return { series, rows };
}

// Keeps the tool names in view while the period columns scroll sideways.
const STICKY: React.CSSProperties = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--c-0e1014)' };

function round2(n: number) { return Math.round(n * 100) / 100; }

export function SpendTrend({ fmtAmt }: { fmtAmt: (n: number) => string }) {
  const [granularity, setGranularity] = useState<TrendGranularity>('month');
  const [data, setData] = useState<SpendTrendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const tableScroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.get<SpendTrendResponse>(`/reports/spend-trend?granularity=${granularity}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load spend trend'); });
    return () => { cancelled = true; };
  }, [granularity]);

  // Only show a response that matches the selected grouping - right after a
  // switch, the previous grouping's data is still in state until the new one
  // arrives, and must not render under the new heading.
  const current = data?.granularity === granularity ? data : null;
  const { series, rows } = useMemo(() => (current ? buildTrendSeries(current) : { series: [], rows: [] }), [current]);
  const visible = series.filter((s) => !hidden.has(s.id));
  const hasSpend = series.some((s) => s.total > 0);

  // The newest periods sit on the right; open the table scrolled there.
  useEffect(() => {
    const el = tableScroll.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [rows]);

  function toggle(id: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ background: 'var(--c-0e1014)', border: '1px solid var(--c-1a1d24)', borderRadius: 14, padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 650, color: 'var(--c-e6e8ec)', margin: '0 0 4px' }}>Tool spend over time</h3>
            <p style={{ fontSize: 12, color: 'var(--c-767b86)', margin: 0 }}>
              Spend per tool, {GRANULARITIES.find((g) => g.value === granularity)?.sub}. The current period is in progress.
            </p>
          </div>
          <div role="tablist" aria-label="Group spend by" style={{ display: 'flex', gap: 4, background: 'var(--c-121419)', border: '1px solid var(--c-1e212a)', borderRadius: 10, padding: 3 }}>
            {GRANULARITIES.map((g) => (
              <button key={g.value} role="tab" aria-selected={granularity === g.value} onClick={() => setGranularity(g.value)}
                style={{
                  padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  background: granularity === g.value ? 'var(--c-1e212a)' : 'transparent',
                  color: granularity === g.value ? 'var(--c-f2f3f5)' : 'var(--c-878c96)',
                }}>
                {g.label}
              </button>
            ))}
          </div>
        </div>

        {/* Legend: always shown for 2+ series; click to hide/show a tool */}
        {series.length > 1 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginBottom: 14 }}>
            {series.map((s) => {
              const off = hidden.has(s.id);
              return (
                <button key={s.id} onClick={() => toggle(s.id)} aria-pressed={!off} title={off ? `Show ${s.name}` : `Hide ${s.name}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', opacity: off ? 0.4 : 1, fontSize: 12, color: 'var(--c-cfd3da)' }}>
                  <span style={{ width: 14, height: 3, borderRadius: 2, background: s.color, display: 'inline-block' }} />
                  {s.name}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ height: 300 }}>
          {error ? (
            <Empty>{error}</Empty>
          ) : !current ? (
            <Empty>Loading…</Empty>
          ) : !hasSpend ? (
            <Empty>No spend recorded in this range yet.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke="var(--c-1e212a)" />
                <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: 'var(--c-1e212a)' }} tick={{ fontSize: 11, fill: 'var(--c-878c96)' }} interval="preserveStartEnd" minTickGap={12} />
                <YAxis tickLine={false} axisLine={false} width={72} tick={{ fontSize: 11, fill: 'var(--c-878c96)' }} tickFormatter={(v: number) => fmtAmt(v)} />
                <Tooltip
                  cursor={{ stroke: 'var(--c-4a4f59)', strokeWidth: 1 }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const items = [...payload].filter((p) => Number(p.value) > 0).sort((a, b) => Number(b.value) - Number(a.value));
                    const total = items.reduce((s, p) => s + Number(p.value), 0);
                    return (
                      <div style={{ background: 'var(--c-101218)', border: '1px solid var(--c-1e212a)', borderRadius: 10, padding: '10px 12px', fontSize: 12, minWidth: 180, boxShadow: '0 8px 24px rgba(0,0,0,.25)' }}>
                        <div style={{ fontWeight: 650, color: 'var(--c-f2f3f5)', marginBottom: 6 }}>{label}</div>
                        {items.length === 0 && <div style={{ color: 'var(--c-767b86)' }}>No spend</div>}
                        {items.map((p) => (
                          <div key={String(p.dataKey)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                            <span style={{ width: 8, height: 8, borderRadius: 999, background: p.color, flexShrink: 0 }} />
                            <span style={{ color: 'var(--c-cfd3da)', flex: 1 }}>{p.name}</span>
                            <span style={{ color: 'var(--c-f2f3f5)', fontVariantNumeric: 'tabular-nums' }}>{fmtAmt(Number(p.value))}</span>
                          </div>
                        ))}
                        {items.length > 1 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--c-1e212a)', marginTop: 6, paddingTop: 6, color: 'var(--c-878c96)' }}>
                            <span>Total</span><span style={{ color: 'var(--c-f2f3f5)', fontVariantNumeric: 'tabular-nums' }}>{fmtAmt(total)}</span>
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                {visible.map((s) => (
                  <Line key={s.id} type="linear" dataKey={s.id} name={s.name} stroke={s.color} strokeWidth={2}
                    dot={{ r: 3, strokeWidth: 0, fill: s.color }} activeDot={{ r: 5, stroke: 'var(--c-0e1014)', strokeWidth: 2 }} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Table view: the exact numbers behind the chart */}
      {current && hasSpend && (
        <div style={{ background: 'var(--c-0e1014)', border: '1px solid var(--c-1a1d24)', borderRadius: 14, padding: '18px 0 6px', overflowX: 'auto' }} ref={tableScroll}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr style={{ color: 'var(--c-767b86)', textAlign: 'right' }}>
                <th style={{ ...STICKY, textAlign: 'left', padding: '0 24px 10px', fontWeight: 600 }}>Tool</th>
                {rows.map((r) => <th key={String(r.label)} style={{ padding: '0 12px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>{r.label}</th>)}
                <th style={{ padding: '0 24px 10px', fontWeight: 600 }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <tr key={s.id} style={{ borderTop: '1px solid var(--c-1a1d24)', textAlign: 'right', color: 'var(--c-cfd3da)' }}>
                  <td style={{ ...STICKY, textAlign: 'left', padding: '9px 24px', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: s.color, marginRight: 8 }} />
                    {s.name}
                  </td>
                  {rows.map((r) => <td key={String(r.label)} style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{Number(r[s.id]) ? fmtAmt(Number(r[s.id])) : '–'}</td>)}
                  <td style={{ padding: '9px 24px', fontWeight: 650, color: 'var(--c-f2f3f5)', whiteSpace: 'nowrap' }}>{fmtAmt(s.total)}</td>
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid var(--c-1e212a)', textAlign: 'right', color: 'var(--c-f2f3f5)', fontWeight: 650 }}>
                <td style={{ ...STICKY, textAlign: 'left', padding: '9px 24px' }}>Total</td>
                {rows.map((r) => <td key={String(r.label)} style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{fmtAmt(Number(r.total))}</td>)}
                <td style={{ padding: '9px 24px', whiteSpace: 'nowrap' }}>{fmtAmt(series.reduce((s, x) => s + x.total, 0))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--c-5e636e)' }}>{children}</div>;
}
