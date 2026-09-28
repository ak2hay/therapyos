'use client';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Crown, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, LoadingBlock, Modal, PageHeader, Pagination, Select, StatusBadge, Table, Tabs, TBody, TD, Textarea, TH, THead, TR } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { fmtDate, fmtDateTime, money, titleCase } from '@/lib/format';
import { useServices } from '@/lib/queries';
import { SellModal } from '@/components/billing-actions';

type BenefitType = 'SERVICE_DISCOUNT_PERCENT' | 'PRODUCT_DISCOUNT_PERCENT' | 'INCLUDED_SESSIONS' | 'PRIORITY_BOOKING';
interface Benefit {
  id: string;
  type: BenefitType;
  serviceId: string | null;
  categoryId: string | null;
  value: number;
  quantity: number | null;
}
interface Plan {
  id: string;
  name: string;
  description: string | null;
  price: number;
  taxRate: number;
  billingInterval: string;
  durationDays: number;
  status: 'ACTIVE' | 'INACTIVE';
  benefits: Benefit[];
  activeMembers: number;
}
interface BenefitState {
  benefitId: string;
  type: BenefitType;
  serviceId: string | null;
  categoryId: string | null;
  value: number;
  quantity: number | null;
  remaining: number | null;
}
interface MemberRow {
  id: string;
  status: string;
  startedAt: string;
  expiresAt: string;
  autoRenew: boolean;
  purchaseInvoiceId: string | null;
  plan: { id: string; name: string; price: number };
  customer: { id: string; name: string; phone: string; customerCode: string };
  benefits: BenefitState[];
}
interface MemberDetail extends MemberRow {
  usageHistory: { id: string; benefitId: string; quantity: number; usedAt: string; sessionId: string | null; invoiceId: string | null }[];
}
interface Category {
  id: string;
  name: string;
}

const BENEFIT_LABEL: Record<BenefitType, string> = {
  SERVICE_DISCOUNT_PERCENT: 'Discount on services',
  PRODUCT_DISCOUNT_PERCENT: 'Discount on products',
  INCLUDED_SESSIONS: 'Included sessions',
  PRIORITY_BOOKING: 'Priority booking',
};
const INTERVALS = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'ONE_TIME'];

function useCatalogNames() {
  const { data: services } = useServices();
  const { data: categories } = useQuery({ queryKey: ['service-categories'], queryFn: () => api.get<Category[]>('/service-categories') });
  return {
    services: services ?? [],
    categories: categories ?? [],
    describe(b: { type: BenefitType; serviceId: string | null; categoryId?: string | null; value: number; quantity: number | null }) {
      const service = services?.find((s) => s.id === b.serviceId)?.name;
      const category = categories?.find((c) => c.id === b.categoryId)?.name;
      switch (b.type) {
        case 'SERVICE_DISCOUNT_PERCENT':
          return `${b.value}% off ${service ?? (category ? `${category} services` : 'all services')}`;
        case 'PRODUCT_DISCOUNT_PERCENT':
          return `${b.value}% off products`;
        case 'INCLUDED_SESSIONS':
          return `${b.quantity} x ${service ?? 'any service'} included`;
        default:
          return 'Priority booking';
      }
    },
  };
}

