'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Search } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { NewBusinessModal } from '@/components/admin-onboarding';
import { Badge, Button, Card, EmptyState, Input, LoadingBlock, PageHeader, Pagination, Select, Table, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { api } from '@/lib/api';
import { ago, fmtDate, titleCase } from '@/lib/format';

interface AdminTenantRow {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  status: string;
  createdAt: string;
  subscription: { id: string; status: string; billingCycle: string; plan: { id: string; code: string; name: string }; trialEndDate: string | null; renewalDate: string | null; cancelledAt: string | null } | null;
  usage: { branches: number; users: number; customers: number };
  lastActiveAt: string | null;
}
const TENANT_TONE: Record<string, 'green' | 'blue' | 'red' | 'gray'> = { ACTIVE: 'green', ONBOARDING: 'blue', SUSPENDED: 'red', CANCELLED: 'gray' };
const SUB_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'gray'> = { ACTIVE: 'green', TRIALING: 'blue', PAST_DUE: 'amber', CANCELLED: 'red', EXPIRED: 'gray' };

function TenantsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const status = params.get('status') ?? '';
  const subscriptionStatus = params.get('subscriptionStatus') ?? '';
  const planId = params.get('planId') ?? '';
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [debounced, setDebounced] = useState(search);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [status, subscriptionStatus, planId, debounced]);
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`/admin/tenants${next.size ? `?${next}` : ''}`);
  };
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get<{ id: string; name: string }[]>('/admin/plans') });
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'tenants', { status, subscriptionStatus, planId, debounced, page }],
    queryFn: () => api.page<AdminTenantRow>('/admin/tenants', { status: status || undefined, subscriptionStatus: subscriptionStatus || undefined, planId: planId || undefined, search: debounced || undefined, page: String(page), pageSize: '25' }),
  });
  return (
    <div className="space-y-5">
      <PageHeader title="Businesses" description="Every tenant on the platform, with plan, usage and activity." actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New business</Button>} />
      {creating && <NewBusinessModal onClose={() => setCreating(false)} />}
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, slug or email" className="pl-8" aria-label="Search businesses" />
        </div>
        <Select value={status} onChange={(e) => setFilter('status', e.target.value)} aria-label="Business status" className="w-40">
          <option value="">All statuses</option>
          {['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select>
        <Select value={subscriptionStatus} onChange={(e) => setFilter('subscriptionStatus', e.target.value)} aria-label="Subscription status" className="w-44">
          <option value="">All subscriptions</option>
          {['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select>
        <Select value={planId} onChange={(e) => setFilter('planId', e.target.value)} aria-label="Plan" className="w-40">
          <option value="">All plans</option>
          {plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </Card>
      <Card>
        {isLoading ? <LoadingBlock /> : !data?.items.length ? <EmptyState title="No businesses match" description="Try clearing the filters." /> : (
          <>
            <Table>
              <THead><TR><TH>Business</TH><TH>Status</TH><TH>Plan</TH><TH className="text-right">Branches</TH><TH className="text-right">Staff</TH><TH className="text-right">Customers</TH><TH>Last active</TH><TH>Joined</TH></TR></THead>
              <TBody>
                {data.items.map((t) => (
                  <TR key={t.id} data-testid="tenant-row">
                    <TD>
                      <Link href={`/admin/tenants/${t.id}`} className="font-medium text-slate-900 hover:underline">{t.name}</Link>
                      <p className="text-xs text-slate-500">{t.slug}{t.email ? ` · ${t.email}` : ''}</p>
                    </TD>
                    <TD><Badge tone={TENANT_TONE[t.status] ?? 'gray'}>{titleCase(t.status)}</Badge></TD>
                    <TD>
                      {t.subscription ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm">{t.subscription.plan.name} <span className="text-xs text-slate-500">({t.subscription.billingCycle === 'ANNUAL' ? 'yearly' : 'monthly'})</span></span>
                          <Badge tone={SUB_TONE[t.subscription.status] ?? 'gray'} className="w-fit">{titleCase(t.subscription.status)}{t.subscription.status === 'TRIALING' && t.subscription.trialEndDate ? ` · ends ${fmtDate(t.subscription.trialEndDate)}` : ''}</Badge>
                        </div>
                      ) : <span className="text-xs text-slate-400">No plan</span>}
                    </TD>
                    <TD className="text-right">{t.usage.branches}</TD>
                    <TD className="text-right">{t.usage.users}</TD>
                    <TD className="text-right">{t.usage.customers.toLocaleString()}</TD>
                    <TD className="text-xs">{t.lastActiveAt ? ago(t.lastActiveAt) : 'Never'}</TD>
                    <TD className="text-xs">{fmtDate(t.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}

export default function AdminTenantsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <TenantsInner />
    </Suspense>
  );
}
