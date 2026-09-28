'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea } from '@therapyos/ui';
import { CUSTOMER_SOURCES } from '@therapyos/types';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { titleCase } from '@/lib/format';
import { useBranches } from '@/lib/queries';
import { useBranch } from '@/lib/branch-store';

export interface CustomerRecord {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  customerCode: string;
  gender: string | null;
  dob: string | null;
  address: string | null;
  city: string | null;
  source: string;
  status: string;
  notes: string | null;
  tags: string[];
  primaryBranchId: string | null;
  marketingOptIn: boolean;
  whatsappOptIn: boolean;
}

export function CustomerFormModal({
  open,
  onClose,
  customer,
  seed,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customer?: CustomerRecord | null;
  seed?: { name?: string; phone?: string };
  onSaved: (c: CustomerRecord) => void;
}) {
  const { data: branches } = useBranches();
  const selectedBranch = useBranch((s) => s.branchId);
  const [form, setForm] = useState(() => ({
    name: customer?.name ?? seed?.name ?? '',
    phone: customer?.phone ?? seed?.phone ?? '',
    email: customer?.email ?? '',
    gender: customer?.gender ?? '',
    dob: customer?.dob?.slice(0, 10) ?? '',
    city: customer?.city ?? '',
    address: customer?.address ?? '',
    source: customer?.source ?? 'WALK_IN',
    primaryBranchId: customer?.primaryBranchId ?? selectedBranch ?? '',
    tags: customer?.tags.join(', ') ?? '',
    notes: customer?.notes ?? '',
    status: customer?.status ?? 'ACTIVE',
    marketingOptIn: customer?.marketingOptIn ?? false,
    whatsappOptIn: customer?.whatsappOptIn ?? true,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const body = {
        ...form,
        tags: form.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        status: customer ? form.status : undefined,
      };
      const res = customer ? await api.patch<CustomerRecord>(`/customers/${customer.id}`, body) : await api.post<CustomerRecord>('/customers', body);
      toast.success(customer ? 'Customer updated' : `Customer ${res.customerCode} created`);
      onSaved(res);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={customer ? `Edit ${customer.name}` : 'New customer'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy}>{customer ? 'Save changes' : 'Create customer'}</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" error={errors.name}><Input autoFocus value={form.name} onChange={set('name')} /></Field>
        <Field label="Mobile number" error={errors.phone} hint="With country code, e.g. +919876543210"><Input value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Email" error={errors.email}><Input type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Gender">
          <Select value={form.gender} onChange={set('gender')}>
            <option value="">Prefer not to say</option>
            <option value="FEMALE">Female</option>
            <option value="MALE">Male</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="Date of birth" hint="Used for birthday offers"><Input type="date" value={form.dob} onChange={set('dob')} /></Field>
        <Field label="How did they hear about us?">
          <Select value={form.source} onChange={set('source')}>
            {CUSTOMER_SOURCES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </Field>
        <Field label="Home branch">
          <Select value={form.primaryBranchId} onChange={set('primaryBranchId')}>
            <option value="">None</option>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={form.address} onChange={set('address')} /></Field>
        <Field label="Tags" hint="Comma separated, e.g. corporate, prefers-female-therapist" className="sm:col-span-2"><Input value={form.tags} onChange={set('tags')} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={form.notes} onChange={set('notes')} /></Field>
        {customer && (
          <Field label="Status">
            <Select value={form.status} onChange={set('status')}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="BLOCKED">Blocked</option>
            </Select>
          </Field>
        )}
        <div className="space-y-2 sm:col-span-2">
          <Checkbox label="Send appointment updates on WhatsApp" checked={form.whatsappOptIn} onChange={(e) => setForm((f) => ({ ...f, whatsappOptIn: e.target.checked }))} />
          <Checkbox label="Agrees to receive offers and promotions" checked={form.marketingOptIn} onChange={(e) => setForm((f) => ({ ...f, marketingOptIn: e.target.checked }))} />
        </div>
      </div>
    </Modal>
  );
}
