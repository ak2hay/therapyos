'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Building2, IndianRupee, LifeBuoy, TrendingDown, TrendingUp, Users } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Card, CardContent, CardHeader, LoadingBlock, PageHeader, StatCard, Table, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { api } from '@/lib/api';
import { money, titleCase } from '@/lib/format';

interface Metrics {
  tenants: { total: number; byStatus: Record<string, number>; newLast30Days: number };
  subscriptions: { byStatus: Record<string, number>; trialsEndingSoon: number };
  mrr: number;
  arr: number;
  arpa: number;
  churnRate: number;
  churnedLast30Days: number;
  collectedLast30Days: number;
  gmvLast30Days: number;
  openTickets: number;
  plans: { planId: string; code: string; name: string; tenants: number; paying: number; mrr: number }[];
  trend: { month: string; signups: number; revenue: number }[];
}

const TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'gray'> = { ACTIVE: 'green', TRIALING: 'blue', ONBOARDING: 'blue', PAST_DUE: 'amber', SUSPENDED: 'red', CANCELLED: 'gray', EXPIRED: 'gray' };

function StatusList({ title, counts, href }: { title: string; counts: Record<string, number>; href: (s: string) => string }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <Card>
      <CardHeader title={title} />
      <CardContent className="space-y-2">
        {entries.length ? entries.map(([s, n]) => (
          <Link key={s} href={href(s)} className="flex items-center justify-between rounded-md px-2 py-1 text-sm hover:bg-slate-50">
            <Badge tone={TONE[s] ?? 'gray'}>{titleCase(s)}</Badge>
            <span className="font-semibold">{n}</span>
          </Link>
        )) : <p className="text-sm text-slate-500">None yet.</p>}
      </CardContent>
    </Card>
  );
}

export default function AdminHome() {
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'metrics'], queryFn: () => api.get<Metrics>('/admin/metrics'), refetchInterval: 60_000 });
  if (isLoading || !data) return <LoadingBlock />;
  return (
    <div className="space-y-5">
      <PageHeader title="Platform overview" description="Revenue, growth and health across every business on TherapyOS." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="platform-metrics">
        <StatCard label="MRR" value={money(data.mrr)} hint={`ARR ${money(data.arr, undefined, true)}`} icon={<IndianRupee className="h-4 w-4" />} />
        <StatCard label="Businesses" value={data.tenants.total} hint={`${data.tenants.newLast30Days} joined in the last 30 days`} icon={<Building2 className="h-4 w-4" />} />
        <StatCard label="Churn (30 days)" value={`${data.churnRate}%`} hint={`${data.churnedLast30Days} cancelled or expired`} icon={<TrendingDown className="h-4 w-4" />} />
        <StatCard label="ARPA" value={money(data.arpa)} hint="Average monthly revenue per paying business" icon={<Users className="h-4 w-4" />} />
        <StatCard label="Collected (30 days)" value={money(data.collectedLast30Days)} hint="Subscription invoices paid" icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard label="Customer GMV (30 days)" value={money(data.gmvLast30Days, undefined, true)} hint="Payments processed by businesses" icon={<IndianRupee className="h-4 w-4" />} />
        <StatCard label="Trials ending in 7 days" value={data.subscriptions.trialsEndingSoon} hint={<Link className="text-brand-700 hover:underline" href="/admin/tenants?subscriptionStatus=TRIALING">See trials</Link>} icon={<Users className="h-4 w-4" />} />
        <StatCard label="Open support tickets" value={data.openTickets} hint={<Link className="text-brand-700 hover:underline" href="/admin/support">Go to support</Link>} icon={<LifeBuoy className="h-4 w-4" />} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Last 6 months" description="New businesses and subscription revenue collected." />
          <CardContent>
            <div className="h-64" data-testid="platform-trend">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="month" fontSize={11} />
                  <YAxis yAxisId="rev" fontSize={11} tickFormatter={(v: number) => money(v, undefined, true)} width={60} />
                  <YAxis yAxisId="count" orientation="right" fontSize={11} allowDecimals={false} width={30} />
                  <Tooltip formatter={(v, name) => (name === 'Revenue' ? money(Number(v ?? 0)) : String(v))} />
                  <Legend />
                  <Bar yAxisId="rev" dataKey="revenue" name="Revenue" fill="#0d9488" radius={[4, 4, 0, 0]} />
                  <Bar yAxisId="count" dataKey="signups" name="Signups" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
        <div className="space-y-5">
          <StatusList title="Businesses by status" counts={data.tenants.byStatus} href={(s) => `/admin/tenants?status=${s}`} />
          <StatusList title="Subscriptions by status" counts={data.subscriptions.byStatus} href={(s) => `/admin/tenants?subscriptionStatus=${s}`} />
        </div>
      </div>
      <Card>
        <CardHeader title="Revenue by plan" />
        <Table>
          <THead><TR><TH>Plan</TH><TH className="text-right">Businesses</TH><TH className="text-right">Paying</TH><TH className="text-right">MRR</TH><TH className="text-right">Share</TH></TR></THead>
          <TBody>
            {data.plans.map((p) => (
              <TR key={p.planId}>
                <TD><Link href={`/admin/tenants?planId=${p.planId}`} className="font-medium text-slate-800 hover:underline">{p.name}</Link></TD>
                <TD className="text-right">{p.tenants}</TD>
                <TD className="text-right">{p.paying}</TD>
                <TD className="text-right font-medium">{money(p.mrr)}</TD>
                <TD className="text-right text-slate-500">{data.mrr ? Math.round((p.mrr / data.mrr) * 100) : 0}%</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
