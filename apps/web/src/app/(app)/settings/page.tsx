'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Table,
  Tabs,
  TBody,
  TD,
  TH,
  THead,
  Textarea,
  TR,
} from '@therapyos/ui';
import { BUSINESS_TYPES, FEATURE_FLAG_KEYS, PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, refreshSession, useAuth } from '@/lib/auth-store';
import { fmtDateTime, titleCase } from '@/lib/format';
import { BrandingTab, DeveloperTab, SubscriptionTab } from './extra-tabs';
import { NotificationsTab } from './notifications-tab';

type TabKey = 'business' | 'operations' | 'tax' | 'features' | 'notifications' | 'subscription' | 'branding' | 'developer' | 'audit';

interface Tenant {
  name: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  taxId: string | null;
  businessType: string | null;
  timezone: string;
  currency: string;
  country: string;
  logoUrl: string | null;
}

function BusinessTab({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading } = useQuery({ queryKey: ['tenant'], queryFn: () => api.get<Tenant>('/tenant') });
  const [form, setForm] = useState<Partial<Tenant>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  if (isLoading) return <LoadingBlock />;
  const set = (k: keyof Tenant) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      const { name, legalName, email, phone, address, taxId, businessType, timezone, currency, country, logoUrl } = form;
      await api.patch('/tenant', { name, legalName, email, phone, address, taxId, businessType, timezone, currency, country, logoUrl });
      toast.success('Business profile saved');
      await refreshSession();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Business profile" description="Shown on invoices, receipts and customer messages." />
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Business name"><Input value={form.name ?? ''} onChange={set('name')} disabled={!canEdit} /></Field>
        <Field label="Legal name"><Input value={form.legalName ?? ''} onChange={set('legalName')} disabled={!canEdit} /></Field>
        <Field label="Business type">
          <Select value={form.businessType ?? ''} onChange={set('businessType')} disabled={!canEdit}>
            <option value="">Select</option>
            {BUSINESS_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </Select>
        </Field>
        <Field label="GSTIN / Tax ID"><Input value={form.taxId ?? ''} onChange={set('taxId')} disabled={!canEdit} /></Field>
        <Field label="Email"><Input value={form.email ?? ''} onChange={set('email')} disabled={!canEdit} /></Field>
        <Field label="Phone"><Input value={form.phone ?? ''} onChange={set('phone')} disabled={!canEdit} /></Field>
        <Field label="Address" className="sm:col-span-2"><Textarea value={form.address ?? ''} onChange={set('address')} disabled={!canEdit} /></Field>
        <Field label="Timezone"><Input value={form.timezone ?? ''} onChange={set('timezone')} disabled={!canEdit} /></Field>
        <Field label="Currency"><Input value={form.currency ?? ''} onChange={set('currency')} maxLength={3} disabled={!canEdit} /></Field>
        <Field label="Logo URL" className="sm:col-span-2"><Input value={form.logoUrl ?? ''} onChange={set('logoUrl')} disabled={!canEdit} /></Field>
        {canEdit && <div className="sm:col-span-2"><Button onClick={save} loading={busy}>Save profile</Button></div>}
      </CardContent>
    </Card>
  );
}

