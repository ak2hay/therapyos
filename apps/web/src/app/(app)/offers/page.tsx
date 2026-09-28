'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, Tag, TicketPercent } from 'lucide-react';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, LoadingBlock, Modal, PageHeader, Select, Table, Tabs, TBody, TD, Textarea, TH, THead, TR } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { fmtDate, money, todayIso } from '@/lib/format';
import { useBranches, useServices } from '@/lib/queries';

type AppliesTo = 'ALL' | 'SERVICE' | 'CATEGORY' | 'PRODUCT' | 'PACKAGE' | 'MEMBERSHIP';
interface Offer {
  id: string;
  name: string;
  description: string | null;
  offerType: 'PERCENTAGE' | 'FIXED' | 'BUY_ONE_GET_ONE' | 'PACKAGE_BONUS' | 'MEMBERSHIP_BONUS';
  value: number;
  appliesTo: AppliesTo;
  targetIds: string[];
  branchIds: string[];
  minOrder: number | null;
  startDate: string;
  endDate: string;
  autoApply: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  redemptions: number;
  discountGiven: number;
  live: boolean;
}
interface Coupon {
  id: string;
  code: string;
  description: string | null;
  discountType: 'PERCENTAGE' | 'FIXED';
  discountValue: number;
  minimumOrder: number | null;
  maximumDiscount: number | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usedCount: number;
  startDate: string;
  endDate: string;
  status: 'ACTIVE' | 'INACTIVE';
  discountGiven: number;
  live: boolean;
}
interface Named {
  id: string;
  name: string;
}

const OFFER_TYPE_LABEL: Record<Offer['offerType'], string> = {
  PERCENTAGE: 'Percentage off',
  FIXED: 'Flat amount off',
  BUY_ONE_GET_ONE: 'Buy one get one',
  PACKAGE_BONUS: 'Package bonus',
  MEMBERSHIP_BONUS: 'Membership bonus',
};
const APPLIES_LABEL: Record<AppliesTo, string> = {
  ALL: 'Whole bill',
  SERVICE: 'Specific services',
  CATEGORY: 'Service categories',
  PRODUCT: 'Specific products',
  PACKAGE: 'Specific packages',
  MEMBERSHIP: 'Specific membership plans',
};
const day = (d: string) => d.slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function useTargets(appliesTo: AppliesTo): Named[] {
  const { data: services } = useServices();
  const { data: categories } = useQuery({ queryKey: ['service-categories'], queryFn: () => api.get<Named[]>('/service-categories'), enabled: appliesTo === 'CATEGORY' });
  const { data: packages } = useQuery({ queryKey: ['packages', 'catalogue'], queryFn: () => api.get<Named[]>('/packages'), enabled: appliesTo === 'PACKAGE' });
  const { data: plans } = useQuery({ queryKey: ['membership-plans'], queryFn: () => api.get<Named[]>('/membership-plans'), enabled: appliesTo === 'MEMBERSHIP' });
  const { data: products } = useQuery({ queryKey: ['products', 'all'], queryFn: () => api.get<Named[]>('/products', { all: 'true' }), enabled: appliesTo === 'PRODUCT' });
  return { ALL: [], SERVICE: services ?? [], CATEGORY: categories ?? [], PACKAGE: packages ?? [], MEMBERSHIP: plans ?? [], PRODUCT: products ?? [] }[appliesTo];
}

function describeOffer(o: Pick<Offer, 'offerType' | 'value' | 'minOrder'>) {
  const base = o.offerType === 'PERCENTAGE' ? `${o.value}% off` : o.offerType === 'FIXED' ? `${money(o.value)} off` : OFFER_TYPE_LABEL[o.offerType];
  return o.minOrder ? `${base} on bills above ${money(o.minOrder)}` : base;
}

