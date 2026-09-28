'use client';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Download, FileSpreadsheet, FileText, Lock } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button, Card, CardHeader, EmptyState, Input, LoadingBlock, PageHeader, Select, StatCard, Table, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { fmtDate, money, num } from '@/lib/format';

type ColumnType = 'text' | 'number' | 'money' | 'percent' | 'date';
interface Report {
  key: string;
  title: string;
  from: string;
  to: string;
  metrics: { key: string; label: string; value: number; type?: ColumnType; hint?: string }[];
  series?: { title: string; lines: { key: string; label: string; type?: ColumnType }[]; points: Record<string, string | number>[] };
  tables: { key: string; title: string; columns: { key: string; label: string; type?: ColumnType }[]; rows: Record<string, string | number | null>[] }[];
}
interface ReportInfo {
  key: string;
  title: string;
  financial: boolean;
}

const COLORS = ['#0d9488', '#6366f1', '#f59e0b', '#e11d48', '#0ea5e9', '#84cc16'];
const DESCRIPTIONS: Record<string, string> = {
  sales: 'Billing, collections, tax and payment mix',
  services: 'What was performed and what it earned',
  therapists: 'Sessions, hours, revenue, commission and ratings',
  customers: 'New, returning and top-spending customers',
  appointments: 'Bookings, completion, cancellations and no-shows',
  packages: 'Package and membership sales and usage',
  offers: 'Discounts given through offers, coupons and memberships',
  inventory: 'Stock value, purchases, consumption and retail margin',
  expenses: 'Running costs by category and branch',
  pnl: 'Revenue, cost of goods, expenses and profit',
};

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function preset(p: string): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (p) {
    case 'today':
      return { from: iso(now), to: iso(now) };
    case 'last-month':
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case '30d':
      return { from: iso(new Date(y, m, now.getDate() - 29)), to: iso(now) };
    case '90d':
      return { from: iso(new Date(y, m, now.getDate() - 89)), to: iso(now) };
    case 'year':
      return { from: iso(new Date(m >= 3 ? y : y - 1, 3, 1)), to: iso(now) };
    default:
      return { from: iso(new Date(y, m, 1)), to: iso(now) };
  }
}

function fmt(v: unknown, type?: ColumnType) {
  if (v === null || v === undefined || v === '') return '-';
  switch (type) {
    case 'money':
      return money(Number(v));
    case 'percent':
      return `${num(Number(v), 1)}%`;
    case 'number':
      return num(Number(v), 2);
    case 'date':
      return fmtDate(String(v));
    default:
      return String(v);
  }
}

function periodLabel(p: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(p) ? fmtDate(p, 'dd MMM') : /^\d{4}-\d{2}$/.test(p) ? fmtDate(`${p}-01`, 'MMM yyyy') : p;
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <Reports />
    </Suspense>
  );
}

