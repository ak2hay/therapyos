'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Plus, Trash2, Upload } from 'lucide-react';
import { Button, Card, CardContent, Checkbox, cn, Field, Input, LoadingBlock, Select, Textarea } from '@therapyos/ui';
import { BUSINESS_TYPES } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { refreshSession, useAuth } from '@/lib/auth-store';
import { money, titleCase } from '@/lib/format';

interface OnboardingState {
  currentStep: number;
  completed: boolean;
  steps: { step: number; key: string; title: string; optional: boolean }[];
  tenant: Record<string, string | null>;
  branches: { id: string; name: string; code: string; phone: string | null; address: string | null; city: string | null; openingTime: string; closingTime: string }[];
  services: { id: string; name: string; basePrice: number; taxRate: number; durationMinutes: number; category: { name: string } | null }[];
  therapists: { id: string; name: string }[];
  taxRates: { id: string; name: string; rate: number; isInclusive: boolean; isDefault: boolean }[];
  settings: { PAYMENT_PROVIDERS?: string[]; UPI_ID?: string; WHATSAPP_ENABLED?: boolean };
}
interface Template {
  categories: { name: string; services: { name: string; durationMinutes: number; basePrice: number }[] }[];
}

type StepProps = { state: OnboardingState; save: (data: Record<string, unknown>) => Promise<void>; busy: boolean };

