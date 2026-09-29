'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { PlatformSettings } from '@therapyos/types';
import { Button, Card, CardContent, CardHeader, Checkbox, Field, Input, LoadingBlock, PageHeader, Select } from '@therapyos/ui';
import { api, errorMessage, fieldErrors } from '@/lib/api';

interface PlanOption {
  code: string;
  name: string;
  status: string;
}

export default function AdminPlatformSettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'platform-settings'], queryFn: () => api.get<PlatformSettings>('/admin/platform-settings') });
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get<PlanOption[]>('/admin/plans') });
  const [form, setForm] = useState<PlatformSettings | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (isLoading || !form) return <LoadingBlock />;
  const set = <K extends keyof PlatformSettings>(k: K, v: PlatformSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.put('/admin/platform-settings', form);
      toast.success('Platform settings saved');
      await qc.invalidateQueries({ queryKey: ['admin', 'platform-settings'] });
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Platform settings" description="Branding, sign-up rules, trials and defaults for new businesses." actions={<Button loading={busy} onClick={save}>Save changes</Button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="General" description="Shown on sign-up, emails and the support page." />
          <CardContent className="grid gap-3">
            <Field label="Platform name" error={errors.platformName}><Input value={form.platformName} onChange={(e) => set('platformName', e.target.value)} /></Field>
            <Field label="Support email" error={errors.supportEmail}><Input type="email" value={form.supportEmail} onChange={(e) => set('supportEmail', e.target.value)} placeholder="support@rkyves.com" /></Field>
            <Field label="Support phone" error={errors.supportPhone}><Input value={form.supportPhone} onChange={(e) => set('supportPhone', e.target.value)} placeholder="+91 98xxxxxxxx" /></Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Sign-up and trials" description="Turn off self sign-up to onboard businesses only from Tenants > New business." />
          <CardContent className="grid gap-3">
            <Checkbox label="Allow businesses to sign up on their own" checked={form.allowSelfSignup} onChange={(e) => set('allowSelfSignup', e.target.checked)} />
            <Field label="Trial plan" error={errors.trialPlanCode}>
              <Select value={form.trialPlanCode} onChange={(e) => set('trialPlanCode', e.target.value)}>
                {(plans.data ?? []).filter((p) => p.status === 'ACTIVE' || p.code === form.trialPlanCode).map((p) => <option key={p.code} value={p.code}>{p.name} ({p.code})</option>)}
                {!plans.data && <option value={form.trialPlanCode}>{form.trialPlanCode}</option>}
              </Select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Trial length (days)" error={errors.trialDays}><Input type="number" min={0} max={365} value={form.trialDays} onChange={(e) => set('trialDays', Number(e.target.value))} /></Field>
              <Field label="Grace period after expiry (days)" hint="Before the business is suspended." error={errors.subscriptionGraceDays}><Input type="number" min={0} max={90} value={form.subscriptionGraceDays} onChange={(e) => set('subscriptionGraceDays', Number(e.target.value))} /></Field>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Defaults for new businesses" description="Owners can change these during setup." />
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <Field label="Time zone" error={errors.defaultTimezone}><Input value={form.defaultTimezone} onChange={(e) => set('defaultTimezone', e.target.value)} placeholder="Asia/Kolkata" /></Field>
            <Field label="Currency" error={errors.defaultCurrency}><Input maxLength={3} value={form.defaultCurrency} onChange={(e) => set('defaultCurrency', e.target.value.toUpperCase())} placeholder="INR" /></Field>
            <Field label="Country" error={errors.defaultCountry}><Input maxLength={2} value={form.defaultCountry} onChange={(e) => set('defaultCountry', e.target.value.toUpperCase())} placeholder="IN" /></Field>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
