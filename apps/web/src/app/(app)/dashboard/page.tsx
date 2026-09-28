'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Banknote, CalendarDays, Clock, IndianRupee, ListOrdered, PackageX, Receipt, Star, TrendingUp, Users, Wallet } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Button, Card, CardHeader, EmptyState, LoadingBlock, PageHeader, StatCard, StatusBadge, Table, Tabs, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { ago, fmtDate, fmtTime, money, num, titleCase } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { PAYMENT_METHOD_LABEL } from '@/lib/billing';

interface Overview {
  today: { billed: number; invoices: number; collected: number; sessionsCompleted: number; sessionsRunning: number; appointments: number; upcoming: number; noShows: number };
  month: { billed: number; net: number; invoices: number; collected: number; change: number | null; newCustomers: number; newCustomersChange: number | null; avgBill: number };
  outstanding: { amount: number; invoices: number };
  rating: { avg: number | null; count: number };
  trend: { day: string; billed: number; invoices: number }[];
  topServices: { name: string; qty: number; revenue: number }[];
  branches: { id: string; name: string; billed: number; invoices: number }[];
  alerts: { lowStock: { product: string; branch: string; quantity: number; reorderLevel: number; unit: string }[]; lowStockCount: number; expiringPackages: number };
}
interface FrontDesk {
  appointments: { total: number; byStatus: Record<string, number> };
  waiting: number;
  collectedToday: number;
  upcoming: { id: string; startTime: string; status: string; customer: { id: string; name: string }; service: string; therapist: string | null }[];
  running: { id: string; status: string; startedAt: string | null; customer: string; service: string; durationMinutes: number; therapist: string; room: string | null }[];
  unbilled: { id: string; completedAt: string; customer: { id: string; name: string }; service: string; therapist: string }[];
  unpaid: { id: string; invoiceNumber: string; customer: string | null; issuedAt: string | null; due: number }[];
}
interface TherapistDash {
  today: { completed: number; sessions: { id: string; status: string; startedAt: string | null; completedAt: string | null; customer: string; service: string; durationMinutes: number; room: string | null }[] };
  month: { sessions: number; commission: number };
  rating: { avg: number | null; count: number };
  recentFeedback: { rating: number; comment: string | null; createdAt: string }[];
  upcoming: { id: string; startTime: string; status: string; customer: string; service: string }[];
}
interface Accounts {
  today: { collected: number; byMethod: { method: string; amount: number; count: number }[] };
  month: {
    billed: number;
    net: number;
    collected: number;
    byMethod: { method: string; amount: number; count: number }[];
    refunds: { amount: number; count: number };
    expenses: { total: number; byCategory: { category: string; amount: number }[] };
    cashSurplus: number;
  };
  outstanding: { amount: number; invoices: number };
  aging: { bucket: string; due: number; invoices: number }[];
}

type View = 'overview' | 'front' | 'accounts' | 'therapist';
const VIEW_LABEL: Record<View, string> = { overview: 'Business overview', front: 'Front desk', accounts: 'Accounts', therapist: 'My performance' };

export default function DashboardPage() {
  const user = useAuth((s) => s.user);
  const P = PERMISSIONS;
  const canOverview = hasPermission(user, P.REPORTS_READ);
  const canFront = hasPermission(user, [P.APPOINTMENT_READ, P.QUEUE_READ, P.POS_USE]);
  const canAccounts = hasPermission(user, P.REPORTS_FINANCIAL);
  const isTherapist = !!user?.therapistId;
  const views = ([canOverview && 'overview', canFront && 'front', canAccounts && 'accounts', isTherapist && 'therapist'].filter(Boolean) as View[]);
  const preferred: View | undefined =
    isTherapist && !canOverview ? 'therapist' : canAccounts && !hasPermission(user, P.APPOINTMENT_READ) ? 'accounts' : canOverview ? 'overview' : views[0];
  const [chosen, setChosen] = useState<View | null>(null);
  const view = chosen && views.includes(chosen) ? chosen : preferred;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="space-y-5">
      <PageHeader title={`${greeting}, ${user?.name?.split(' ')[0] ?? ''}`} description={`${user?.tenantName ?? ''} · ${fmtDate(new Date(), 'EEEE, dd MMMM yyyy')}`} />
      {views.length > 1 && <Tabs tabs={views.map((v) => ({ value: v, label: VIEW_LABEL[v] }))} value={view!} onChange={setChosen} />}
      {!view && <Card><EmptyState title="Nothing to show yet" description="Your role does not include any dashboard. Use the menu to get to your work." /></Card>}
      {view === 'overview' && <OverviewView />}
      {view === 'front' && <FrontDeskView />}
      {view === 'accounts' && <AccountsView />}
      {view === 'therapist' && <TherapistView />}
    </div>
  );
}

