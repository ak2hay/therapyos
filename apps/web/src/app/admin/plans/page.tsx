'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FEATURE_FLAG_KEYS } from '@therapyos/types';
import { Badge, Button, Card, CardContent, Checkbox, Field, Input, LoadingBlock, Modal, PageHeader, Select, Textarea } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { money, titleCase } from '@/lib/format';

interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthlyPrice: number;
  annualPrice: number;
  maxBranches: number;
  maxUsers: number;
  maxCustomers: number;
  features: string[];
  status: 'ACTIVE' | 'INACTIVE';
  sortOrder: number;
  providerPlanIds: { MONTHLY?: string; ANNUAL?: string } | null;
  subscribers: number;
  paying: number;
}
const EMPTY = { code: '', name: '', description: '', monthlyPrice: '', annualPrice: '', maxBranches: '1', maxUsers: '5', maxCustomers: '1000', features: [] as string[], status: 'ACTIVE', sortOrder: '0', rzpMonthly: '', rzpAnnual: '' };

function PlanModal({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(
    plan
      ? { code: plan.code, name: plan.name, description: plan.description ?? '', monthlyPrice: String(plan.monthlyPrice), annualPrice: String(plan.annualPrice), maxBranches: String(plan.maxBranches), maxUsers: String(plan.maxUsers), maxCustomers: String(plan.maxCustomers), features: plan.features, status: plan.status, sortOrder: String(plan.sortOrder), rzpMonthly: plan.providerPlanIds?.MONTHLY ?? '', rzpAnnual: plan.providerPlanIds?.ANNUAL ?? '' }
      : EMPTY,
  );
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async () => {
    setBusy(true);
    try {
      const { rzpMonthly, rzpAnnual, ...rest } = form;
      const body = { ...rest, providerPlanIds: { MONTHLY: rzpMonthly.trim(), ANNUAL: rzpAnnual.trim() } };
      if (plan) await api.patch(`/admin/plans/${plan.id}`, body);
      else await api.post('/admin/plans', body);
      toast.success(plan ? 'Plan updated' : 'Plan created');
      await qc.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={plan ? `Edit ${plan.name}` : 'New plan'}
      description={plan?.subscribers ? `${plan.subscribers} businesses are on this plan; limit and feature changes apply to them immediately.` : undefined}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit} disabled={!form.code || !form.name}>Save plan</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code"><Input value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="GROWTH" /></Field>
        <Field label="Name"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Status">
          <Select value={form.status} onChange={(e) => set('status', e.target.value)}>
            <option value="ACTIVE">Active (can be chosen)</option>
            <option value="INACTIVE">Retired</option>
          </Select>
        </Field>
        <Field label="Description" className="sm:col-span-3"><Textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Monthly price (₹)"><Input type="number" min={0} value={form.monthlyPrice} onChange={(e) => set('monthlyPrice', e.target.value)} /></Field>
        <Field label="Yearly price (₹)"><Input type="number" min={0} value={form.annualPrice} onChange={(e) => set('annualPrice', e.target.value)} /></Field>
        <Field label="Sort order"><Input type="number" value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} /></Field>
        <Field label="Max branches"><Input type="number" min={1} value={form.maxBranches} onChange={(e) => set('maxBranches', e.target.value)} /></Field>
        <Field label="Max staff"><Input type="number" min={1} value={form.maxUsers} onChange={(e) => set('maxUsers', e.target.value)} /></Field>
        <Field label="Max customers"><Input type="number" min={1} value={form.maxCustomers} onChange={(e) => set('maxCustomers', e.target.value)} /></Field>
        <Field label="Razorpay plan id (monthly)" hint="From Razorpay → Subscriptions → Plans, e.g. plan_Nx…"><Input value={form.rzpMonthly} onChange={(e) => set('rzpMonthly', e.target.value)} placeholder="plan_…" /></Field>
        <Field label="Razorpay plan id (yearly)" hint="Leave blank if yearly billing is not offered online."><Input value={form.rzpAnnual} onChange={(e) => set('rzpAnnual', e.target.value)} placeholder="plan_…" /></Field>
        <div className="hidden sm:block" />
        <Field label="Included features" className="sm:col-span-3">
          <div className="grid gap-1.5 sm:grid-cols-3">
            {FEATURE_FLAG_KEYS.map((k) => (
              <Checkbox key={k} label={titleCase(k.replace(/_ENABLED$/, ''))} checked={form.features.includes(k)} onChange={(e) => setForm((f) => ({ ...f, features: e.target.checked ? [...f.features, k] : f.features.filter((x) => x !== k) }))} />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

export default function AdminPlansPage() {
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get<Plan[]>('/admin/plans') });
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader title="Plans" description="Pricing, limits and the features each plan unlocks." actions={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> New plan</Button>} />
      {isLoading || !data ? <LoadingBlock /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {data.map((p) => (
            <Card key={p.id} data-testid="admin-plan" className={p.status !== 'ACTIVE' ? 'opacity-60' : ''}>
              <CardContent className="space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-semibold text-slate-900">{p.name} <span className="text-xs font-normal text-slate-500">{p.code}</span></p>
                    <p className="text-xl font-semibold">{money(p.monthlyPrice)}<span className="text-xs font-normal text-slate-500">/mo · {money(p.annualPrice)}/yr</span></p>
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}><Pencil className="h-4 w-4" /></Button>
                </div>
                <p className="text-xs text-slate-600">{p.maxBranches} branches · {p.maxUsers} staff · {p.maxCustomers.toLocaleString()} customers</p>
                <div className="flex flex-wrap gap-1">{p.features.map((f) => <Badge key={f} tone="brand">{titleCase(f.replace(/_ENABLED$/, ''))}</Badge>)}</div>
                <p className="border-t border-slate-100 pt-2 text-xs text-slate-500">{p.subscribers} businesses · {p.paying} paying{p.status !== 'ACTIVE' ? ' · retired' : ''}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing && <PlanModal plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
