'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { format, startOfMonth, startOfQuarter, subDays } from 'date-fns';
import Link from 'next/link';
import { Bot, CalendarClock, IndianRupee, Repeat, TrendingDown, TrendingUp, Users } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { FeatureFlagKey } from '@therapyos/types';
import { Button, Card, CardContent, CardHeader, EmptyState, Input, LoadingBlock, PageHeader, StatCard } from '@therapyos/ui';
import { api } from '@/lib/api';
import { hasFeature, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { money, titleCase } from '@/lib/format';

interface Kpis {
  revenue: number;
  invoices: number;
  avgBill: number;
  customers: number;
  returningRate: number;
  newCustomers: number;
  sessions: number;
  avgSessionMinutes: number;
  appointments: number;
  noShowRate: number;
  cancellationRate: number;
}
interface Analytics {
  range: { from: string; to: string; previousFrom: string; previousTo: string; days: number };
  current: Kpis;
  previous: Kpis;
  trend: { date: string; revenue: number; previous: number }[];
  cohorts: { month: string; label: string; size: number; retention: number[] }[];
  services: { id: string; name: string; revenue: number; qty: number; share: number; change: number | null }[];
  therapists: { id: string; name: string; sessions: number; customers: number; avgMinutes: number; revenue: number; rating: number | null }[];
  acquisition: { source: string; customers: number; converted: number; conversionRate: number; revenue: number }[];
  payments: { method: string; amount: number; count: number; share: number }[];
  heatmap: { days: string[]; hours: number[]; values: number[][] } | null;
}

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const PRESETS = [
  { key: '30d', label: 'Last 30 days', range: () => [iso(subDays(new Date(), 29)), iso(new Date())] },
  { key: '90d', label: 'Last 90 days', range: () => [iso(subDays(new Date(), 89)), iso(new Date())] },
  { key: 'mtd', label: 'This month', range: () => [iso(startOfMonth(new Date())), iso(new Date())] },
  { key: 'qtd', label: 'This quarter', range: () => [iso(startOfQuarter(new Date())), iso(new Date())] },
] as const;
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

function Delta({ cur, prev, invert, suffix = '%' }: { cur: number; prev: number; invert?: boolean; suffix?: string }) {
  if (suffix === 'pts') {
    const d = Math.round((cur - prev) * 10) / 10;
    if (!d) return <span className="text-xs text-slate-400">no change</span>;
    const good = invert ? d < 0 : d > 0;
    return <span className={`text-xs font-medium ${good ? 'text-emerald-600' : 'text-rose-600'}`}>{d > 0 ? '+' : ''}{d} pts vs previous</span>;
  }
  if (!prev) return <span className="text-xs text-slate-400">{cur ? 'new this period' : 'no data'}</span>;
  const pct = Math.round(((cur - prev) / prev) * 1000) / 10;
  const good = invert ? pct < 0 : pct > 0;
  const Icon = pct >= 0 ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${pct === 0 ? 'text-slate-400' : good ? 'text-emerald-600' : 'text-rose-600'}`}>
      <Icon className="h-3 w-3" /> {Math.abs(pct)}% vs previous
    </span>
  );
}

function Bar({ value, tone = 'bg-brand-500' }: { value: number; tone?: string }) {
  return <div className="h-1.5 w-full rounded bg-slate-100"><div className={`h-1.5 rounded ${tone}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

export default function AnalyticsPage() {
  const user = useAuth((s) => s.user);
  const branchId = useBranch((s) => s.branchId);
  const [preset, setPreset] = useState<string>('30d');
  const [range, setRange] = useState<[string, string]>(() => PRESETS[0].range() as [string, string]);
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', range, branchId],
    queryFn: () => api.get<Analytics>('/analytics/overview', { from: range[0], to: range[1], branchId: branchId || undefined }),
    placeholderData: keepPreviousData,
  });
  const c = data?.current;
  const p = data?.previous;
  const heatMax = Math.max(1, ...(data?.heatmap?.values.flat() ?? [0]));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        description={data ? `${data.range.from} to ${data.range.to}, compared with ${data.range.previousFrom} to ${data.range.previousTo}. Net sales exclude tax.` : 'Trends, cohorts and performance across your business.'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
              {PRESETS.map((x) => (
                <button key={x.key} type="button" onClick={() => { setPreset(x.key); setRange(x.range() as [string, string]); }} className={`rounded-md px-2.5 py-1 text-xs font-medium ${preset === x.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>
                  {x.label}
                </button>
              ))}
            </div>
            <Input type="date" className="w-36" value={range[0]} max={range[1]} onChange={(e) => { setPreset(''); setRange([e.target.value, range[1]]); }} aria-label="From" />
            <Input type="date" className="w-36" value={range[1]} min={range[0]} onChange={(e) => { setPreset(''); setRange([range[0], e.target.value]); }} aria-label="To" />
            {hasFeature(user, FeatureFlagKey.AI_ASSISTANT) && <Link href="/assistant"><Button variant="outline" size="sm"><Bot className="h-4 w-4" /> Ask AI</Button></Link>}
          </div>
        }
      />
      {isLoading || !data || !c || !p ? <LoadingBlock /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="analytics-kpis">
            <StatCard label="Net sales" value={money(c.revenue)} hint={<Delta cur={c.revenue} prev={p.revenue} />} icon={<IndianRupee className="h-4 w-4" />} />
            <StatCard label="Average bill" value={money(c.avgBill)} hint={<Delta cur={c.avgBill} prev={p.avgBill} />} icon={<IndianRupee className="h-4 w-4" />} />
            <StatCard label="Returning customers" value={`${c.returningRate}%`} hint={<Delta cur={c.returningRate} prev={p.returningRate} suffix="pts" />} icon={<Repeat className="h-4 w-4" />} />
            <StatCard label="New customers" value={c.newCustomers} hint={<Delta cur={c.newCustomers} prev={p.newCustomers} />} icon={<Users className="h-4 w-4" />} />
            <StatCard label="Sessions delivered" value={c.sessions} hint={<Delta cur={c.sessions} prev={p.sessions} />} icon={<CalendarClock className="h-4 w-4" />} />
            <StatCard label="Avg session length" value={c.avgSessionMinutes ? `${Math.round(c.avgSessionMinutes)} min` : '—'} hint={`${c.invoices} bills from ${c.customers} customers`} />
            <StatCard label="No-show rate" value={`${c.noShowRate}%`} hint={<Delta cur={c.noShowRate} prev={p.noShowRate} invert suffix="pts" />} />
            <StatCard label="Cancellation rate" value={`${c.cancellationRate}%`} hint={<Delta cur={c.cancellationRate} prev={p.cancellationRate} invert suffix="pts" />} />
          </div>

          <Card>
            <CardHeader title="Daily net sales" description="Dashed line is the same day in the previous period" />
            <CardContent>
              <div className="h-72" data-testid="analytics-trend">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.trend} margin={{ left: 8, right: 8, top: 8 }}>
                    <defs>
                      <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0d9488" stopOpacity={0.3} /><stop offset="100%" stopColor="#0d9488" stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} fontSize={11} />
                    <YAxis fontSize={11} tickFormatter={(v: number) => money(v, undefined, true)} width={60} />
                    <Tooltip formatter={(v) => money(Number(v ?? 0))} />
                    <Legend />
                    <Area type="monotone" dataKey="revenue" name="This period" stroke="#0d9488" fill="url(#rev)" strokeWidth={2} />
                    <Line type="monotone" dataKey="previous" name="Previous period" stroke="#94a3b8" strokeDasharray="4 4" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Customer cohorts" description="Customers by month of first bill, and the share who bought again in each later month" />
              <div className="overflow-x-auto" data-testid="analytics-cohorts">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">First visit</th>
                      <th className="px-2 py-2 text-right font-medium">Customers</th>
                      {[1, 2, 3, 4, 5].map((k) => <th key={k} className="px-2 py-2 text-center font-medium">+{k} mo</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.cohorts.map((row) => (
                      <tr key={row.month}>
                        <td className="whitespace-nowrap px-3 py-1.5 font-medium text-slate-700">{row.label}</td>
                        <td className="px-2 py-1.5 text-right">{row.size}</td>
                        {[0, 1, 2, 3, 4].map((k) => (
                          <td key={k} className="px-1 py-1">
                            {k < row.retention.length ? (
                              <div className="relative rounded py-1 text-center text-xs font-medium text-slate-800">
                                <span className="absolute inset-0 rounded bg-brand-600" style={{ opacity: row.size ? 0.08 + (row.retention[k] / 100) * 0.8 : 0.04 }} />
                                <span className={`relative ${row.retention[k] > 55 ? 'text-white' : ''}`}>{row.size ? `${row.retention[k]}%` : '—'}</span>
                              </div>
                            ) : null}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card>
              <CardHeader title="Service mix" description="Share of service sales and change vs the previous period" />
              <CardContent className="space-y-2.5" data-testid="analytics-services">
                {data.services.length ? data.services.slice(0, 8).map((s) => (
                  <div key={s.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate font-medium text-slate-700">{s.name}</span>
                      <span className="whitespace-nowrap text-slate-600">
                        {money(s.revenue)} <span className="text-xs text-slate-400">· {s.qty} sold · {s.share}%</span>
                        {s.change !== null && <span className={`ml-1.5 text-xs font-medium ${s.change >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{s.change > 0 ? '+' : ''}{s.change}%</span>}
                      </span>
                    </div>
                    <Bar value={s.share} />
                  </div>
                )) : <EmptyState title="No services billed" description="Service sales in this period will appear here." />}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader title="Therapist performance" description="Completed sessions, attributed service sales and client ratings" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="analytics-therapists">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Therapist</th>
                    <th className="px-3 py-2 text-right font-medium">Sessions</th>
                    <th className="px-3 py-2 text-right font-medium">Clients</th>
                    <th className="px-3 py-2 text-right font-medium">Avg length</th>
                    <th className="px-3 py-2 text-right font-medium">Net sales</th>
                    <th className="px-3 py-2 text-right font-medium">Per session</th>
                    <th className="px-3 py-2 text-right font-medium">Rating</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.therapists.map((t) => (
                    <tr key={t.id}>
                      <td className="px-3 py-2 font-medium text-slate-800">{t.name}</td>
                      <td className="px-3 py-2 text-right">{t.sessions}</td>
                      <td className="px-3 py-2 text-right">{t.customers}</td>
                      <td className="px-3 py-2 text-right">{t.avgMinutes ? `${Math.round(t.avgMinutes)} min` : '—'}</td>
                      <td className="px-3 py-2 text-right">{money(t.revenue)}</td>
                      <td className="px-3 py-2 text-right">{t.sessions ? money(t.revenue / t.sessions) : '—'}</td>
                      <td className="px-3 py-2 text-right">{t.rating ? `${t.rating.toFixed(1)}★` : '—'}</td>
                    </tr>
                  ))}
                  {!data.therapists.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No sessions in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Acquisition channels" description="Customers added in this period, by source, and how many went on to buy" />
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="analytics-acquisition">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Source</th>
                      <th className="px-3 py-2 text-right font-medium">New</th>
                      <th className="px-3 py-2 text-right font-medium">Bought</th>
                      <th className="px-3 py-2 text-right font-medium">Conversion</th>
                      <th className="px-3 py-2 text-right font-medium">Net sales</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.acquisition.map((a) => (
                      <tr key={a.source}>
                        <td className="px-3 py-2 font-medium text-slate-700">{titleCase(a.source)}</td>
                        <td className="px-3 py-2 text-right">{a.customers}</td>
                        <td className="px-3 py-2 text-right">{a.converted}</td>
                        <td className="px-3 py-2 text-right">{a.conversionRate}%</td>
                        <td className="px-3 py-2 text-right">{money(a.revenue)}</td>
                      </tr>
                    ))}
                    {!data.acquisition.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">No new customers in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card>
              <CardHeader title="Payment mix" description="Collected amounts net of refunds" />
              <CardContent className="space-y-2.5" data-testid="analytics-payments">
                {data.payments.length ? data.payments.map((x) => (
                  <div key={x.method} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium text-slate-700">{titleCase(x.method)}</span>
                      <span className="text-slate-600">{money(x.amount)} <span className="text-xs text-slate-400">· {x.count} payments · {x.share}%</span></span>
                    </div>
                    <Bar value={x.share} tone="bg-indigo-500" />
                  </div>
                )) : <EmptyState title="No payments" description="Payments in this period will appear here." />}
              </CardContent>
            </Card>
          </div>

          {data.heatmap && (
            <Card>
              <CardHeader title="Demand by day and hour" description="Appointments and walk-in sessions started in each hour" />
              <CardContent className="overflow-x-auto" data-testid="analytics-heatmap">
                <div className="inline-grid gap-0.5 text-[10px]" style={{ gridTemplateColumns: `2.5rem repeat(${data.heatmap.hours.length}, minmax(1.8rem, 1fr))` }}>
                  <span />
                  {data.heatmap.hours.map((h) => <span key={h} className="text-center text-slate-400">{hourLabel(h)}</span>)}
                  {data.heatmap.days.map((d, i) => (
                    <Fragment key={d}>
                      <span className="pr-1 text-right leading-7 text-slate-500">{d}</span>
                      {data.heatmap!.values[i].map((v, j) => (
                        <span key={j} title={`${d} ${hourLabel(data.heatmap!.hours[j])}: ${v}`} className="relative h-7 rounded-sm bg-slate-100">
                          <span className="absolute inset-0 rounded-sm bg-brand-600" style={{ opacity: v ? 0.12 + (v / heatMax) * 0.88 : 0 }} />
                        </span>
                      ))}
                    </Fragment>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
