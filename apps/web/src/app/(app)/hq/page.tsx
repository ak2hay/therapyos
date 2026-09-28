'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { endOfMonth, format, startOfMonth, startOfQuarter, subDays, subMonths } from 'date-fns';
import { ArrowDown, ArrowUp, ArrowUpDown, Building2, IndianRupee, Star, TrendingDown, TrendingUp, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Card, CardContent, CardHeader, EmptyState, Input, LoadingBlock, PageHeader, StatCard } from '@therapyos/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/format';

interface BranchRow {
  branchId: string;
  name: string;
  code: string;
  city: string | null;
  franchisee: { id: string; name: string } | null;
  revenue: number;
  previousRevenue: number;
  revenueGrowth: number;
  billed: number;
  collected: number;
  invoices: number;
  avgBill: number;
  appointments: number;
  noShowRate: number;
  sessions: number;
  newCustomers: number;
  customers: number;
  rating: number | null;
  ratings: number;
  expenses: number;
  profit: number;
  margin: number;
  utilization: number;
}
interface Overview {
  from: string;
  to: string;
  previous: { from: string; to: string };
  totals: {
    revenue: number;
    collected: number;
    avgBill: number;
    sessions: number;
    newCustomers: number;
    profit: number;
    noShowRate: number;
    rating: number | null;
    revenueGrowth: number;
    sessionsGrowth: number;
    newCustomersGrowth: number;
    profitGrowth: number;
  } | null;
  branches: BranchRow[];
  trend: Array<Record<string, number | string>>;
}

const COLORS = ['#0d9488', '#6366f1', '#f59e0b', '#ec4899', '#10b981', '#8b5cf6', '#ef4444', '#0ea5e9'];
const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const PRESETS = [
  { key: 'mtd', label: 'This month', range: () => [iso(startOfMonth(new Date())), iso(new Date())] },
  { key: '30d', label: 'Last 30 days', range: () => [iso(subDays(new Date(), 29)), iso(new Date())] },
  { key: 'lm', label: 'Last month', range: () => [iso(startOfMonth(subMonths(new Date(), 1))), iso(endOfMonth(subMonths(new Date(), 1)))] },
  { key: 'qtd', label: 'This quarter', range: () => [iso(startOfQuarter(new Date())), iso(new Date())] },
] as const;

type SortKey = 'name' | 'revenue' | 'revenueGrowth' | 'avgBill' | 'sessions' | 'newCustomers' | 'noShowRate' | 'utilization' | 'rating' | 'profit' | 'margin';
const COLUMNS: { key: SortKey; label: string; fmt: (r: BranchRow) => React.ReactNode; hint?: string }[] = [
  { key: 'revenue', label: 'Net sales', fmt: (r) => money(r.revenue) },
  { key: 'revenueGrowth', label: 'vs prev.', fmt: (r) => <Growth value={r.revenueGrowth} /> },
  { key: 'avgBill', label: 'Avg bill', fmt: (r) => money(r.avgBill) },
  { key: 'sessions', label: 'Sessions', fmt: (r) => r.sessions },
  { key: 'newCustomers', label: 'New customers', fmt: (r) => r.newCustomers },
  { key: 'noShowRate', label: 'No-show', fmt: (r) => `${r.noShowRate}%` },
  { key: 'utilization', label: 'Utilisation', fmt: (r) => <Utilization value={r.utilization} />, hint: 'Session minutes as a share of therapist hours available' },
  { key: 'rating', label: 'Rating', fmt: (r) => (r.rating ? `${r.rating.toFixed(1)}★` : '—') },
  { key: 'profit', label: 'Profit', fmt: (r) => <span className={r.profit < 0 ? 'text-rose-600' : ''}>{money(r.profit)}</span>, hint: 'Net sales minus recorded expenses' },
  { key: 'margin', label: 'Margin', fmt: (r) => `${r.margin}%` },
];

function Growth({ value }: { value: number }) {
  if (!value) return <span className="text-slate-400">0%</span>;
  const up = value > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? 'text-emerald-600' : 'text-rose-600'}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {Math.abs(value)}%
    </span>
  );
}

function Utilization({ value }: { value: number }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-14 rounded bg-slate-100"><div className={`h-1.5 rounded ${value >= 60 ? 'bg-emerald-500' : value >= 30 ? 'bg-amber-500' : 'bg-rose-400'}`} style={{ width: `${Math.min(100, value)}%` }} /></div>
      <span className="w-9 text-right">{value}%</span>
    </div>
  );
}