const SETTING_FIELDS: { key: string; label: string; type: 'number' | 'text' | 'bool' | 'select'; options?: string[]; hint?: string }[] = [
  { key: 'INVOICE_PREFIX', label: 'Invoice prefix', type: 'text' },
  { key: 'TAX_MODE', label: 'Service prices are', type: 'select', options: ['EXCLUSIVE', 'INCLUSIVE'], hint: 'Whether listed prices include tax' },
  { key: 'ROUNDING', label: 'Invoice rounding', type: 'select', options: ['NONE', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10'] },
  { key: 'DEFAULT_APPOINTMENT_DURATION', label: 'Default appointment duration (min)', type: 'number' },
  { key: 'APPOINTMENT_BUFFER', label: 'Buffer between appointments (min)', type: 'number' },
  { key: 'SLOT_INTERVAL', label: 'Booking slot interval (min)', type: 'number' },
  { key: 'REMINDER_HOURS_BEFORE', label: 'Send reminder (hours before)', type: 'number' },
  { key: 'PACKAGE_EXPIRY_REMINDER_DAYS', label: 'Package expiry reminder (days before)', type: 'number' },
  { key: 'MEMBERSHIP_EXPIRY_REMINDER_DAYS', label: 'Membership renewal reminder (days before)', type: 'number' },
  { key: 'INACTIVE_AFTER_DAYS', label: 'Mark customer inactive after (days)', type: 'number' },
  { key: 'CHURNED_AFTER_DAYS', label: 'Mark customer churned after (days)', type: 'number' },
  { key: 'VIP_LTV_THRESHOLD', label: 'VIP lifetime value threshold', type: 'number' },
  { key: 'CAMPAIGN_ATTRIBUTION_DAYS', label: 'Campaign attribution window (days)', type: 'number', hint: 'A paid invoice within this many days of a campaign message counts as a conversion' },
  { key: 'FEEDBACK_REQUEST_ENABLED', label: 'Ask for feedback after each session', type: 'bool' },
  { key: 'WHATSAPP_ENABLED', label: 'Send customer messages on WhatsApp (falls back to SMS when off)', type: 'bool' },
  { key: 'THERAPIST_CAN_VIEW_CUSTOMER_PHONE', label: 'Therapists can see customer phone numbers', type: 'bool' },
];

function OperationsTab({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Record<string, unknown>>('/settings') });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setValues(data);
  }, [data]);
  if (isLoading) return <LoadingBlock />;
  const save = async () => {
    setBusy(true);
    try {
      const payload = Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, f.type === 'number' ? Number(values[f.key]) : values[f.key]]));
      await api.patch('/settings', payload);
      toast.success('Settings saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Operational settings" />
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {SETTING_FIELDS.map((f) =>
          f.type === 'bool' ? (
            <Checkbox key={f.key} className="sm:col-span-2" label={f.label} checked={!!values[f.key]} disabled={!canEdit}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))} />
          ) : f.type === 'select' ? (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <Select value={String(values[f.key] ?? '')} disabled={!canEdit} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                {f.options!.map((o) => <option key={o} value={o}>{titleCase(o)}</option>)}
              </Select>
            </Field>
          ) : (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <Input type={f.type} value={String(values[f.key] ?? '')} disabled={!canEdit} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            </Field>
          ),
        )}
        {canEdit && <div className="sm:col-span-2"><Button onClick={save} loading={busy}>Save settings</Button></div>}
      </CardContent>
    </Card>
  );
}

interface TaxRate {
  id: string;
  name: string;
  rate: number;
  type: 'GST' | 'VAT' | 'SALES_TAX' | 'OTHER';
  isInclusive: boolean;
  isDefault: boolean;
  status: string;
}

function TaxTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['tax-rates'], queryFn: () => api.get<TaxRate[]>('/tax-rates') });
  const [editing, setEditing] = useState<Partial<TaxRate> | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const body = { name: editing.name, rate: Number(editing.rate), type: editing.type ?? 'GST', isInclusive: !!editing.isInclusive, isDefault: !!editing.isDefault, status: editing.status ?? 'ACTIVE' };
      if (editing.id) await api.patch(`/tax-rates/${editing.id}`, body);
      else await api.post('/tax-rates', body);
      await qc.invalidateQueries({ queryKey: ['tax-rates'] });
      setEditing(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Tax rates" description="Assign a tax rate to each service and product." actions={canEdit && <Button size="sm" onClick={() => setEditing({ type: 'GST' })}><Plus className="h-4 w-4" /> Add rate</Button>} />
      {isLoading ? <LoadingBlock /> : (
        <Table>
          <THead><TR><TH>Name</TH><TH>Rate</TH><TH>Type</TH><TH>Status</TH><TH /></TR></THead>
          <TBody>
            {data?.map((t) => (
              <TR key={t.id}>
                <TD className="font-medium">{t.name} {t.isDefault && <Badge tone="brand" className="ml-1">Default</Badge>}</TD>
                <TD>{t.rate}%</TD>
                <TD>{t.type}{t.isInclusive ? ' (inclusive)' : ''}</TD>
                <TD><StatusBadge status={t.status} /></TD>
                <TD className="text-right">{canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing(t)}><Pencil className="h-4 w-4" /></Button>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit tax rate' : 'New tax rate'} size="sm"
        footer={<><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save} loading={busy}>Save</Button></>}>
        {editing && (
          <div className="space-y-3">
            <Field label="Name"><Input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="GST 18%" /></Field>
            <Field label="Rate (%)"><Input type="number" step="0.01" value={editing.rate ?? ''} onChange={(e) => setEditing({ ...editing, rate: e.target.value as unknown as number })} /></Field>
            <Field label="Type">
              <Select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as TaxRate['type'] })}>
                {['GST', 'VAT', 'SALES_TAX', 'OTHER'].map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={editing.status ?? 'ACTIVE'} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option>
              </Select>
            </Field>
            <Checkbox label="Default for new services" checked={!!editing.isDefault} onChange={(e) => setEditing({ ...editing, isDefault: e.target.checked })} />
          </div>
        )}
      </Modal>
    </Card>
  );
}

function FeaturesTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['features'],
    queryFn: () => api.get<{ effective: string[]; overrides: { key: string; enabled: boolean }[]; plan: string }>('/features'),
  });
  const { data: usage } = useQuery({
    queryKey: ['tenant-usage'],
    queryFn: () =>
      api.get<{
        limits: { planCode: string; planName: string; branches: number; users: number; customers: number | null; planFeatures: string[] };
        usage: { branches: number; users: number; customers: number };
      }>('/tenant/usage'),
  });
  if (isLoading || !data) return <LoadingBlock />;
  const toggle = async (key: string, enabled: boolean) => {
    try {
      await api.put('/feature-flags', { key, enabled });
      await qc.invalidateQueries({ queryKey: ['features'] });
      await refreshSession();
      toast.success(`${titleCase(key)} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader title={`Plan: ${usage?.limits.planName ?? titleCase(data.plan ?? '')}`} description="Usage against plan limits" />
        <CardContent className="space-y-3 text-sm">
          {usage && (
            <>
              <UsageRow label="Branches" used={usage.usage.branches} limit={usage.limits.branches} />
              <UsageRow label="Staff users" used={usage.usage.users} limit={usage.limits.users} />
              <UsageRow label="Customers" used={usage.usage.customers} limit={usage.limits.customers} />
            </>
          )}
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="Modules" description="Turn modules on or off for your business. Locked modules need a plan upgrade." />
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {FEATURE_FLAG_KEYS.map((key) => {
            const inPlan = usage?.limits.planFeatures.includes(key) ?? true;
            const on = data.effective.includes(key);
            return (
              <div key={key} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-slate-800">{titleCase(key.replace(/_ENABLED$/, ''))}</p>
                  {!inPlan && <p className="text-xs text-amber-600">Upgrade required</p>}
                </div>
                <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={on} disabled={!canEdit || (!inPlan && !on)} onChange={(e) => toggle(key, e.target.checked)} />
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function UsageRow({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between"><span>{label}</span><span className="text-slate-500">{used} / {limit ?? 'Unlimited'}</span></div>
      {limit ? <div className="mt-1 h-1.5 rounded bg-slate-100"><div className={`h-1.5 rounded ${pct > 90 ? 'bg-rose-500' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} /></div> : null}
    </div>
  );
}

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  userName: string | null;
  ipAddress: string | null;
  createdAt: string;
  oldValues: unknown;
  newValues: unknown;
}

