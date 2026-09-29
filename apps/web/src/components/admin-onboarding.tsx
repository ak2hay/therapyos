'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Field, Input, Modal, Select } from '@therapyos/ui';
import { api, errorMessage, fieldErrors } from '@/lib/api';

export interface OwnerCredentials {
  title: string;
  loginUrl?: string;
  loginEmail?: string | null;
  temporaryPassword?: string | null;
  inviteLink?: string | null;
  inviteEmailed?: boolean;
  tenantId?: string;
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <div className="mt-0.5 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <code className="flex-1 break-all text-sm text-slate-900">{value}</code>
        <button type="button" aria-label={`Copy ${label}`} className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700" onClick={() => navigator.clipboard.writeText(value).then(() => toast.success('Copied'))}>
          <Copy className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** Shows sign-in details once; passwords and invite links cannot be retrieved later. */
export function CredentialsDialog({ creds, onClose, onOpenTenant }: { creds: OwnerCredentials; onClose: () => void; onOpenTenant?: () => void }) {
  const shareText = [
    creds.loginUrl && `Sign in: ${creds.loginUrl}`,
    creds.loginEmail && `Email: ${creds.loginEmail}`,
    creds.temporaryPassword && `Temporary password: ${creds.temporaryPassword}`,
    creds.inviteLink && `Set your password: ${creds.inviteLink}`,
  ].filter(Boolean).join('\n');
  return (
    <Modal open onClose={onClose} title={creds.title} description="Copy these details now. For security they are not shown again."
      footer={<>
        <Button variant="outline" onClick={() => navigator.clipboard.writeText(shareText).then(() => toast.success('Copied all details'))}>Copy all</Button>
        {onOpenTenant ? <Button onClick={onOpenTenant}>Open business</Button> : <Button onClick={onClose}>Done</Button>}
      </>}>
      <div className="space-y-3" data-testid="owner-credentials">
        {creds.loginUrl && <Secret label="Sign-in page" value={creds.loginUrl} />}
        {creds.loginEmail && <Secret label="Login email" value={creds.loginEmail} />}
        {creds.temporaryPassword && <Secret label="Temporary password" value={creds.temporaryPassword} />}
        {creds.inviteLink && <Secret label="Invitation link (valid 7 days)" value={creds.inviteLink} />}
        {creds.inviteLink && (
          <p className="text-xs text-slate-500">{creds.inviteEmailed ? 'We also emailed this link to the owner.' : 'The email could not be sent (email is not configured), so share this link with the owner yourself.'}</p>
        )}
        {creds.temporaryPassword && <p className="text-xs text-slate-500">Ask the owner to change the password from their profile after signing in.</p>}
      </div>
    </Modal>
  );
}

interface PlanOption {
  id: string;
  code: string;
  name: string;
  status: string;
}

const EMPTY = { businessName: '', ownerName: '', email: '', phone: '', planCode: '', billingCycle: 'MONTHLY', subscription: 'TRIAL', trialDays: '', activeUntil: '', access: 'INVITE' };

/** Manual onboarding: the owner finishes the setup wizard after the first sign-in. */
export function NewBusinessModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get<PlanOption[]>('/admin/plans') });
  const settings = useQuery({ queryKey: ['admin', 'platform-settings'], queryFn: () => api.get<{ trialPlanCode: string; trialDays: number }>('/admin/platform-settings') });
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<OwnerCredentials | null>(null);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const planCode = form.planCode || settings.data?.trialPlanCode || '';

  const submit = async () => {
    setBusy(true);
    setErrors({});
    try {
      const res = await api.post<{ tenantId: string; loginUrl: string; loginEmail: string; temporaryPassword: string | null; inviteLink: string | null; inviteEmailed: boolean }>('/admin/tenants', {
        businessName: form.businessName,
        ownerName: form.ownerName,
        email: form.email,
        phone: form.phone,
        planCode,
        billingCycle: form.billingCycle,
        subscription: form.subscription,
        access: form.access,
        ...(form.subscription === 'TRIAL' && form.trialDays ? { trialDays: Number(form.trialDays) } : {}),
        ...(form.subscription === 'ACTIVE' && form.activeUntil ? { activeUntil: form.activeUntil } : {}),
      });
      await qc.invalidateQueries({ queryKey: ['admin'] });
      setCreated({ title: `${form.businessName} is ready`, ...res });
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) return <CredentialsDialog creds={created} onClose={onClose} onOpenTenant={() => router.push(`/admin/tenants/${created.tenantId}`)} />;

  return (
    <Modal open onClose={onClose} size="lg" title="New business" description="Creates the business, the owner's login and the subscription. The owner completes the setup wizard after signing in."
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit} disabled={!form.businessName || !form.ownerName || !form.email || !form.phone || !planCode}>Create business</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Business name" error={errors.businessName} className="sm:col-span-2"><Input value={form.businessName} onChange={(e) => set('businessName', e.target.value)} placeholder="Serenity Wellness" /></Field>
        <Field label="Owner name" error={errors.ownerName}><Input value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} /></Field>
        <Field label="Owner phone" error={errors.phone}><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+9198xxxxxxxx" /></Field>
        <Field label="Owner email (login)" error={errors.email} className="sm:col-span-2"><Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Plan" error={errors.planCode}>
          <Select value={planCode} onChange={(e) => set('planCode', e.target.value)}>
            {(plans.data ?? []).filter((p) => p.status === 'ACTIVE').map((p) => <option key={p.id} value={p.code}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Billing cycle">
          <Select value={form.billingCycle} onChange={(e) => set('billingCycle', e.target.value)}>
            <option value="MONTHLY">Monthly</option>
            <option value="ANNUAL">Yearly</option>
          </Select>
        </Field>
        <Field label="Subscription">
          <Select value={form.subscription} onChange={(e) => set('subscription', e.target.value)}>
            <option value="TRIAL">Free trial</option>
            <option value="ACTIVE">Paid (collected offline)</option>
          </Select>
        </Field>
        {form.subscription === 'TRIAL' ? (
          <Field label="Trial length (days)" error={errors.trialDays} hint={settings.data ? `Default ${settings.data.trialDays} days` : undefined}>
            <Input type="number" min={1} max={365} value={form.trialDays} onChange={(e) => set('trialDays', e.target.value)} placeholder={settings.data ? String(settings.data.trialDays) : ''} />
          </Field>
        ) : (
          <Field label="Paid until" error={errors.activeUntil} hint="Defaults to one billing cycle from today.">
            <Input type="date" value={form.activeUntil} onChange={(e) => set('activeUntil', e.target.value)} />
          </Field>
        )}
        <Field label="Owner access" className="sm:col-span-2">
          <Select value={form.access} onChange={(e) => set('access', e.target.value)}>
            <option value="INVITE">Email an invitation link (owner sets their own password)</option>
            <option value="PASSWORD">Create a temporary password I will share</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