export default function HqPage() {
  const [preset, setPreset] = useState<string>('mtd');
  const [range, setRange] = useState<[string, string]>(() => PRESETS[0].range() as [string, string]);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'revenue', dir: 'desc' });
  const { data, isLoading } = useQuery({
    queryKey: ['hq', range],
    queryFn: () => api.get<Overview>('/hq/overview', { from: range[0], to: range[1] }),
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => {
    const list = [...(data?.branches ?? [])];
    list.sort((a, b) => {
      const av = a[sort.key] ?? -Infinity;
      const bv = b[sort.key] ?? -Infinity;
      const cmp = typeof av === 'string' ? av.localeCompare(String(bv)) : Number(av) - Number(bv);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [data, sort]);
  const toggle = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));
  const t = data?.totals;
  const best = rows.length > 1 ? [...rows].sort((a, b) => b.revenue - a.revenue)[0] : null;
  const worstNoShow = rows.length > 1 ? [...rows].sort((a, b) => b.noShowRate - a.noShowRate)[0] : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="HQ Overview"
        description={data ? `Comparing ${data.branches.length} branches · ${data.from} to ${data.to} vs ${data.previous.from} to ${data.previous.to}` : 'Compare branch performance side by side.'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
              {PRESETS.map((p) => (
                <button key={p.key} type="button" onClick={() => { setPreset(p.key); setRange(p.range() as [string, string]); }} className={`rounded-md px-2.5 py-1 text-xs font-medium ${preset === p.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>
                  {p.label}
                </button>
              ))}
            </div>
            <Input type="date" className="w-36" value={range[0]} max={range[1]} onChange={(e) => { setPreset(''); setRange([e.target.value, range[1]]); }} aria-label="From" />
            <Input type="date" className="w-36" value={range[1]} min={range[0]} onChange={(e) => { setPreset(''); setRange([range[0], e.target.value]); }} aria-label="To" />
          </div>
        }
      />
      {isLoading || !data ? <LoadingBlock /> : !t ? (
        <Card><EmptyState icon={<Building2 className="h-6 w-6" />} title="No branches in your scope" description="Ask an owner to assign branches to you." /></Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Net sales" value={money(t.revenue)} hint={<Growth value={t.revenueGrowth} />} icon={<IndianRupee className="h-4 w-4" />} />
            <StatCard label="Profit (after expenses)" value={money(t.profit)} hint={<Growth value={t.profitGrowth} />} icon={<TrendingUp className="h-4 w-4" />} />
            <StatCard label="Sessions delivered" value={t.sessions} hint={<Growth value={t.sessionsGrowth} />} icon={<Users className="h-4 w-4" />} />
            <StatCard label="Average rating" value={t.rating ? `${t.rating.toFixed(2)}★` : '—'} hint={`No-show rate ${t.noShowRate}%`} icon={<Star className="h-4 w-4" />} />
          </div>
          {(best || worstNoShow) && (
            <div className="flex flex-wrap gap-2 text-sm">
              {best && <Badge tone="green">Top branch: {best.name} ({money(best.revenue)})</Badge>}
              {worstNoShow && worstNoShow.noShowRate > 0 && <Badge tone="amber">Highest no-shows: {worstNoShow.name} ({worstNoShow.noShowRate}%)</Badge>}
            </div>
          )}
          <Card>
            <CardHeader title="Daily net sales by branch" />
            <CardContent>
              <div className="h-72" data-testid="hq-trend">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.trend} margin={{ left: 8, right: 8, top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} fontSize={11} />
                    <YAxis fontSize={11} tickFormatter={(v: number) => money(v, undefined, true)} width={60} />
                    <Tooltip formatter={(v) => money(Number(v ?? 0))} />
                    <Legend />
                    {data.branches.map((b, i) => (
                      <Line key={b.branchId} type="monotone" dataKey={b.branchId} name={b.name} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Branch comparison" description="Click a column to sort" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="hq-table">
                <thead className="border-b border-slate-100 bg-slate-50/60 text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">
                      <button type="button" className="inline-flex items-center gap-1" onClick={() => toggle('name')}>Branch <SortIcon active={sort.key === 'name'} dir={sort.dir} /></button>
                    </th>
                    {COLUMNS.map((c) => (
                      <th key={c.key} className="whitespace-nowrap px-3 py-2 text-right font-medium" title={c.hint}>
                        <button type="button" className="inline-flex items-center gap-1" onClick={() => toggle(c.key)}>{c.label} <SortIcon active={sort.key === c.key} dir={sort.dir} /></button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.branchId} className="hover:bg-slate-50/50">
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-800">{r.name}</p>
                        <p className="text-xs text-slate-500">{r.code}{r.city ? ` · ${r.city}` : ''}{r.franchisee && <> · <span className="text-brand-700">Franchise: {r.franchisee.name}</span></>}</p>
                      </td>
                      {COLUMNS.map((c) => <td key={c.key} className="whitespace-nowrap px-3 py-2.5 text-right">{c.fmt(r)}</td>)}
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-slate-200 bg-slate-50/60 text-sm font-medium">
                  <tr>
                    <td className="px-3 py-2">All branches</td>
                    <td className="px-3 py-2 text-right">{money(t.revenue)}</td>
                    <td className="px-3 py-2 text-right"><Growth value={t.revenueGrowth} /></td>
                    <td className="px-3 py-2 text-right">{money(t.avgBill)}</td>
                    <td className="px-3 py-2 text-right">{t.sessions}</td>
                    <td className="px-3 py-2 text-right">{t.newCustomers}</td>
                    <td className="px-3 py-2 text-right">{t.noShowRate}%</td>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right">{t.rating ? `${t.rating.toFixed(1)}★` : '—'}</td>
                    <td className="px-3 py-2 text-right">{money(t.profit)}</td>
                    <td className="px-3 py-2 text-right">{t.revenue ? `${Math.round((t.profit / t.revenue) * 100)}%` : '—'}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
  return dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
}