function Reports() {
  const router = useRouter();
  const params = useSearchParams();
  const user = useAuth((s) => s.user);
  const canExport = hasPermission(user, PERMISSIONS.REPORTS_EXPORT);
  const branchId = useBranch((s) => s.branchId);
  const key = params.get('report') ?? 'sales';
  const [range, setRange] = useState({ preset: 'month', ...preset('month') });
  const [groupBy, setGroupBy] = useState<'day' | 'week' | 'month'>('day');
  const [exporting, setExporting] = useState<string | null>(null);

  const { data: catalogue } = useQuery({ queryKey: ['reports-catalogue'], queryFn: () => api.get<ReportInfo[]>('/reports'), staleTime: 300_000 });
  const query = { from: range.from, to: range.to, groupBy, branchId: branchId ?? undefined };
  const valid = !!range.from && !!range.to && range.from <= range.to;
  const { data: report, isLoading, error } = useQuery({
    queryKey: ['report', key, query],
    queryFn: () => api.get<Report>(`/reports/${key}`, query),
    enabled: valid,
  });
  const info = catalogue?.find((r) => r.key === key);

  const choose = (k: string) => router.replace(`/reports?report=${k}`);
  const setPreset = (p: string) => {
    const r = preset(p);
    setRange({ preset: p, ...r });
    setGroupBy(p === 'year' ? 'month' : p === '90d' ? 'week' : 'day');
  };
  const exportAs = async (format: 'csv' | 'xlsx' | 'pdf', table?: string) => {
    setExporting(format + (table ?? ''));
    try {
      await downloadFile(`/reports/${key}/export`, { ...query, format, table });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        description="Pick a report, a period and a branch from the top bar. Exports match what you see."
        actions={
          canExport && report && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" loading={exporting === 'csv'} onClick={() => exportAs('csv')}><Download className="h-3.5 w-3.5" /> CSV</Button>
              <Button variant="outline" size="sm" loading={exporting === 'xlsx'} onClick={() => exportAs('xlsx')}><FileSpreadsheet className="h-3.5 w-3.5" /> Excel</Button>
              <Button variant="outline" size="sm" loading={exporting === 'pdf'} onClick={() => exportAs('pdf')}><FileText className="h-3.5 w-3.5" /> PDF</Button>
            </div>
          )
        }
      />
      <div className="grid gap-5 lg:grid-cols-[15rem_1fr]">
        <Card className="h-fit p-2">
          <nav aria-label="Reports" className="space-y-0.5">
            {(catalogue ?? []).map((r) => (
              <button
                key={r.key}
                onClick={() => choose(r.key)}
                className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors cursor-pointer ${r.key === key ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-50'}`}
              >
                <span className="flex-1">
                  <span className="font-medium">{r.title}</span>
                  <span className="block text-xs text-slate-500">{DESCRIPTIONS[r.key]}</span>
                </span>
                {r.financial && <Lock className="mt-0.5 h-3 w-3 text-slate-400" aria-label="Financial report" />}
              </button>
            ))}
          </nav>
        </Card>

        <div className="min-w-0 space-y-5">
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select className="w-44" value={range.preset} onChange={(e) => (e.target.value === 'custom' ? setRange((r) => ({ ...r, preset: 'custom' })) : setPreset(e.target.value))} aria-label="Period">
                <option value="today">Today</option>
                <option value="month">This month</option>
                <option value="last-month">Last month</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
                <option value="year">This financial year</option>
                <option value="custom">Custom range</option>
              </Select>
              <Input type="date" className="w-40" value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, preset: 'custom', from: e.target.value }))} aria-label="From date" />
              <span className="text-slate-400">to</span>
              <Input type="date" className="w-40" value={range.to} min={range.from} onChange={(e) => setRange((r) => ({ ...r, preset: 'custom', to: e.target.value }))} aria-label="To date" />
              <Select className="w-36" value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)} aria-label="Group by">
                <option value="day">By day</option>
                <option value="week">By week</option>
                <option value="month">By month</option>
              </Select>
            </div>
          </Card>

          {!valid ? (
            <Card><EmptyState title="Choose a valid date range" description="The start date must be on or before the end date." /></Card>
          ) : isLoading ? (
            <Card><LoadingBlock /></Card>
          ) : error ? (
            <Card><EmptyState title="This report could not be loaded" description={errorMessage(error)} /></Card>
          ) : report ? (
            <ReportView report={report} title={info?.title ?? report.title} canExport={canExport} exporting={exporting} onExportTable={(t) => exportAs('csv', t)} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ReportView({ report, title, canExport, exporting, onExportTable }: { report: Report; title: string; canExport: boolean; exporting: string | null; onExportTable: (table: string) => void }) {
  const series = report.series;
  const moneyAxis = series?.lines.every((l) => l.type === 'money');
  const points = useMemo(() => series?.points.map((p) => ({ ...p, label: periodLabel(String(p.period)) })) ?? [], [series]);
  return (
    <>
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <p className="text-sm text-slate-500">{fmtDate(report.from)} – {fmtDate(report.to)}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {report.metrics.map((m) => <StatCard key={m.key} label={m.label} value={fmt(m.value, m.type ?? 'number')} hint={m.hint} />)}
      </div>
      {series && points.length > 0 && (
        <Card>
          <CardHeader title={series.title} />
          <div className="h-72 px-2 pb-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={16} />
                <YAxis tick={{ fontSize: 11 }} width={moneyAxis ? 72 : 40} tickFormatter={(v) => (moneyAxis ? money(v, undefined, true) : num(v))} />
                <Tooltip formatter={(v, name) => { const line = series.lines.find((l) => l.label === name); return fmt(v, line?.type ?? 'number'); }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {series.lines.map((l, i) => <Line key={l.key} type="monotone" dataKey={l.key} name={l.label} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={points.length < 20} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
      {report.tables.map((t) => (
        <Card key={t.key}>
          <CardHeader
            title={t.title}
            description={`${t.rows.length} ${t.rows.length === 1 ? 'row' : 'rows'}`}
            actions={canExport && t.rows.length > 0 && <Button size="sm" variant="ghost" loading={exporting === `csv${t.key}`} onClick={() => onExportTable(t.key)}><Download className="h-3.5 w-3.5" /> CSV</Button>}
          />
          {t.rows.length === 0 ? (
            <EmptyState title="Nothing in this period" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    {t.columns.map((c) => <TH key={c.key} className={c.type && c.type !== 'text' && c.type !== 'date' ? 'text-right' : ''}>{c.label}</TH>)}
                  </TR>
                </THead>
                <TBody>
                  {t.rows.map((r, i) => (
                    <TR key={i}>
                      {t.columns.map((c) => (
                        <TD key={c.key} className={c.type && c.type !== 'text' && c.type !== 'date' ? 'text-right tabular-nums' : ''}>{fmt(r[c.key], c.type)}</TD>
                      ))}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      ))}
    </>
  );
}