function StepBusiness({ state, save, busy }: StepProps) {
  const [f, setF] = useState({
    name: state.tenant.name ?? '',
    legalName: state.tenant.legalName ?? '',
    phone: state.tenant.phone ?? '',
    email: state.tenant.email ?? '',
    businessType: state.tenant.businessType ?? '',
  });
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Business name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Legal name (for invoices)"><Input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
        <Field label="Business phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+91..." /></Field>
        <Field label="Business email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium text-slate-600">What kind of business do you run?</p>
        <div className="grid gap-2 sm:grid-cols-4">
          {BUSINESS_TYPES.map((t) => (
            <button key={t} onClick={() => setF({ ...f, businessType: t })}
              className={cn('rounded-lg border px-3 py-3 text-sm font-medium transition-colors', f.businessType === t ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-200 hover:border-slate-300')}>
              {titleCase(t)}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">This only sets up sensible defaults. You can offer any service later.</p>
      </div>
      <Button onClick={() => save(f)} loading={busy} disabled={!f.name || !f.businessType}>Continue</Button>
    </div>
  );
}

function StepLogo({ state, save, busy }: StepProps) {
  const [url, setUrl] = useState(state.tenant.logoUrl ?? '');
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('purpose', 'logo');
      const res = await api.post<{ url: string }>('/files', fd);
      setUrl(res.url);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-6">
        <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-slate-50">
          {url ? <img src={url} alt="Logo" className="h-full w-full object-contain" /> : <span className="text-xs text-slate-400">No logo</span>}
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
          <Upload className="h-4 w-4" /> {uploading ? 'Uploading...' : 'Upload logo'}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </div>
      <p className="text-xs text-slate-500">Shown on invoices, the booking page and customer messages. PNG or SVG, up to 5 MB.</p>
      <Button onClick={() => save({ logoUrl: url })} loading={busy}>Continue</Button>
    </div>
  );
}

function StepAddress({ state, save, busy }: StepProps) {
  const [f, setF] = useState({
    address: state.tenant.address ?? '',
    taxId: state.tenant.taxId ?? '',
    timezone: state.tenant.timezone ?? 'Asia/Kolkata',
    currency: state.tenant.currency ?? 'INR',
    country: state.tenant.country ?? 'IN',
  });
  return (
    <div className="space-y-4">
      <Field label="Registered address"><Textarea value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="GSTIN / Tax ID" hint="Printed on tax invoices"><Input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} /></Field>
        <Field label="Country">
          <Select value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>
            <option value="IN">India</option><option value="AE">UAE</option><option value="SG">Singapore</option><option value="US">United States</option><option value="GB">United Kingdom</option>
          </Select>
        </Field>
        <Field label="Timezone"><Input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
        <Field label="Currency">
          <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
            {['INR', 'AED', 'SGD', 'USD', 'GBP'].map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
      </div>
      <Button onClick={() => save(f)} loading={busy} disabled={!f.address}>Continue</Button>
    </div>
  );
}

function StepBranch({ state, save, busy }: StepProps) {
  const b = state.branches[0];
  const [f, setF] = useState({
    name: b?.name ?? `${state.tenant.name ?? ''} Main`.trim(),
    code: b?.code ?? 'MAIN',
    phone: b?.phone ?? state.tenant.phone ?? '',
    address: b?.address ?? state.tenant.address ?? '',
    city: b?.city ?? '',
    openingTime: b?.openingTime ?? '09:00',
    closingTime: b?.closingTime ?? '21:00',
  });
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Branch name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Short code" hint="Used in invoice numbers"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={12} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="City"><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label="Opens at"><Input type="time" value={f.openingTime} onChange={(e) => setF({ ...f, openingTime: e.target.value })} /></Field>
        <Field label="Closes at"><Input type="time" value={f.closingTime} onChange={(e) => setF({ ...f, closingTime: e.target.value })} /></Field>
      </div>
      <Button onClick={() => save({ ...f, status: 'ACTIVE', publicBookingEnabled: true })} loading={busy} disabled={!f.name || !f.code}>Continue</Button>
    </div>
  );
}

function StepServices({ state, save, busy }: StepProps) {
  const type = state.tenant.businessType ?? 'OTHER';
  const { data: template } = useQuery({ queryKey: ['onboarding-template', type], queryFn: () => api.get<Template>(`/onboarding/templates/${type}`) });
  const [rows, setRows] = useState<{ name: string; category: string; durationMinutes: number; basePrice: number; selected: boolean }[]>([]);
  useEffect(() => {
    if (template && !rows.length) {
      const existing = new Set(state.services.map((s) => s.name.toLowerCase()));
      setRows(template.categories.flatMap((c) => c.services.map((s) => ({ ...s, category: c.name, selected: !existing.has(s.name.toLowerCase()) }))));
    }
  }, [template, rows.length, state.services]);
  const update = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((p) => p.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-4">
      {state.services.length > 0 && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">You already have {state.services.length} services. Selected items below will be added.</p>}
      <p className="text-sm text-slate-600">We suggested common services for a {titleCase(type).toLowerCase()} business. Untick what you don&apos;t offer and add your own.</p>
      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 items-center gap-2 px-3 py-2">
            <div className="col-span-1"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={r.selected} onChange={(e) => update(i, { selected: e.target.checked })} /></div>
            <Input className="col-span-4" value={r.name} onChange={(e) => update(i, { name: e.target.value })} />
            <Input className="col-span-3" value={r.category} onChange={(e) => update(i, { category: e.target.value })} />
            <Input className="col-span-2" type="number" value={r.durationMinutes} onChange={(e) => update(i, { durationMinutes: Number(e.target.value) })} title="Minutes" />
            <Input className="col-span-2" type="number" value={r.basePrice} onChange={(e) => update(i, { basePrice: Number(e.target.value) })} title="Price" />
          </div>
        ))}
      </div>
      <Button size="sm" variant="outline" onClick={() => setRows((p) => [...p, { name: '', category: p[0]?.category ?? 'General', durationMinutes: 60, basePrice: 1000, selected: true }])}>
        <Plus className="h-3.5 w-3.5" /> Add a custom service
      </Button>
      <div>
        <Button onClick={() => save({ services: rows.filter((r) => r.selected && r.name).map(({ selected: _s, ...r }) => r) })} loading={busy}
          disabled={!rows.some((r) => r.selected && r.name) && !state.services.length}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function StepPrices({ state, save, busy }: StepProps) {
  const current = state.taxRates.find((t) => t.isDefault);
  const [tax, setTax] = useState({ name: current?.name ?? 'GST 18%', rate: String(current?.rate ?? 18), isInclusive: current?.isInclusive ?? false });
  const [prices, setPrices] = useState(state.services.map((s) => ({ serviceId: s.id, name: s.name, basePrice: String(s.basePrice) })));
  return (
    <div className="space-y-5">
      <div className="grid gap-4 rounded-lg border border-slate-200 p-4 sm:grid-cols-3">
        <Field label="Tax name"><Input value={tax.name} onChange={(e) => setTax({ ...tax, name: e.target.value })} /></Field>
        <Field label="Rate (%)"><Input type="number" value={tax.rate} onChange={(e) => setTax({ ...tax, rate: e.target.value })} /></Field>
        <div className="flex items-end pb-2"><Checkbox label="Prices already include tax" checked={tax.isInclusive} onChange={(e) => setTax({ ...tax, isInclusive: e.target.checked })} /></div>
      </div>
      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {prices.map((p, i) => (
          <div key={p.serviceId} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-sm">{p.name}</span>
            <Input type="number" className="w-32" value={p.basePrice} onChange={(e) => setPrices((prev) => prev.map((x, j) => (j === i ? { ...x, basePrice: e.target.value } : x)))} />
          </div>
        ))}
      </div>
      <Button loading={busy} onClick={() => save({
        tax: { name: tax.name, rate: Number(tax.rate), isInclusive: tax.isInclusive },
        prices: prices.map((p) => ({ serviceId: p.serviceId, basePrice: Number(p.basePrice), taxRate: Number(tax.rate) })),
      })}>Continue</Button>
    </div>
  );
}

function StepTherapists({ state, save, busy }: StepProps) {
  const [rows, setRows] = useState([{ name: '', phone: '', email: '', specialization: '', invite: false }]);
  const update = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((p) => p.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-4">
      {state.therapists.length > 0 && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Existing therapists: {state.therapists.map((t) => t.name).join(', ')}</p>}
      <p className="text-sm text-slate-600">Therapists are scheduled on branch hours Monday to Saturday. You can fine-tune schedules later.</p>
      {rows.map((r, i) => (
        <div key={i} className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-4">
          <Input placeholder="Name" value={r.name} onChange={(e) => update(i, { name: e.target.value })} />
          <Input placeholder="Phone" value={r.phone} onChange={(e) => update(i, { phone: e.target.value })} />
          <Input placeholder="Email (for app login)" value={r.email} onChange={(e) => update(i, { email: e.target.value })} />
          <div className="flex items-center gap-2">
            <Input placeholder="Specialisation" value={r.specialization} onChange={(e) => update(i, { specialization: e.target.value })} />
            <Button variant="ghost" size="icon" onClick={() => setRows((p) => p.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
          </div>
          {r.email && <Checkbox className="sm:col-span-4" label="Send an invitation so they can log in and see their sessions" checked={r.invite} onChange={(e) => update(i, { invite: e.target.checked })} />}
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={() => setRows((p) => [...p, { name: '', phone: '', email: '', specialization: '', invite: false }])}><Plus className="h-3.5 w-3.5" /> Add therapist</Button>
      <div><Button loading={busy} onClick={() => save({ therapists: rows.filter((r) => r.name) })} disabled={!rows.some((r) => r.name)}>Continue</Button></div>
    </div>
  );
}

function StepPayments({ state, save, busy }: StepProps) {
  const [methods, setMethods] = useState<Set<string>>(new Set(state.settings.PAYMENT_PROVIDERS ?? ['CASH', 'UPI', 'CARD']));
  const [upiId, setUpiId] = useState(state.settings.UPI_ID ?? '');
  const [gateway, setGateway] = useState('NONE');
  const toggle = (m: string) => setMethods((p) => { const n = new Set(p); if (n.has(m)) n.delete(m); else n.add(m); return n; });
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">Which payment methods do you accept at the counter?</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'ONLINE'].map((m) => (
          <label key={m} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm', methods.has(m) ? 'border-brand-600 bg-brand-50' : 'border-slate-200')}>
            <input type="checkbox" className="accent-brand-600" checked={methods.has(m)} onChange={() => toggle(m)} /> {titleCase(m)}
          </label>
        ))}
      </div>
      {methods.has('UPI') && <Field label="UPI ID (shown on invoices as a QR)"><Input value={upiId} onChange={(e) => setUpiId(e.target.value)} placeholder="business@upi" /></Field>}
      <Field label="Online payment gateway">
        <Select value={gateway} onChange={(e) => setGateway(e.target.value)}>
          <option value="NONE">Not now</option>
          <option value="RAZORPAY">Razorpay (payment links & online booking prepayment)</option>
        </Select>
      </Field>
      <Button loading={busy} onClick={() => save({ methods: [...methods], upiId, onlineGateway: gateway })} disabled={!methods.size}>Continue</Button>
    </div>
  );
}

function StepWhatsApp({ state, save, busy }: StepProps) {
  const [enabled, setEnabled] = useState(!!state.settings.WHATSAPP_ENABLED);
  const [phoneNumber, setPhone] = useState(state.tenant.phone ?? '');
  const [displayName, setName] = useState(state.tenant.name ?? '');
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">Send booking confirmations, reminders, invoices and follow-ups on WhatsApp automatically.</p>
      <Checkbox label="Enable WhatsApp notifications" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      {enabled && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="WhatsApp business number"><Input value={phoneNumber} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Display name"><Input value={displayName} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
      )}
      <Button loading={busy} onClick={() => save({ enabled, phoneNumber, displayName })}>Continue</Button>
    </div>
  );
}

function StepGoLive({ state, save, busy }: StepProps) {
  const checks = [
    { label: 'Business details', ok: !!state.tenant.businessType },
    { label: 'At least one branch', ok: state.branches.length > 0 },
    { label: 'Services added', ok: state.services.length > 0 },
    { label: 'Tax configured', ok: state.taxRates.length > 0 },
    { label: 'Therapists added', ok: state.therapists.length > 0 },
  ];
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {checks.map((c) => (
          <div key={c.label} className="flex items-center gap-2 text-sm">
            <span className={cn('flex h-5 w-5 items-center justify-center rounded-full', c.ok ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-400')}><Check className="h-3 w-3" /></span>
            {c.label}
          </div>
        ))}
      </div>
      <p className="text-sm text-slate-600">
        {state.services.length} services{state.services.length > 0 && ` from ${money(Math.min(...state.services.map((s) => Number(s.basePrice))))}`} · {state.therapists.length} therapists · {state.branches.length} branch
      </p>
      <Button size="lg" loading={busy} onClick={() => save({})} disabled={!checks[1].ok || !checks[2].ok}>Go live</Button>
    </div>
  );
}

const STEP_COMPONENTS: Record<number, (p: StepProps) => React.ReactElement> = {
  1: StepBusiness, 2: StepLogo, 3: StepAddress, 4: StepBranch, 5: StepServices,
  6: StepPrices, 7: StepTherapists, 8: StepPayments, 9: StepWhatsApp, 10: StepGoLive,
};

export default function OnboardingPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { status, user } = useAuth();
  const [step, setStep] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: state, isLoading } = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api.get<OnboardingState>('/onboarding'),
    enabled: status === 'authenticated',
  });

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);
  useEffect(() => {
    if (state && step === null) setStep(Math.min(state.currentStep, 10));
  }, [state, step]);

  if (status !== 'authenticated' || isLoading || !state || step === null) {
    return <div className="flex min-h-screen items-center justify-center"><LoadingBlock /></div>;
  }

  const save = async (data: Record<string, unknown>) => {
    setBusy(true);
    try {
      const next = await api.put<OnboardingState>(`/onboarding/steps/${step}`, data);
      qc.setQueryData(['onboarding'], next);
      if (step === 10) {
        await refreshSession();
        toast.success("You're live! Welcome to TherapyOS.");
        router.replace('/dashboard');
        return;
      }
      if (step === 1) await refreshSession();
      setStep(step + 1);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    setBusy(true);
    try {
      const next = await api.post<OnboardingState>(`/onboarding/steps/${step}/skip`);
      qc.setQueryData(['onboarding'], next);
      setStep(step + 1);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const def = state.steps.find((s) => s.step === step)!;
  const StepComponent = STEP_COMPONENTS[step];

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 lg:grid-cols-[260px_1fr]">
        <aside>
          <div className="mb-6 flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 font-bold text-white">T</div>
            <div>
              <p className="text-sm font-semibold">Set up {user?.tenantName}</p>
              <p className="text-xs text-slate-500">About 5 minutes</p>
            </div>
          </div>
          <ol className="space-y-1">
            {state.steps.map((s) => {
              const done = s.step < state.currentStep;
              const reachable = s.step <= state.currentStep;
              return (
                <li key={s.step}>
                  <button disabled={!reachable} onClick={() => setStep(s.step)}
                    className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm', s.step === step ? 'bg-white font-medium shadow-sm' : 'text-slate-600', !reachable && 'opacity-50')}>
                    <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs', done ? 'bg-emerald-500 text-white' : s.step === step ? 'bg-brand-600 text-white' : 'bg-slate-200')}>
                      {done ? <Check className="h-3.5 w-3.5" /> : s.step}
                    </span>
                    {s.title}
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
        <Card>
          <CardContent className="p-6 sm:p-8">
            <p className="text-xs font-medium uppercase tracking-wide text-brand-700">Step {step} of 10</p>
            <h1 className="mt-1 text-xl font-semibold text-slate-900">{def.title}</h1>
            <div className="mt-6">
              <StepComponent key={step} state={state} save={save} busy={busy} />
            </div>
            <div className="mt-6 flex justify-between border-t border-slate-100 pt-4">
              <Button variant="ghost" disabled={step === 1} onClick={() => setStep(step - 1)}>Back</Button>
              {def.optional && <Button variant="ghost" onClick={skip} disabled={busy}>Skip for now</Button>}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