function OfferForm({ existing, onDone }: { existing?: Offer; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: branches } = useBranches();
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    offerType: existing?.offerType ?? 'PERCENTAGE',
    value: existing ? String(existing.value) : '10',
    appliesTo: existing?.appliesTo ?? ('ALL' as AppliesTo),
    minOrder: existing?.minOrder != null ? String(existing.minOrder) : '',
    startDate: existing ? day(existing.startDate) : todayIso(),
    endDate: existing ? day(existing.endDate) : plusDays(30),
    autoApply: existing?.autoApply ?? true,
    status: existing?.status ?? 'ACTIVE',
  });
  const [targetIds, setTargetIds] = useState<string[]>(existing?.targetIds ?? []);
  const [branchIds, setBranchIds] = useState<string[]>(existing?.branchIds ?? []);
  const [busy, setBusy] = useState(false);
  const targets = useTargets(form.appliesTo);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const needsValue = form.offerType === 'PERCENTAGE' || form.offerType === 'FIXED';

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        ...form,
        value: needsValue ? Number(form.value) : 0,
        minOrder: form.minOrder === '' ? undefined : Number(form.minOrder),
        targetIds: form.appliesTo === 'ALL' ? [] : targetIds,
        branchIds,
      };
      if (existing) await api.patch(`/offers/${existing.id}`, body);
      else await api.post('/offers', body);
      await qc.invalidateQueries({ queryKey: ['offers'] });
      toast.success('Offer saved');
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
        <Field label="Offer name" className="sm:col-span-2"><Input value={form.name} onChange={set('name')} placeholder="e.g. Ayurveda Week" /></Field>
        <Field label="Type">
          <Select value={form.offerType} onChange={set('offerType')}>
            {Object.entries(OFFER_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        {needsValue && <Field label={form.offerType === 'PERCENTAGE' ? 'Discount (%)' : 'Discount amount'}><Input type="number" min={0} step="0.01" value={form.value} onChange={set('value')} /></Field>}
        <Field label="Applies to">
          <Select value={form.appliesTo} onChange={(e) => { setForm((f) => ({ ...f, appliesTo: e.target.value as AppliesTo })); setTargetIds([]); }}>
            {Object.entries(APPLIES_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Minimum bill (optional)"><Input type="number" min={0} step="0.01" value={form.minOrder} onChange={set('minOrder')} /></Field>
        <Field label="Starts"><Input type="date" value={form.startDate} onChange={set('startDate')} /></Field>
        <Field label="Ends"><Input type="date" value={form.endDate} onChange={set('endDate')} /></Field>
        <Field label="Status">
          <Select value={form.status} onChange={set('status')}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Paused</option>
          </Select>
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox label="Apply automatically at the POS" checked={form.autoApply} onChange={(e) => setForm((f) => ({ ...f, autoApply: e.target.checked }))} />
        </div>
        <Field label="Description" className="sm:col-span-2"><Textarea value={form.description} onChange={set('description')} /></Field>
      </div>
      {form.appliesTo !== 'ALL' && (
        <div>
          <p className="mb-2 text-xs font-medium text-slate-600">{APPLIES_LABEL[form.appliesTo]}</p>
          <div className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-2">
            {targets.map((t) => <Checkbox key={t.id} label={t.name} checked={targetIds.includes(t.id)} onChange={() => setTargetIds((p) => toggle(p, t.id))} />)}
            {!targets.length && <p className="text-sm text-slate-500">Nothing to choose from yet.</p>}
          </div>
        </div>
      )}
      {(branches?.length ?? 0) > 1 && (
        <div>
          <p className="mb-2 text-xs font-medium text-slate-600">Branches (leave all unticked for every branch)</p>
          <div className="flex flex-wrap gap-4">
            {branches?.map((b) => <Checkbox key={b.id} label={b.name} checked={branchIds.includes(b.id)} onChange={() => setBranchIds((p) => toggle(p, b.id))} />)}
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button onClick={save} loading={busy} disabled={!form.name || (form.appliesTo !== 'ALL' && !targetIds.length)}>Save offer</Button>
      </div>
    </div>
  );
}

function CouponForm({ existing, onDone }: { existing?: Coupon; onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    code: existing?.code ?? '',
    description: existing?.description ?? '',
    discountType: existing?.discountType ?? 'PERCENTAGE',
    discountValue: existing ? String(existing.discountValue) : '10',
    minimumOrder: existing?.minimumOrder != null ? String(existing.minimumOrder) : '',
    maximumDiscount: existing?.maximumDiscount != null ? String(existing.maximumDiscount) : '',
    usageLimit: existing?.usageLimit != null ? String(existing.usageLimit) : '',
    perCustomerLimit: existing?.perCustomerLimit != null ? String(existing.perCustomerLimit) : '1',
    startDate: existing ? day(existing.startDate) : todayIso(),
    endDate: existing ? day(existing.endDate) : plusDays(30),
    status: existing?.status ?? 'ACTIVE',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const opt = (v: string) => (v === '' ? undefined : Number(v));

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        ...form,
        code: form.code.trim().toUpperCase(),
        discountValue: Number(form.discountValue),
        minimumOrder: opt(form.minimumOrder),
        maximumDiscount: form.discountType === 'PERCENTAGE' ? opt(form.maximumDiscount) : undefined,
        usageLimit: opt(form.usageLimit),
        perCustomerLimit: opt(form.perCustomerLimit),
      };
      if (existing) await api.patch(`/coupons/${existing.id}`, body);
      else await api.post('/coupons', body);
      await qc.invalidateQueries({ queryKey: ['coupons'] });
      toast.success('Coupon saved');
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
        <Field label="Code" hint="Letters, numbers, - and _"><Input value={form.code} onChange={set('code')} className="uppercase" placeholder="WELCOME10" /></Field>
        <Field label="Status">
          <Select value={form.status} onChange={set('status')}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Paused</option>
          </Select>
        </Field>
        <Field label="Discount type">
          <Select value={form.discountType} onChange={set('discountType')}>
            <option value="PERCENTAGE">Percentage</option>
            <option value="FIXED">Flat amount</option>
          </Select>
        </Field>
        <Field label={form.discountType === 'PERCENTAGE' ? 'Discount (%)' : 'Discount amount'}><Input type="number" min={0} step="0.01" value={form.discountValue} onChange={set('discountValue')} /></Field>
        <Field label="Minimum bill (optional)"><Input type="number" min={0} value={form.minimumOrder} onChange={set('minimumOrder')} /></Field>
        {form.discountType === 'PERCENTAGE' && <Field label="Maximum discount (optional)"><Input type="number" min={0} value={form.maximumDiscount} onChange={set('maximumDiscount')} /></Field>}
        <Field label="Total uses (blank = unlimited)"><Input type="number" min={1} value={form.usageLimit} onChange={set('usageLimit')} /></Field>
        <Field label="Uses per customer"><Input type="number" min={1} value={form.perCustomerLimit} onChange={set('perCustomerLimit')} /></Field>
        <Field label="Starts"><Input type="date" value={form.startDate} onChange={set('startDate')} /></Field>
        <Field label="Ends"><Input type="date" value={form.endDate} onChange={set('endDate')} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea value={form.description} onChange={set('description')} /></Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button onClick={save} loading={busy} disabled={form.code.trim().length < 3 || form.discountValue === ''}>Save coupon</Button>
      </div>
    </div>
  );
}

function LiveBadge({ live, status, endDate }: { live: boolean; status: string; endDate: string }) {
  if (live) return <Badge tone="green">Live</Badge>;
  if (status !== 'ACTIVE') return <Badge>Paused</Badge>;
  if (day(endDate) < todayIso()) return <Badge tone="red">Expired</Badge>;
  return <Badge tone="blue">Scheduled</Badge>;
}

function OffersTab({ canManage }: { canManage: boolean }) {
  const [editing, setEditing] = useState<Offer | null | undefined>(undefined);
  const { data, isLoading } = useQuery({ queryKey: ['offers'], queryFn: () => api.get<Offer[]>('/offers') });
  return (
    <Card>
      {canManage && (
        <div className="flex justify-end border-b border-slate-100 p-3">
          <Button size="sm" onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> New offer</Button>
        </div>
      )}
      {isLoading ? (
        <LoadingBlock />
      ) : !data?.length ? (
        <EmptyState icon={<Tag className="h-6 w-6" />} title="No offers yet" description="Automatic offers apply at the POS without any code." />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Offer</TH>
              <TH>Applies to</TH>
              <TH>Runs</TH>
              <TH className="text-right">Used</TH>
              <TH className="text-right">Discount given</TH>
              <TH />
              <TH />
            </TR>
          </THead>
          <TBody>
            {data.map((o) => (
              <TR key={o.id}>
                <TD>
                  <p className="font-medium text-slate-900">{o.name}</p>
                  <p className="text-xs text-slate-500">{describeOffer(o)}{!o.autoApply && ' · manual'}</p>
                </TD>
                <TD className="text-slate-600">{APPLIES_LABEL[o.appliesTo]}{o.targetIds.length > 0 && ` (${o.targetIds.length})`}</TD>
                <TD className="text-slate-600">{fmtDate(o.startDate)} to {fmtDate(o.endDate)}</TD>
                <TD className="text-right tabular-nums">{o.redemptions}</TD>
                <TD className="text-right tabular-nums">{money(o.discountGiven)}</TD>
                <TD><LiveBadge live={o.live} status={o.status} endDate={o.endDate} /></TD>
                <TD className="text-right">{canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(o)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? `Edit ${editing.name}` : 'New offer'} size="lg">
        {editing !== undefined && <OfferForm existing={editing ?? undefined} onDone={() => setEditing(undefined)} />}
      </Modal>
    </Card>
  );
}

function CouponsTab({ canManage }: { canManage: boolean }) {
  const [editing, setEditing] = useState<Coupon | null | undefined>(undefined);
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['coupons'], queryFn: () => api.get<Coupon[]>('/coupons') });
  const rows = (data ?? []).filter((c) => !search || c.code.includes(search.trim().toUpperCase()));
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 p-3">
        <Input className="max-w-xs" placeholder="Search codes" value={search} onChange={(e) => setSearch(e.target.value)} />
        {canManage && <Button size="sm" onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> New coupon</Button>}
      </div>
      {isLoading ? (
        <LoadingBlock />
      ) : !rows.length ? (
        <EmptyState icon={<TicketPercent className="h-6 w-6" />} title="No coupons" description="Coupon codes are entered at the POS or shared in campaigns." />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Code</TH>
              <TH>Discount</TH>
              <TH>Valid</TH>
              <TH className="text-right">Used</TH>
              <TH className="text-right">Discount given</TH>
              <TH />
              <TH />
            </TR>
          </THead>
          <TBody>
            {rows.map((c) => (
              <TR key={c.id}>
                <TD>
                  <p className="font-mono font-medium text-slate-900">{c.code}</p>
                  {c.description && <p className="text-xs text-slate-500">{c.description}</p>}
                </TD>
                <TD className="text-slate-600">
                  {c.discountType === 'PERCENTAGE' ? `${c.discountValue}%` : money(c.discountValue)}
                  {c.maximumDiscount != null && ` (max ${money(c.maximumDiscount)})`}
                  {c.minimumOrder != null && <p className="text-xs text-slate-500">on bills above {money(c.minimumOrder)}</p>}
                </TD>
                <TD className="text-slate-600">{fmtDate(c.startDate)} to {fmtDate(c.endDate)}</TD>
                <TD className="text-right tabular-nums">{c.usedCount}{c.usageLimit ? ` / ${c.usageLimit}` : ''}</TD>
                <TD className="text-right tabular-nums">{money(c.discountGiven)}</TD>
                <TD>{c.usageLimit && c.usedCount >= c.usageLimit ? <Badge tone="amber">Used up</Badge> : <LiveBadge live={c.live} status={c.status} endDate={c.endDate} />}</TD>
                <TD className="text-right">{canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(c)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? `Edit ${editing.code}` : 'New coupon'} size="lg">
        {editing !== undefined && <CouponForm existing={editing ?? undefined} onDone={() => setEditing(undefined)} />}
      </Modal>
    </Card>
  );
}

export default function OffersPage() {
  const user = useAuth((s) => s.user);
  const [tab, setTab] = useState<'offers' | 'coupons'>('offers');
  const canManage = hasPermission(user, PERMISSIONS.OFFER_MANAGE);
  return (
    <div>
      <PageHeader title="Offers & coupons" description="Automatic promotions and codes customers can redeem at checkout" />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'offers', label: 'Offers' }, { value: 'coupons', label: 'Coupons' }]} />
      {tab === 'offers' ? <OffersTab canManage={canManage} /> : <CouponsTab canManage={canManage} />}
    </div>
  );
}
