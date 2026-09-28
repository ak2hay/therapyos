'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Ban, CheckCircle2, Pencil } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FEATURE_FLAG_KEYS } from '@therapyos/types';
import { Badge, Button, Card, CardContent, CardHeader, Field, Input, LoadingBlock, Modal, PageHeader, Select, StatCard, Table, TBody, TD, Textarea, TH, THead, TR } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { ago, fmtDate, fmtDateTime, money, titleCase } from '@/lib/format';

interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  status: string;
  suspendedReason: string | null;
  createdAt: string;
  branding: { appName: string | null; customDomain: string | null } | null;
  subscription: { id: string; status: string; billingCycle: 'MONTHLY' | 'ANNUAL'; renewalDate: string | null; trialEndDate: string | null; cancelledAt: string | null; provider: string | null; plan: { id: string; code: string; name: string } } | null;
  subscriptionHistory: { id: string; status: string; billingCycle: string; startDate: string; isCurrent: boolean; provider: string | null; plan: { name: string } }[];
  invoices: { id: string; amount: number; status: string; periodStart: string; periodEnd: string; paidAt: string | null }[];
  limits: { branches: number; users: number; customers: number };
  usage: { branches: number; users: number; customers: number };
  features: string[];
  overrides: { key: string; enabled: boolean }[];
  branches: { id: string; name: string; code: string; city: string | null; status: string }[];
  owners: { id: string; name: string; email: string | null; phone: string | null; lastLoginAt: string | null }[];
  audit: { id: string; action: string; entityType: string; actorType: string; createdAt: string }[];
  tickets: { id: string; subject: string; status: string; priority: string; updatedAt: string }[];
  activity: { gmvLast30Days: number; sessionsLast30Days: number };
}
const TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'gray'> = { ACTIVE: 'green', ONBOARDING: 'blue', TRIALING: 'blue', PAST_DUE: 'amber', SUSPENDED: 'red', CANCELLED: 'gray', EXPIRED: 'gray' };

function StatusModal({ tenant, onClose }: { tenant: TenantDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const suspending = tenant.status !== 'SUSPENDED';
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.patch(`/admin/tenants/${tenant.id}/status`, { status: suspending ? 'SUSPENDED' : 'ACTIVE', reason: suspending ? reason : undefined });
      toast.success(suspending ? 'Business suspended' : 'Business reactivated');
      await qc.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="sm" title={suspending ? `Suspend ${tenant.name}?` : `Reactivate ${tenant.name}?`}
      description={suspending ? 'Staff can still sign in but only see the subscription and support pages until you reactivate.' : 'Staff regain full access immediately.'}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant={suspending ? 'danger' : 'primary'} loading={busy} disabled={suspending && reason.trim().length < 3} onClick={submit}>{suspending ? 'Suspend' : 'Reactivate'}</Button></>}>
      {suspending && <Field label="Reason (shown to the business)"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Payment overdue since 1 Sep" /></Field>}
    </Modal>
  );
}

