'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, KeyRound, Palette, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardContent, CardHeader, Checkbox, ConfirmDialog, EmptyState, Field, Input, LoadingBlock, Modal, Table, TBody, TD, Textarea, TH, THead, TR } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { hasFeature, refreshSession, useAuth } from '@/lib/auth-store';
import { applyBrandColor } from '@/components/brand-theme';
import { ago, fmtDate, money, titleCase } from '@/lib/format';

// ---------------------------------------------------------------- subscription

interface Plan { id: string; code: string; name: string; description: string | null; monthlyPrice: number; annualPrice: number; maxBranches: number; maxUsers: number; maxCustomers: number; features: string[] }
interface SubscriptionSummary {
  subscription: { id: string; status: string; billingCycle: 'MONTHLY' | 'ANNUAL'; renewalDate: string | null; trialEndDate: string | null; cancelledAt: string | null; plan: Plan } | null;
  trialDaysLeft: number | null;
  plans: Plan[];
  invoices: { id: string; amount: number; status: string; periodStart: string; periodEnd: string; paidAt: string | null }[];
  limits: { branches: number; users: number; customers: number };
  usage: { branches: number; users: number; customers: number };
  pendingChange: { plan: Plan; billingCycle: string } | null;
  provider: string;
}
const STATUS_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'gray'> = { ACTIVE: 'green', TRIALING: 'blue', PAST_DUE: 'amber', CANCELLED: 'red', EXPIRED: 'red' };

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <div>
      <div className="flex justify-between text-sm"><span className="text-slate-600">{label}</span><span className="font-medium">{used.toLocaleString()} / {limit.toLocaleString()}</span></div>
      <div className="mt-1 h-2 rounded bg-slate-100"><div className={`h-2 rounded ${pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-500' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function SubscriptionTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['subscription'], queryFn: () => api.get<SubscriptionSummary>('/subscription') });
  const [cycle, setCycle] = useState<'MONTHLY' | 'ANNUAL'>('MONTHLY');
  const [choice, setChoice] = useState<Plan | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data?.subscription) setCycle(data.subscription.billingCycle);
  }, [data?.subscription]);
  if (isLoading || !data) return <LoadingBlock />;
  const s = data.subscription;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['subscription'] });
    await refreshSession();
  };
  const change = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      const r = await api.post<{ status: string; checkoutUrl?: string | null }>('/subscription/change', { planId: choice.id, billingCycle: cycle });
      if (r.checkoutUrl) {
        window.open(r.checkoutUrl, '_blank', 'noopener');
        toast.info('Complete the payment in the new tab; your plan switches as soon as it succeeds.');
      } else toast.success(`You are now on ${choice.name}`);
      setChoice(null);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    try {
      await api.post('/subscription/cancel');
      toast.success('Your subscription will end at the close of the current period.');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCancelling(false);
    }
  };
  const resume = async () => {
    try {
      await api.post('/subscription/resume');
      toast.success('Subscription resumed');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const endsAt = s?.status === 'TRIALING' ? s.trialEndDate : s?.renewalDate;
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" data-testid="current-plan">
          <CardHeader title={s ? `${s.plan.name} plan` : 'No plan'} description={s?.plan.description ?? undefined} actions={s && <Badge tone={STATUS_TONE[s.status] ?? 'gray'}>{s.status === 'TRIALING' ? 'Free trial' : titleCase(s.status)}</Badge>} />
          <CardContent className="space-y-3 text-sm">
            {s && (
              <>
                <p className="text-slate-600">
                  {s.status === 'TRIALING' ? `Trial ends ${fmtDate(s.trialEndDate)}${data.trialDaysLeft !== null ? ` (${data.trialDaysLeft} days left)` : ''}.` : `${money(s.billingCycle === 'ANNUAL' ? s.plan.annualPrice : s.plan.monthlyPrice)} billed ${s.billingCycle === 'ANNUAL' ? 'yearly' : 'monthly'}.`}
                  {endsAt && s.status !== 'TRIALING' && !s.cancelledAt && ` Renews ${fmtDate(endsAt)}.`}
                </p>
                {s.cancelledAt && (
                  <div className="flex items-center justify-between rounded-lg bg-amber-50 p-3 text-amber-900">
                    <span>Your subscription ends on {fmtDate(endsAt)}. After that the account is paused until you pick a plan.</span>
                    <Button size="sm" variant="outline" onClick={resume}>Keep my plan</Button>
                  </div>
                )}
                {s.status === 'PAST_DUE' && <div className="rounded-lg bg-rose-50 p-3 text-rose-800">Payment is overdue. Choose a plan below to keep your account active.</div>}
                {data.pendingChange && <div className="rounded-lg bg-blue-50 p-3 text-blue-900">Waiting for payment to switch to {data.pendingChange.plan.name}.</div>}
                {!s.cancelledAt && ['ACTIVE', 'TRIALING'].includes(s.status) && <Button size="sm" variant="ghost" onClick={() => setCancelling(true)}>Cancel subscription</Button>}
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Usage" />
          <CardContent className="space-y-3">
            <Meter label="Branches" used={data.usage.branches} limit={data.limits.branches} />
            <Meter label="Staff accounts" used={data.usage.users} limit={data.limits.users} />
            <Meter label="Customers" used={data.usage.customers} limit={data.limits.customers} />
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Plans</h3>
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs">
          {(['MONTHLY', 'ANNUAL'] as const).map((c) => (
            <button key={c} type="button" onClick={() => setCycle(c)} className={`rounded-md px-3 py-1 font-medium ${cycle === c ? 'bg-brand-600 text-white' : 'text-slate-600'}`}>{c === 'MONTHLY' ? 'Monthly' : 'Yearly (2 months free)'}</button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.plans.map((p) => {
          const current = s?.plan.id === p.id && s.billingCycle === cycle && s.status === 'ACTIVE' && !s.cancelledAt;
          const price = cycle === 'ANNUAL' ? p.annualPrice : p.monthlyPrice;
          return (
            <Card key={p.id} className={current ? 'border-brand-400 ring-1 ring-brand-300' : ''} data-testid="plan-card">
              <CardContent className="flex h-full flex-col gap-3 py-4">
                <div>
                  <p className="font-semibold text-slate-900">{p.name}</p>
                  <p className="text-2xl font-semibold text-slate-900">{money(price)}<span className="text-sm font-normal text-slate-500">/{cycle === 'ANNUAL' ? 'year' : 'month'}</span></p>
                  <p className="mt-1 text-xs text-slate-500">{p.description}</p>
                </div>
                <ul className="flex-1 space-y-1 text-xs text-slate-600">
                  <li><Check className="mr-1 inline h-3 w-3 text-brand-600" />{p.maxBranches} branch{p.maxBranches > 1 ? 'es' : ''}, {p.maxUsers} staff</li>
                  <li><Check className="mr-1 inline h-3 w-3 text-brand-600" />Up to {p.maxCustomers.toLocaleString()} customers</li>
                  {p.features.slice(0, 5).map((f) => <li key={f}><Check className="mr-1 inline h-3 w-3 text-brand-600" />{titleCase(f.replace(/_ENABLED$/, ''))}</li>)}
                  {p.features.length > 5 && <li className="text-slate-400">+ {p.features.length - 5} more</li>}
                </ul>
                <Button variant={current ? 'outline' : 'primary'} disabled={current} onClick={() => setChoice(p)}>{current ? 'Current plan' : s?.plan.id === p.id ? `Switch to ${cycle === 'ANNUAL' ? 'yearly' : 'monthly'}` : `Choose ${p.name}`}</Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader title="Billing history" />
        {data.invoices.length ? (
          <Table>
            <THead><TR><TH>Period</TH><TH className="text-right">Amount</TH><TH>Status</TH><TH>Paid</TH></TR></THead>
            <TBody>
              {data.invoices.map((i) => (
                <TR key={i.id}>
                  <TD className="text-xs">{fmtDate(i.periodStart)} – {fmtDate(i.periodEnd)}</TD>
                  <TD className="text-right font-medium">{money(i.amount)}</TD>
                  <TD><Badge tone={i.status === 'PAID' ? 'green' : i.status === 'FAILED' ? 'red' : 'amber'}>{titleCase(i.status)}</Badge></TD>
                  <TD className="text-xs">{i.paidAt ? fmtDate(i.paidAt) : '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <p className="p-6 text-center text-sm text-slate-500">No invoices yet.</p>}
      </Card>

      <Modal open={!!choice} onClose={() => setChoice(null)} size="sm" title={`Switch to ${choice?.name}?`}
        description={choice ? `${money(cycle === 'ANNUAL' ? choice.annualPrice : choice.monthlyPrice)} per ${cycle === 'ANNUAL' ? 'year' : 'month'}, starting today.` : undefined}
        footer={<><Button variant="outline" onClick={() => setChoice(null)}>Not now</Button><Button onClick={change} loading={busy}>Confirm {data.provider === 'razorpay' ? 'and pay' : ''}</Button></>}>
        <p className="text-sm text-slate-600">{data.provider === 'razorpay' ? 'You will be taken to Razorpay to authorise the payment.' : 'Your plan and limits update immediately.'}</p>
      </Modal>
      <ConfirmDialog open={cancelling} onClose={() => setCancelling(false)} onConfirm={cancel} danger title="Cancel subscription?" message="You keep full access until the end of the current period. After that the account is paused until you choose a plan." confirmLabel="Cancel subscription" />
    </div>
  );
}

// ---------------------------------------------------------------- branding

interface Branding { appName: string | null; primaryColor: string | null; accentColor: string | null; logoUrl: string | null; customDomain: string | null; emailSenderName: string | null; emailSenderAddress: string | null; whatsappDisplayName: string | null; invoiceFooter: string | null; poweredBy: boolean }
const EMPTY_BRANDING = { appName: '', primaryColor: '', accentColor: '', logoUrl: '', customDomain: '', emailSenderName: '', emailSenderAddress: '', whatsappDisplayName: '', invoiceFooter: '', poweredBy: true };

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <input type="color" value={value || '#0d9488'} onChange={(e) => onChange(e.target.value)} className="h-9 w-12 cursor-pointer rounded border border-slate-200" aria-label={`${label} picker`} />
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="#0d9488" className="font-mono" />
      </div>
    </Field>
  );
}

export function BrandingTab() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const enabled = hasFeature(user, 'WHITE_LABEL');
  const { data, isLoading } = useQuery({ queryKey: ['branding'], queryFn: () => api.get<Branding | null>('/branding') });
  const [form, setForm] = useState(EMPTY_BRANDING);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(Object.fromEntries(Object.entries({ ...EMPTY_BRANDING, ...data }).map(([k, v]) => [k, v ?? (k === 'poweredBy' ? true : '')])) as typeof EMPTY_BRANDING);
  }, [data]);
  useEffect(() => () => applyBrandColor(enabled ? data?.primaryColor : null), [data, enabled]);
  if (isLoading) return <LoadingBlock />;
  if (!enabled) {
    return <Card><EmptyState icon={<Palette className="h-6 w-6" />} title="White-label branding is on the Enterprise plan" description="Use your own name, colours, logo and domain across the app, booking page, invoices and messages." /></Card>;
  }
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (k === 'primaryColor' && /^#[0-9a-fA-F]{6}$/.test(String(v))) applyBrandColor(String(v));
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/branding', form);
      toast.success('Branding saved');
      await qc.invalidateQueries({ queryKey: ['branding'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const host = typeof window === 'undefined' ? 'app.therapyos.in' : window.location.host;
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Brand" description="Shown in the app, on your public booking and feedback pages, on invoices and in messages." />
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label="Display name"><Input value={form.appName} onChange={(e) => set('appName', e.target.value)} placeholder="Serenity Wellness" /></Field>
          <Field label="Logo URL"><Input value={form.logoUrl} onChange={(e) => set('logoUrl', e.target.value)} placeholder="https://…/logo.png" /></Field>
          <ColorField label="Primary colour" value={form.primaryColor} onChange={(v) => set('primaryColor', v)} />
          <ColorField label="Accent colour" value={form.accentColor} onChange={(v) => set('accentColor', v)} />
          <Field label="Custom domain" className="sm:col-span-2" hint={`Point a CNAME record for your domain to ${host}. Your booking page is then served at https://your-domain/.`}>
            <Input value={form.customDomain} onChange={(e) => set('customDomain', e.target.value)} placeholder="book.serenitywellness.in" />
          </Field>
          <Field label="Email sender name"><Input value={form.emailSenderName} onChange={(e) => set('emailSenderName', e.target.value)} /></Field>
          <Field label="Email sender address" hint="Must be verified with your email provider."><Input type="email" value={form.emailSenderAddress} onChange={(e) => set('emailSenderAddress', e.target.value)} /></Field>
          <Field label="WhatsApp display name"><Input value={form.whatsappDisplayName} onChange={(e) => set('whatsappDisplayName', e.target.value)} /></Field>
          <div className="flex items-end pb-2"><Checkbox label="Show “Powered by TherapyOS”" checked={form.poweredBy} onChange={(e) => set('poweredBy', e.target.checked)} /></div>
          <Field label="Invoice footer" className="sm:col-span-2"><Textarea rows={2} value={form.invoiceFooter} onChange={(e) => set('invoiceFooter', e.target.value)} /></Field>
          <div className="sm:col-span-2 flex justify-end"><Button onClick={save} loading={busy}>Save branding</Button></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Preview" />
        <CardContent className="space-y-3">
          <div className="overflow-hidden rounded-lg border border-slate-200" data-testid="branding-preview">
            <div className="flex items-center gap-2 px-3 py-2.5 text-white" style={{ background: form.primaryColor || '#0d9488' }}>
              {form.logoUrl ? <img src={form.logoUrl} alt="" className="h-6 w-6 rounded bg-white object-contain" /> : <Sparkles className="h-5 w-5" />}
              <span className="font-semibold">{form.appName || 'Your business'}</span>
            </div>
            <div className="space-y-2 p-3 text-sm">
              <p className="text-slate-600">Book your next session</p>
              <button type="button" className="w-full rounded-md px-3 py-1.5 text-sm font-medium text-white" style={{ background: form.accentColor || form.primaryColor || '#0d9488' }}>Book now</button>
              {form.poweredBy && <p className="text-center text-[10px] text-slate-400">Powered by TherapyOS</p>}
            </div>
          </div>
          <p className="text-xs text-slate-500">The primary colour is previewed live across this app; unsaved changes are discarded when you leave.</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- API keys

interface ApiKey { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; createdByName: string | null }

export function DeveloperTab() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const enabled = hasFeature(user, 'API_ACCESS');
  const { data, isLoading } = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get<{ keys: ApiKey[]; scopes: { scope: string; label: string }[]; docsUrl: string }>('/api-keys'), enabled });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ name: string; scopes: string[] }>({ name: '', scopes: [] });
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  if (!enabled) return <Card><EmptyState icon={<KeyRound className="h-6 w-6" />} title="The public API is on the Enterprise plan" description="Connect your website, CRM or other tools to TherapyOS with scoped API keys." /></Card>;
  if (isLoading || !data) return <LoadingBlock />;
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ key: string }>('/api-keys', form);
      setCreated(r.key);
      setCreating(false);
      setForm({ name: '', scopes: [] });
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (!revoking) return;
    try {
      await api.delete(`/api-keys/${revoking.id}`);
      toast.success('Key revoked');
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRevoking(null);
    }
  };
  const label = (s: string) => data.scopes.find((x) => x.scope === s)?.label ?? s;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="API keys"
          description="Keys act on behalf of your business with only the scopes you grant. Treat them like passwords."
          actions={<div className="flex gap-2"><a href={data.docsUrl} target="_blank" rel="noreferrer"><Button variant="outline" size="sm"><ExternalLink className="h-4 w-4" /> API docs</Button></a><Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New key</Button></div>}
        />
        {data.keys.length ? (
          <Table>
            <THead><TR><TH>Name</TH><TH>Key</TH><TH>Scopes</TH><TH>Last used</TH><TH>Status</TH><TH /></TR></THead>
            <TBody>
              {data.keys.map((k) => (
                <TR key={k.id}>
                  <TD><p className="font-medium">{k.name}</p><p className="text-xs text-slate-500">Created {fmtDate(k.createdAt)}{k.createdByName ? ` by ${k.createdByName}` : ''}</p></TD>
                  <TD className="font-mono text-xs">{k.prefix}…</TD>
                  <TD className="max-w-xs"><div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} tone="gray">{label(s)}</Badge>)}</div></TD>
                  <TD className="text-xs">{k.lastUsedAt ? ago(k.lastUsedAt) : 'Never'}</TD>
                  <TD>{k.revokedAt ? <Badge tone="red">Revoked</Badge> : <Badge tone="green">Active</Badge>}</TD>
                  <TD className="text-right">{!k.revokedAt && <Button size="icon" variant="ghost" aria-label={`Revoke ${k.name}`} onClick={() => setRevoking(k)}><Trash2 className="h-4 w-4" /></Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState icon={<KeyRound className="h-6 w-6" />} title="No API keys yet" description="Create a key to connect another system." />}
      </Card>
      <Card>
        <CardHeader title="Quick start" />
        <CardContent>
          <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{`curl ${data.docsUrl.replace('/api/docs', '')}/api/v1/services \\\n  -H "x-api-key: tos_your_key"`}</pre>
        </CardContent>
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} size="md" title="New API key"
        footer={<><Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button><Button onClick={create} loading={busy} disabled={form.name.length < 2 || !form.scopes.length}>Create key</Button></>}>
        <div className="space-y-3">
          <Field label="Name" hint="Where the key is used, e.g. “Website booking widget”."><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Scopes">
            <div className="grid gap-1.5 sm:grid-cols-2">
              {data.scopes.map((s) => (
                <Checkbox key={s.scope} label={s.label} checked={form.scopes.includes(s.scope)} onChange={(e) => setForm({ ...form, scopes: e.target.checked ? [...form.scopes, s.scope] : form.scopes.filter((x) => x !== s.scope) })} />
              ))}
            </div>
          </Field>
        </div>
      </Modal>
      <Modal open={!!created} onClose={() => setCreated(null)} size="md" title="Copy your API key" description="This is the only time the full key is shown. Store it somewhere safe."
        footer={<Button onClick={() => setCreated(null)}>Done</Button>}>
        <div className="flex gap-2">
          <Input readOnly value={created ?? ''} className="font-mono text-xs" data-testid="new-api-key" />
          <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(created ?? ''); toast.success('Copied'); }} aria-label="Copy key"><Copy className="h-4 w-4" /></Button>
        </div>
      </Modal>
      <ConfirmDialog open={!!revoking} onClose={() => setRevoking(null)} onConfirm={revoke} danger title="Revoke key?" message={`Anything using “${revoking?.name}” stops working immediately.`} confirmLabel="Revoke" />
    </div>
  );
}