function useDash<T>(path: string, key: string, withBranch = true) {
  const branchId = useBranch((s) => s.branchId);
  return useQuery({
    queryKey: ['dashboard', key, withBranch ? branchId : null],
    queryFn: () => api.get<T>(path, withBranch ? { branchId: branchId ?? undefined } : undefined),
    refetchInterval: 60_000,
  });
}

function Failed({ error }: { error: unknown }) {
  return <Card><EmptyState title="Dashboard could not be loaded" description={errorMessage(error)} /></Card>;
}

// ---------- owner / manager ----------

function OverviewView() {
  const { data, isLoading, error } = useDash<Overview>('/dashboard/overview', 'overview');
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <Failed error={error} />;
  const trend = data.trend.map((t) => ({ ...t, label: fmtDate(t.day, 'dd MMM') }));
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Billed today" value={money(data.today.billed)} hint={`${data.today.invoices} invoices · ${money(data.today.collected)} collected`} icon={<IndianRupee className="h-4 w-4" />} />
        <StatCard label="This month" value={money(data.month.billed)} trend={data.month.change} hint="vs same days last month" icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard label="Outstanding" value={money(data.outstanding.amount)} hint={`${data.outstanding.invoices} unpaid invoices`} icon={<Receipt className="h-4 w-4" />} />
        <StatCard label="New customers" value={num(data.month.newCustomers)} trend={data.month.newCustomersChange} hint="this month" icon={<Users className="h-4 w-4" />} />
        <StatCard label="Sessions today" value={num(data.today.sessionsCompleted)} hint={`${data.today.sessionsRunning} running now`} />
        <StatCard label="Appointments today" value={num(data.today.appointments)} hint={`${data.today.upcoming} still to come${data.today.noShows ? ` · ${data.today.noShows} no-show` : ''}`} icon={<CalendarDays className="h-4 w-4" />} />
        <StatCard label="Average bill" value={money(data.month.avgBill)} hint={`${data.month.invoices} bills this month`} />
        <StatCard label="Customer rating" value={data.rating.avg ? `${data.rating.avg.toFixed(1)} / 5` : '-'} hint={`${data.rating.count} reviews in 30 days`} icon={<Star className="h-4 w-4" />} />
      </div>
      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Billing, last 30 days" actions={<Link href="/reports?report=sales" className="text-xs font-medium text-brand-700 hover:underline">Sales report</Link>} />
          <div className="h-64 px-2 pb-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="billed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0d9488" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#0d9488" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={20} />
                <YAxis tick={{ fontSize: 11 }} width={64} tickFormatter={(v) => money(v, undefined, true)} />
                <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(l) => String(l)} />
                <Area type="monotone" dataKey="billed" name="Billed" stroke="#0d9488" strokeWidth={2} fill="url(#billed)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardHeader title="Needs attention" />
          <div className="space-y-3 px-5 pb-5">
            {data.alerts.lowStockCount === 0 && data.alerts.expiringPackages === 0 && data.outstanding.invoices === 0 && <p className="text-sm text-slate-500">All clear. Nothing needs attention right now.</p>}
            {data.alerts.lowStockCount > 0 && (
              <Link href="/inventory" className="block rounded-lg border border-amber-200 bg-amber-50 p-3 hover:bg-amber-100">
                <p className="flex items-center gap-2 text-sm font-medium text-amber-900"><AlertTriangle className="h-4 w-4" /> {data.alerts.lowStockCount} products low on stock</p>
                <ul className="mt-1 space-y-0.5 text-xs text-amber-800">
                  {data.alerts.lowStock.slice(0, 4).map((s, i) => <li key={i}>{s.product} at {s.branch}: {num(s.quantity, 3)} {s.unit} (reorder at {num(s.reorderLevel, 3)})</li>)}
                </ul>
              </Link>
            )}
            {data.alerts.expiringPackages > 0 && (
              <Link href="/packages" className="flex items-center gap-2 rounded-lg border border-slate-200 p-3 text-sm hover:bg-slate-50">
                <PackageX className="h-4 w-4 text-slate-500" /> {data.alerts.expiringPackages} packages expire in the next 14 days
              </Link>
            )}
            {data.outstanding.invoices > 0 && (
              <Link href="/invoices?status=UNPAID" className="flex items-center gap-2 rounded-lg border border-slate-200 p-3 text-sm hover:bg-slate-50">
                <Receipt className="h-4 w-4 text-slate-500" /> {data.outstanding.invoices} invoices awaiting {money(data.outstanding.amount)}
              </Link>
            )}
          </div>
        </Card>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Top services this month" actions={<Link href="/reports?report=services" className="text-xs font-medium text-brand-700 hover:underline">Services report</Link>} />
          {data.topServices.length === 0 ? (
            <EmptyState title="No services billed yet this month" />
          ) : (
            <Table>
              <THead><TR><TH>Service</TH><TH className="text-right">Sold</TH><TH className="text-right">Revenue</TH></TR></THead>
              <TBody>
                {data.topServices.map((s) => (
                  <TR key={s.name}><TD>{s.name}</TD><TD className="text-right tabular-nums">{s.qty}</TD><TD className="text-right tabular-nums">{money(s.revenue)}</TD></TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
        {data.branches.length > 1 && (
          <Card>
            <CardHeader title="Branches this month" />
            <div className="h-56 px-2 pb-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.branches} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => money(v, undefined, true)} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={140} />
                  <Tooltip formatter={(v) => money(Number(v))} />
                  <Bar dataKey="billed" name="Billed" fill="#6366f1" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------- reception ----------

function FrontDeskView() {
  const router = useRouter();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const [billing, setBilling] = useState<string | null>(null);
  const { data, isLoading, error } = useDash<FrontDesk>('/dashboard/front-desk', 'front');
  useRealtime(['sessions.changed', 'queue.updated', 'appointments.changed'], () => qc.invalidateQueries({ queryKey: ['dashboard', 'front'] }));
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <Failed error={error} />;
  const canBill = hasPermission(user, PERMISSIONS.POS_USE);
  const bill = async (sessionId: string) => {
    setBilling(sessionId);
    try {
      const cart = await api.post<{ id: string }>('/invoices/from-session', { sessionId });
      router.push(`/pos?cart=${cart.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBilling(null);
    }
  };
  const done = data.appointments.byStatus.COMPLETED ?? 0;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Appointments today" value={num(data.appointments.total)} hint={`${done} completed${data.appointments.byStatus.NO_SHOW ? ` · ${data.appointments.byStatus.NO_SHOW} no-show` : ''}`} icon={<CalendarDays className="h-4 w-4" />} />
        <StatCard label="Waiting in queue" value={num(data.waiting)} hint={<Link href="/queue" className="text-brand-700 hover:underline">Open queue</Link>} icon={<ListOrdered className="h-4 w-4" />} />
        <StatCard label="Sessions running" value={num(data.running.length)} hint={<Link href="/sessions" className="text-brand-700 hover:underline">View sessions</Link>} icon={<Clock className="h-4 w-4" />} />
        <StatCard label="Collected today" value={money(data.collectedToday)} icon={<Banknote className="h-4 w-4" />} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Coming up (next 2 hours)" actions={<Link href="/appointments" className="text-xs font-medium text-brand-700 hover:underline">Calendar</Link>} />
          {data.upcoming.length === 0 ? (
            <EmptyState title="No appointments in the next two hours" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.upcoming.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="w-16 text-sm font-semibold tabular-nums text-slate-900">{fmtTime(a.startTime)}</span>
                  <span className="flex-1">
                    <Link href={`/customers/${a.customer.id}`} className="text-sm font-medium text-slate-900 hover:underline">{a.customer.name}</Link>
                    <span className="block text-xs text-slate-500">{a.service}{a.therapist ? ` with ${a.therapist}` : ''}</span>
                  </span>
                  <StatusBadge status={a.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="In the rooms" />
          {data.running.length === 0 ? (
            <EmptyState title="No sessions running" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.running.map((s) => {
                const mins = s.startedAt ? Math.max(0, Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000)) : 0;
                const over = mins > s.durationMinutes;
                return (
                  <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="flex-1">
                      <span className="text-sm font-medium text-slate-900">{s.customer}</span>
                      <span className="block text-xs text-slate-500">{s.service} · {s.therapist}{s.room ? ` · ${s.room}` : ''}</span>
                    </span>
                    {s.status === 'PAUSED' ? <Badge tone="amber">Paused</Badge> : <span className={`text-sm tabular-nums ${over ? 'font-medium text-rose-600' : 'text-slate-600'}`}>{mins}/{s.durationMinutes} min</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Completed but not billed" description="Sessions from the last 3 days without an invoice" />
          {data.unbilled.length === 0 ? (
            <EmptyState title="Every completed session is billed" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.unbilled.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="flex-1">
                    <span className="text-sm font-medium text-slate-900">{s.customer.name}</span>
                    <span className="block text-xs text-slate-500">{s.service} with {s.therapist} · {ago(s.completedAt)}</span>
                  </span>
                  {canBill && <Button size="sm" loading={billing === s.id} onClick={() => bill(s.id)}>Bill <ArrowRight className="h-3.5 w-3.5" /></Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Unpaid invoices" actions={<Link href="/invoices?status=UNPAID" className="text-xs font-medium text-brand-700 hover:underline">All unpaid</Link>} />
          {data.unpaid.length === 0 ? (
            <EmptyState title="No unpaid invoices" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.unpaid.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="flex-1">
                    <Link href={`/invoices/${i.id}`} className="text-sm font-medium text-brand-700 hover:underline">{i.invoiceNumber}</Link>
                    <span className="block text-xs text-slate-500">{i.customer ?? 'Walk-in'} · {ago(i.issuedAt)}</span>
                  </span>
                  <span className="text-sm font-medium tabular-nums text-rose-600">{money(i.due)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------- accountant ----------

function AccountsView() {
  const { data, isLoading, error } = useDash<Accounts>('/dashboard/accounts', 'accounts');
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <Failed error={error} />;
  const methodLabel = (m: string) => PAYMENT_METHOD_LABEL[m] ?? titleCase(m);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Collected today" value={money(data.today.collected)} hint={data.today.byMethod.map((m) => `${methodLabel(m.method)} ${money(m.amount, undefined, true)}`).join(' · ') || 'No payments yet'} icon={<Banknote className="h-4 w-4" />} />
        <StatCard label="Collected this month" value={money(data.month.collected)} hint={`${money(data.month.billed)} billed`} icon={<IndianRupee className="h-4 w-4" />} />
        <StatCard label="Receivables" value={money(data.outstanding.amount)} hint={`${data.outstanding.invoices} unpaid invoices`} icon={<Receipt className="h-4 w-4" />} />
        <StatCard label="Spent this month" value={money(data.month.expenses.total)} hint={data.month.refunds.amount ? `+ ${money(data.month.refunds.amount)} refunded` : undefined} icon={<Wallet className="h-4 w-4" />} />
      </div>
      <Card className={`p-4 ${data.month.cashSurplus >= 0 ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
        <p className="text-sm text-slate-700">
          Net cash this month (collections − expenses − refunds): <span className={`font-semibold ${data.month.cashSurplus >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{money(data.month.cashSurplus)}</span>
          <Link href="/reports?report=pnl" className="ml-3 text-xs font-medium text-brand-700 hover:underline">Open profit & loss</Link>
        </p>
      </Card>
      <div className="grid gap-5 xl:grid-cols-3">
        <Card>
          <CardHeader title="Collections by method (month)" />
          {data.month.byMethod.length === 0 ? (
            <EmptyState title="No collections yet" />
          ) : (
            <Table>
              <THead><TR><TH>Method</TH><TH className="text-right">Payments</TH><TH className="text-right">Amount</TH></TR></THead>
              <TBody>
                {data.month.byMethod.map((m) => (
                  <TR key={m.method}><TD>{methodLabel(m.method)}</TD><TD className="text-right tabular-nums">{m.count}</TD><TD className="text-right tabular-nums">{money(m.amount)}</TD></TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="Receivables ageing" />
          <div className="h-56 px-2 pb-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.aging} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={60} tickFormatter={(v) => money(v, undefined, true)} />
                <Tooltip formatter={(v) => money(Number(v))} />
                <Bar dataKey="due" name="Due" fill="#e11d48" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardHeader title="Expenses by category (month)" actions={<Link href="/expenses" className="text-xs font-medium text-brand-700 hover:underline">Expenses</Link>} />
          {data.month.expenses.byCategory.length === 0 ? (
            <EmptyState title="No expenses this month" />
          ) : (
            <ul className="space-y-2 px-5 pb-5">
              {data.month.expenses.byCategory.map((c) => (
                <li key={c.category}>
                  <div className="flex justify-between text-sm"><span>{titleCase(c.category)}</span><span className="tabular-nums">{money(c.amount)}</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-brand-500" style={{ width: `${Math.round((c.amount / Math.max(1, data.month.expenses.total)) * 100)}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------- therapist ----------

function TherapistView() {
  const { data, isLoading, error } = useDash<TherapistDash>('/dashboard/therapist', 'therapist', false);
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <Failed error={error} />;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Completed today" value={num(data.today.completed)} hint={`${data.upcoming.length} more booked today`} />
        <StatCard label="Sessions this month" value={num(data.month.sessions)} />
        <StatCard label="Commission this month" value={money(data.month.commission)} icon={<IndianRupee className="h-4 w-4" />} />
        <StatCard label="My rating" value={data.rating.avg ? `${data.rating.avg.toFixed(1)} / 5` : '-'} hint={`${data.rating.count} reviews in 90 days`} icon={<Star className="h-4 w-4" />} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Today" actions={<Link href="/today" className="text-xs font-medium text-brand-700 hover:underline">Open My Day</Link>} />
          {data.today.sessions.length === 0 && data.upcoming.length === 0 ? (
            <EmptyState title="Nothing scheduled yet today" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.upcoming.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="w-16 text-sm font-semibold tabular-nums">{fmtTime(a.startTime)}</span>
                  <span className="flex-1 text-sm">{a.customer}<span className="block text-xs text-slate-500">{a.service}</span></span>
                  <StatusBadge status={a.status} />
                </li>
              ))}
              {data.today.sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="w-16 text-sm tabular-nums text-slate-500">{s.startedAt ? fmtTime(s.startedAt) : '-'}</span>
                  <span className="flex-1 text-sm">{s.customer}<span className="block text-xs text-slate-500">{s.service}{s.room ? ` · ${s.room}` : ''}</span></span>
                  <StatusBadge status={s.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="What customers said" />
          {data.recentFeedback.length === 0 ? (
            <EmptyState title="No written feedback yet" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentFeedback.map((f, i) => (
                <li key={i} className="px-5 py-3">
                  <p className="text-sm text-amber-500">{'★'.repeat(f.rating)}<span className="text-slate-200">{'★'.repeat(5 - f.rating)}</span></p>
                  <p className="mt-0.5 text-sm text-slate-700">{f.comment}</p>
                  <p className="text-xs text-slate-400">{ago(f.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