function AuditTab() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<AuditRow | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['audit', page, search],
    queryFn: () => api.page<AuditRow>('/audit-logs', { page, search, pageSize: 30 }),
  });
  return (
    <Card>
      <div className="border-b border-slate-100 p-3">
        <Input className="max-w-xs" placeholder="Filter by action e.g. INVOICE" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>
      {isLoading ? <LoadingBlock /> : (
        <>
          <Table>
            <THead><TR><TH>When</TH><TH>User</TH><TH>Action</TH><TH>Entity</TH><TH>IP</TH><TH /></TR></THead>
            <TBody>
              {data?.items.map((a) => (
                <TR key={a.id}>
                  <TD className="whitespace-nowrap text-xs">{fmtDateTime(a.createdAt)}</TD>
                  <TD>{a.userName ?? 'System'}</TD>
                  <TD><Badge>{a.action}</Badge></TD>
                  <TD className="text-xs">{a.entityType}</TD>
                  <TD className="text-xs text-slate-500">{a.ipAddress}</TD>
                  <TD><Button size="sm" variant="ghost" onClick={() => setOpen(a)}>Details</Button></TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={data?.meta.totalPages ?? 1} onChange={setPage} />
        </>
      )}
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.action} size="lg">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><p className="mb-1 text-xs font-semibold text-slate-500">Before</p><pre className="max-h-96 overflow-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(open?.oldValues, null, 2)}</pre></div>
          <div><p className="mb-1 text-xs font-semibold text-slate-500">After</p><pre className="max-h-96 overflow-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(open?.newValues, null, 2)}</pre></div>
        </div>
      </Modal>
    </Card>
  );
}

const TAB_KEYS: TabKey[] = ['business', 'operations', 'tax', 'features', 'notifications', 'subscription', 'branding', 'developer', 'audit'];

export default function SettingsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <SettingsInner />
    </Suspense>
  );
}

function SettingsInner() {
  const user = useAuth((s) => s.user);
  const requested = useSearchParams().get('tab') as TabKey | null;
  const [tab, setTab] = useState<TabKey>(requested && TAB_KEYS.includes(requested) ? requested : 'business');
  const tabs: { value: TabKey; label: string; show: boolean }[] = [
    { value: 'business', label: 'Business', show: true },
    { value: 'operations', label: 'Operations', show: true },
    { value: 'tax', label: 'Tax rates', show: true },
    { value: 'features', label: 'Plan & modules', show: true },
    { value: 'notifications', label: 'Notifications', show: hasPermission(user, PERMISSIONS.NOTIFICATION_MANAGE) },
    { value: 'subscription', label: 'Subscription', show: hasPermission(user, PERMISSIONS.SUBSCRIPTION_MANAGE) },
    { value: 'branding', label: 'Branding', show: hasPermission(user, PERMISSIONS.BRANDING_MANAGE) },
    { value: 'developer', label: 'API keys', show: hasPermission(user, PERMISSIONS.API_KEY_MANAGE) },
    { value: 'audit', label: 'Audit log', show: hasPermission(user, PERMISSIONS.AUDIT_READ) },
  ];
  const canTenant = hasPermission(user, PERMISSIONS.TENANT_UPDATE);
  const canSettings = hasPermission(user, PERMISSIONS.SETTINGS_MANAGE);
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs className="mb-6" value={tab} onChange={setTab} tabs={tabs.filter((t) => t.show)} />
      {tab === 'business' && <BusinessTab canEdit={canTenant} />}
      {tab === 'operations' && <OperationsTab canEdit={canSettings} />}
      {tab === 'tax' && <TaxTab canEdit={canSettings} />}
      {tab === 'features' && <FeaturesTab canEdit={canSettings} />}
      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'subscription' && <SubscriptionTab />}
      {tab === 'branding' && <BrandingTab />}
      {tab === 'developer' && <DeveloperTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}