function PlanForm({ existing, onDone }: { existing?: Plan; onDone: () => void }) {
  const qc = useQueryClient();
  const { services, categories } = useCatalogNames();
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    price: existing ? String(existing.price) : '',
    taxRate: String(existing?.taxRate ?? 18),
    billingInterval: existing?.billingInterval ?? 'MONTHLY',
    durationDays: String(existing?.durationDays ?? 30),
    status: existing?.status ?? 'ACTIVE',
  });
  const [benefits, setBenefits] = useState(
    existing?.benefits.map((b) => ({ type: b.type, serviceId: b.serviceId ?? '', categoryId: b.categoryId ?? '', value: String(b.value), quantity: b.quantity ? String(b.quantity) : '' })) ?? [
      { type: 'SERVICE_DISCOUNT_PERCENT' as BenefitType, serviceId: '', categoryId: '', value: '10', quantity: '' },
    ],
  );
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const patchBenefit = (i: number, patch: Partial<(typeof benefits)[number]>) => setBenefits((p) => p.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const onInterval = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const days: Record<string, number> = { MONTHLY: 30, QUARTERLY: 90, HALF_YEARLY: 180, YEARLY: 365 };
    setForm((f) => ({ ...f, billingInterval: e.target.value, durationDays: days[e.target.value] ? String(days[e.target.value]) : f.durationDays }));
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        ...form,
        price: Number(form.price),
        taxRate: Number(form.taxRate),
        durationDays: Number(form.durationDays),
        benefits: benefits.map((b) => ({
          type: b.type,
          serviceId: b.type === 'SERVICE_DISCOUNT_PERCENT' || b.type === 'INCLUDED_SESSIONS' ? b.serviceId || undefined : undefined,
          categoryId: b.type === 'SERVICE_DISCOUNT_PERCENT' && !b.serviceId ? b.categoryId || undefined : undefined,
          value: b.type.endsWith('PERCENT') ? Number(b.value) : 0,
          quantity: b.type === 'INCLUDED_SESSIONS' ? Number(b.quantity) : undefined,
        })),
      };
      if (existing) await api.patch(`/membership-plans/${existing.id}`, body);
      else await api.post('/membership-plans', body);
      await qc.invalidateQueries({ queryKey: ['membership-plans'] });
      toast.success('Plan saved');
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Plan name" className="sm:col-span-2"><Input value={form.name} onChange={set('name')} placeholder="e.g. Gold Wellness" /></Field>
        <Field label="Price"><Input type="number" min={0} step="0.01" value={form.price} onChange={set('price')} /></Field>
        <Field label="Tax rate (%)"><Input type="number" min={0} max={100} step="0.01" value={form.taxRate} onChange={set('taxRate')} /></Field>
        <Field label="Billing">
          <Select value={form.billingInterval} onChange={onInterval}>
            {INTERVALS.map((i) => <option key={i} value={i}>{titleCase(i)}</option>)}
          </Select>
        </Field>
        <Field label="Duration (days)"><Input type="number" min={1} value={form.durationDays} onChange={set('durationDays')} /></Field>
        <Field label="Status">
          <Select value={form.status} onChange={set('status')}>
            <option value="ACTIVE">On sale</option>
            <option value="INACTIVE">Not on sale</option>
          </Select>
        </Field>
        <Field label="Description" className="sm:col-span-2"><Textarea value={form.description} onChange={set('description')} /></Field>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium text-slate-600">Benefits</p>
        <div className="space-y-2">
          {benefits.map((b, i) => (
            <div key={i} className="flex flex-wrap gap-2 rounded-lg border border-slate-200 p-2">
              <Select className="w-52" value={b.type} onChange={(e) => patchBenefit(i, { type: e.target.value as BenefitType })}>
                {Object.entries(BENEFIT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
              {(b.type === 'SERVICE_DISCOUNT_PERCENT' || b.type === 'INCLUDED_SESSIONS') && (
                <Select className="w-52" value={b.serviceId} onChange={(e) => patchBenefit(i, { serviceId: e.target.value })}>
                  <option value="">{b.type === 'INCLUDED_SESSIONS' ? 'Select service' : 'All services'}</option>
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              )}
              {b.type === 'SERVICE_DISCOUNT_PERCENT' && !b.serviceId && (
                <Select className="w-44" value={b.categoryId} onChange={(e) => patchBenefit(i, { categoryId: e.target.value })}>
                  <option value="">Any category</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              )}
              {b.type.endsWith('PERCENT') && (
                <div className="flex items-center gap-1">
                  <Input type="number" min={1} max={100} className="w-20" value={b.value} onChange={(e) => patchBenefit(i, { value: e.target.value })} aria-label="Percent" />
                  <span className="text-sm text-slate-500">%</span>
                </div>
              )}
              {b.type === 'INCLUDED_SESSIONS' && (
                <Input type="number" min={1} className="w-24" placeholder="Qty" value={b.quantity} onChange={(e) => patchBenefit(i, { quantity: e.target.value })} aria-label="Sessions" />
              )}
              <Button variant="ghost" size="icon" className="ml-auto" onClick={() => setBenefits((p) => p.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setBenefits((p) => [...p, { type: 'INCLUDED_SESSIONS', serviceId: '', categoryId: '', value: '0', quantity: '1' }])}>
            <Plus className="h-3.5 w-3.5" /> Add benefit
          </Button>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button onClick={save} loading={busy} disabled={!form.name || form.price === ''}>Save plan</Button>
      </div>
    </div>
  );
}

function PlansTab({ canManage, canSell }: { canManage: boolean; canSell: boolean }) {
  const [editing, setEditing] = useState<Plan | null | undefined>(undefined);
  const [selling, setSelling] = useState<Plan | null>(null);
  const { describe } = useCatalogNames();
  const { data, isLoading } = useQuery({ queryKey: ['membership-plans'], queryFn: () => api.get<Plan[]>('/membership-plans') });
  const onSale = (data ?? []).filter((p) => p.status === 'ACTIVE');
  return (
    <>
      {canManage && (
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> New plan</Button>
        </div>
      )}
      {isLoading ? (
        <LoadingBlock />
      ) : !data?.length ? (
        <Card><EmptyState icon={<Crown className="h-6 w-6" />} title="No membership plans" description="Memberships give regulars standing discounts and included sessions." action={canManage && <Button onClick={() => setEditing(null)}>Create plan</Button>} /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((p) => (
            <Card key={p.id} className={`flex flex-col p-5 ${p.status !== 'ACTIVE' ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-slate-900">{p.name}</h3>
                  <p className="text-xs text-slate-500">{titleCase(p.billingInterval)} · {p.durationDays} days · {p.activeMembers} active members</p>
                </div>
                {p.status !== 'ACTIVE' && <Badge>Not on sale</Badge>}
              </div>
              <ul className="mt-3 flex-1 space-y-1 text-sm text-slate-600">
                {p.benefits.map((b) => <li key={b.id}>• {describe(b)}</li>)}
                {!p.benefits.length && <li className="text-slate-400">No benefits configured</li>}
              </ul>
              <div className="mt-4 flex items-end justify-between">
                <p className="text-xl font-semibold text-slate-900">{money(p.price)}</p>
                <div className="flex gap-1">
                  {canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(p)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>}
                  {canSell && p.status === 'ACTIVE' && <Button size="sm" onClick={() => setSelling(p)}>Sell</Button>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? `Edit ${editing.name}` : 'New membership plan'} size="lg">
        {editing !== undefined && <PlanForm existing={editing ?? undefined} onDone={() => setEditing(undefined)} />}
      </Modal>
      {selling && <SellModal kind="MEMBERSHIP" options={onSale} defaultItemId={selling.id} onClose={() => setSelling(null)} />}
    </>
  );
}

function MemberModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const { describe } = useCatalogNames();
  const { data: m } = useQuery({ queryKey: ['membership', id], queryFn: () => api.get<MemberDetail>(`/memberships/${id}`) });
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const canManage = hasPermission(user, PERMISSIONS.MEMBERSHIP_MANAGE);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['membership', id] });
    await qc.invalidateQueries({ queryKey: ['memberships'] });
  };
  const toggleRenew = async (autoRenew: boolean) => {
    try {
      await api.patch(`/memberships/${id}/auto-renew`, { autoRenew });
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await api.post(`/memberships/${id}/cancel`, { reason });
      await refresh();
      setCancelling(false);
      toast.success('Membership cancelled');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const benefitName = (benefitId: string) => {
    const b = m?.benefits.find((x) => x.benefitId === benefitId);
    return b ? describe(b) : 'Benefit';
  };

  return (
    <Modal open onClose={onClose} title={m?.plan.name ?? 'Membership'} description={m ? `${m.customer.name} · ${m.customer.customerCode}` : undefined} size="lg">
      {!m ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <StatusBadge status={m.status} />
            <span>{fmtDate(m.startedAt)} to {fmtDate(m.expiresAt)}</span>
            {m.purchaseInvoiceId && <Link className="text-brand-700 hover:underline" href={`/invoices/${m.purchaseInvoiceId}`}>Purchase invoice</Link>}
          </div>
          <div className="space-y-2">
            {m.benefits.map((b) => (
              <div key={b.benefitId} className="flex justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span>{describe(b)}</span>
                {b.remaining != null && <span className="tabular-nums text-slate-600">{b.remaining} of {b.quantity} left</span>}
              </div>
            ))}
          </div>
          {canManage && m.status === 'ACTIVE' && (
            <div className="flex items-center justify-between">
              <Checkbox label="Renew automatically" checked={m.autoRenew} onChange={(e) => toggleRenew(e.target.checked)} />
              <Button variant="danger" size="sm" onClick={() => setCancelling(true)}>Cancel membership</Button>
            </div>
          )}
          {cancelling && (
            <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
              <p className="text-sm text-rose-800">Cancelling ends the benefits immediately. No refund is issued automatically.</p>
              <Input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setCancelling(false)}>Keep</Button>
                <Button size="sm" variant="danger" onClick={cancel} loading={busy}>Confirm cancel</Button>
              </div>
            </div>
          )}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Benefit usage</p>
            {!m.usageHistory.length ? (
              <p className="text-sm text-slate-500">No included sessions used yet.</p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
                {m.usageHistory.map((u) => (
                  <div key={u.id} className="flex justify-between px-3 py-2">
                    <span>{u.quantity} x {benefitName(u.benefitId)}</span>
                    <span className="text-xs text-slate-500">{fmtDateTime(u.usedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function MembersTab({ canSell }: { canSell: boolean }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [planId, setPlanId] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [selling, setSelling] = useState(false);
  const { data: plans } = useQuery({ queryKey: ['membership-plans'], queryFn: () => api.get<Plan[]>('/membership-plans') });
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const { data, isLoading } = useQuery({
    queryKey: ['memberships', debounced, status, planId, page],
    queryFn: () =>
      api.page<MemberRow>('/memberships', {
        search: debounced || undefined,
        planId: planId || undefined,
        status: status === 'EXPIRING' ? undefined : status || undefined,
        expiringInDays: status === 'EXPIRING' ? '14' : undefined,
        page: String(page),
        pageSize: '25',
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input className="pl-9" placeholder="Customer name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select className="w-44" value={planId} onChange={(e) => { setPlanId(e.target.value); setPage(1); }}>
          <option value="">All plans</option>
          {plans?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select className="w-48" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="ACTIVE">Active</option>
          <option value="EXPIRING">Expiring in 14 days</option>
          <option value="PENDING_PAYMENT">Awaiting payment</option>
          <option value="EXPIRED">Expired</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="">All</option>
        </Select>
        {canSell && !!plans?.some((p) => p.status === 'ACTIVE') && (
          <Button className="ml-auto" onClick={() => setSelling(true)}><Plus className="h-4 w-4" /> Sell membership</Button>
        )}
      </div>
      {isLoading ? (
        <LoadingBlock />
      ) : !data?.items.length ? (
        <EmptyState icon={<Crown className="h-6 w-6" />} title="No memberships match" />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Member</TH>
                <TH>Plan</TH>
                <TH>Period</TH>
                <TH>Auto-renew</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {data.items.map((m) => (
                <TR key={m.id} className="cursor-pointer" onClick={() => setOpen(m.id)}>
                  <TD><p className="font-medium text-slate-900">{m.customer.name}</p><p className="text-xs text-slate-500">{m.customer.phone}</p></TD>
                  <TD>{m.plan.name}</TD>
                  <TD className="text-slate-600">{fmtDate(m.startedAt)} to {fmtDate(m.expiresAt)}</TD>
                  <TD>{m.autoRenew ? <Badge tone="green">On</Badge> : <span className="text-slate-400">Off</span>}</TD>
                  <TD><StatusBadge status={m.status} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
        </>
      )}
      {open && <MemberModal id={open} onClose={() => setOpen(null)} />}
      {selling && plans && <SellModal kind="MEMBERSHIP" options={plans.filter((p) => p.status === 'ACTIVE')} onClose={() => setSelling(false)} />}
    </Card>
  );
}

export default function MembershipsPage() {
  const user = useAuth((s) => s.user);
  const [tab, setTab] = useState<'plans' | 'members'>('plans');
  const canManage = hasPermission(user, PERMISSIONS.MEMBERSHIP_MANAGE);
  const canSell = hasPermission(user, PERMISSIONS.MEMBERSHIP_SELL) && hasPermission(user, PERMISSIONS.INVOICE_CREATE);
  return (
    <div>
      <PageHeader title="Memberships" description="Subscription plans with standing discounts and included sessions" />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'plans', label: 'Plans' }, { value: 'members', label: 'Members' }]} />
      {tab === 'plans' ? <PlansTab canManage={canManage} canSell={canSell} /> : <MembersTab canSell={canSell} />}
    </div>
  );
}