function SubscriptionModal({ tenant, onClose }: { tenant: TenantDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get<{ id: string; name: string; status: string }[]>('/admin/plans') });
  const s = tenant.subscription;
  const [form, setForm] = useState({
    planId: s?.plan.id ?? '',
    billingCycle: s?.billingCycle ?? 'MONTHLY',
    status: s?.status ?? '',
    trialEndDate: s?.trialEndDate?.slice(0, 10) ?? '',
    renewalDate: s?.renewalDate?.slice(0, 10) ?? '',
  });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.patch(`/admin/tenants/${tenant.id}/subscription`, {
        planId: form.planId || undefined,
        billingCycle: form.billingCycle,
        status: form.status && form.status !== s?.status ? form.status : undefined,
        trialEndDate: form.trialEndDate && form.trialEndDate !== s?.trialEndDate?.slice(0, 10) ? form.trialEndDate : undefined,
        renewalDate: form.renewalDate && form.renewalDate !== s?.renewalDate?.slice(0, 10) ? form.renewalDate : undefined,
      });
      toast.success('Subscription updated');
      await qc.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="md" title="Edit subscription" description="Changes apply immediately and are not charged; use this for comps, extensions and corrections."
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!form.planId} onClick={submit}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Plan">
          <Select value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })} aria-label="Plan">
            <option value="">Choose…</option>
            {plans.data?.filter((p) => p.status === 'ACTIVE' || p.id === form.planId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Billing cycle">
          <Select value={form.billingCycle} onChange={(e) => setForm({ ...form, billingCycle: e.target.value as 'MONTHLY' | 'ANNUAL' })}>
            <option value="MONTHLY">Monthly</option>
            <option value="ANNUAL">Yearly</option>
          </Select>
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} aria-label="Subscription status">
            {['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED'].map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
          </Select>
        </Field>
        <Field label="Trial ends"><Input type="date" value={form.trialEndDate} onChange={(e) => setForm({ ...form, trialEndDate: e.target.value })} aria-label="Trial end date" /></Field>
        <Field label="Renews on" className="sm:col-span-2"><Input type="date" value={form.renewalDate} onChange={(e) => setForm({ ...form, renewalDate: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function FlagOverrides({ tenant }: { tenant: TenantDetail }) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  const set = async (key: string, value: string) => {
    setSaving(key);
    try {
      await api.put('/admin/flags', { key, tenantId: tenant.id, enabled: value === '' ? null : value === 'on' });
      toast.success(`${titleCase(key)} updated`);
      await qc.invalidateQueries({ queryKey: ['admin', 'tenant', tenant.id] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };
  return (
    <Card>
      <CardHeader title="Features" description="Effective features come from the plan, global flags and the overrides set here." />
      <Table>
        <THead><TR><TH>Feature</TH><TH>Effective</TH><TH>Override</TH></TR></THead>
        <TBody>
          {FEATURE_FLAG_KEYS.map((key) => {
            const override = tenant.overrides.find((o) => o.key === key);
            return (
              <TR key={key} data-testid={`flag-${key}`}>
                <TD className="text-sm">{titleCase(key.replace(/_ENABLED$/, ''))}</TD>
                <TD>{tenant.features.includes(key) ? <Badge tone="green">On</Badge> : <Badge tone="gray">Off</Badge>}</TD>
                <TD>
                  <Select value={override ? (override.enabled ? 'on' : 'off') : ''} disabled={saving === key} onChange={(e) => set(key, e.target.value)} className="h-8 w-36 text-xs" aria-label={`Override ${key}`}>
                    <option value="">Plan default</option>
                    <option value="on">Force on</option>
                    <option value="off">Force off</option>
                  </Select>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </Card>
  );
}

export default function AdminTenantPage() {
  const { id } = useParams<{ id: string }>();
  const { data: t, isLoading } = useQuery({ queryKey: ['admin', 'tenant', id], queryFn: () => api.get<TenantDetail>(`/admin/tenants/${id}`) });
  const [editing, setEditing] = useState<'status' | 'subscription' | null>(null);
  if (isLoading || !t) return <LoadingBlock />;
  const s = t.subscription;
  return (
    <div className="space-y-5">
      <Link href="/admin/tenants" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> All businesses</Link>
      <PageHeader
        title={t.name}
        description={`${t.slug}${t.email ? ` · ${t.email}` : ''}${t.phone ? ` · ${t.phone}` : ''} · joined ${fmtDate(t.createdAt)}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={TONE[t.status] ?? 'gray'}>{titleCase(t.status)}</Badge>
            {t.status === 'SUSPENDED'
              ? <Button variant="success" onClick={() => setEditing('status')}><CheckCircle2 className="h-4 w-4" /> Reactivate</Button>
              : <Button variant="outline" onClick={() => setEditing('status')}><Ban className="h-4 w-4" /> Suspend</Button>}
          </div>
        }
      />
      {t.status === 'SUSPENDED' && t.suspendedReason && <div className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">Suspended: {t.suspendedReason}</div>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Branches" value={`${t.usage.branches} / ${t.limits.branches}`} />
        <StatCard label="Staff" value={`${t.usage.users} / ${t.limits.users}`} />
        <StatCard label="Customers" value={`${t.usage.customers.toLocaleString()} / ${t.limits.customers.toLocaleString()}`} />
        <StatCard label="GMV (30 days)" value={money(t.activity.gmvLast30Days)} />
        <StatCard label="Sessions (30 days)" value={t.activity.sessionsLast30Days} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card data-testid="tenant-subscription">
            <CardHeader title="Subscription" actions={<Button size="sm" variant="outline" onClick={() => setEditing('subscription')}><Pencil className="h-3.5 w-3.5" /> Edit</Button>} />
            <CardContent className="grid gap-3 text-sm sm:grid-cols-4">
              {s ? (
                <>
                  <div><p className="text-xs text-slate-500">Plan</p><p className="font-medium">{s.plan.name}</p></div>
                  <div><p className="text-xs text-slate-500">Status</p><Badge tone={TONE[s.status] ?? 'gray'}>{titleCase(s.status)}</Badge>{s.cancelledAt && <p className="text-xs text-amber-700">Cancels at period end</p>}</div>
                  <div><p className="text-xs text-slate-500">{s.status === 'TRIALING' ? 'Trial ends' : 'Renews'}</p><p>{fmtDate(s.status === 'TRIALING' ? s.trialEndDate : s.renewalDate)}</p></div>
                  <div><p className="text-xs text-slate-500">Billing</p><p>{s.billingCycle === 'ANNUAL' ? 'Yearly' : 'Monthly'} · {s.provider ?? '—'}</p></div>
                </>
              ) : <p className="text-slate-500">No subscription.</p>}
            </CardContent>
            {t.invoices.length > 0 && (
              <Table>
                <THead><TR><TH>Period</TH><TH className="text-right">Amount</TH><TH>Status</TH></TR></THead>
                <TBody>
                  {t.invoices.map((i) => (
                    <TR key={i.id}>
                      <TD className="text-xs">{fmtDate(i.periodStart)} – {fmtDate(i.periodEnd)}</TD>
                      <TD className="text-right">{money(i.amount)}</TD>
                      <TD><Badge tone={i.status === 'PAID' ? 'green' : 'amber'}>{titleCase(i.status)}</Badge></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
          <FlagOverrides tenant={t} />
          <Card>
            <CardHeader title="Recent activity" />
            <Table>
              <TBody>
                {t.audit.map((a) => (
                  <TR key={a.id}>
                    <TD className="text-sm">{titleCase(a.action)}</TD>
                    <TD className="text-xs text-slate-500">{a.entityType} · {titleCase(a.actorType)}</TD>
                    <TD className="text-right text-xs text-slate-500" title={fmtDateTime(a.createdAt)}>{ago(a.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </div>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Owners" />
            <CardContent className="space-y-2 text-sm">
              {t.owners.map((o) => (
                <div key={o.id}><p className="font-medium">{o.name}</p><p className="text-xs text-slate-500">{o.email ?? o.phone} · last login {o.lastLoginAt ? ago(o.lastLoginAt) : 'never'}</p></div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Branches" />
            <CardContent className="space-y-1.5 text-sm">
              {t.branches.map((b) => (
                <div key={b.id} className="flex justify-between"><span>{b.name} <span className="text-xs text-slate-500">{b.code}{b.city ? ` · ${b.city}` : ''}</span></span><Badge tone={b.status === 'ACTIVE' ? 'green' : 'gray'}>{titleCase(b.status)}</Badge></div>
              ))}
            </CardContent>
          </Card>
          {t.branding && (
            <Card>
              <CardHeader title="White label" />
              <CardContent className="text-sm"><p>{t.branding.appName ?? t.name}</p><p className="text-xs text-slate-500">{t.branding.customDomain ?? 'No custom domain'}</p></CardContent>
            </Card>
          )}
          <Card>
            <CardHeader title="Support tickets" actions={<Link href={`/admin/support?tenantId=${t.id}`} className="text-xs text-brand-700 hover:underline">All</Link>} />
            <CardContent className="space-y-2 text-sm">
              {t.tickets.length ? t.tickets.map((k) => (
                <Link key={k.id} href={`/admin/support?ticket=${k.id}`} className="block rounded-md p-1.5 hover:bg-slate-50">
                  <p className="truncate font-medium">{k.subject}</p>
                  <p className="text-xs text-slate-500">{titleCase(k.status)} · {titleCase(k.priority)} · {ago(k.updatedAt)}</p>
                </Link>
              )) : <p className="text-slate-500">No tickets.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Subscription history" />
            <CardContent className="space-y-1.5 text-xs">
              {t.subscriptionHistory.map((h) => (
                <div key={h.id} className="flex justify-between"><span>{h.plan.name} · {titleCase(h.status)}{h.isCurrent ? ' (current)' : ''}</span><span className="text-slate-500">{fmtDate(h.startDate)}</span></div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
      {editing === 'status' && <StatusModal tenant={t} onClose={() => setEditing(null)} />}
      {editing === 'subscription' && <SubscriptionModal tenant={t} onClose={() => setEditing(null)} />}
    </div>
  );
}
