'use client';
import { addDays, format, parseISO } from 'date-fns';
import { ArrowLeft, CalendarCheck, CheckCircle2, Clock, MapPin, Phone } from 'lucide-react';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Button, Field, Input, Select, Spinner, Textarea } from '@therapyos/ui';
import { applyBrandColor } from '@/components/brand-theme';

interface Branch { id: string; name: string; code: string; address: string | null; city: string | null; phone: string | null; openingTime: string | null; closingTime: string | null }
interface Service { id: string; name: string; description: string | null; durationMinutes: number; price: number; category: { id: string; name: string } | null; branches: { branchId: string; price: number; durationMinutes: number }[] }
interface Info {
  business: { name: string; slug: string; logoUrl: string | null; phone: string | null; currency: string; primaryColor: string | null; poweredBy: boolean };
  timezone: string;
  today: string;
  maxDate: string;
  branches: Branch[];
  services: Service[];
}
interface Slots { date: string; durationMinutes: number; price: number; therapists: { id: string; name: string }[]; slots: { time: string; therapistIds: string[] }[] }
interface Booked { appointmentId: string; date: string; startTime: string; service: string; therapist: string | null; branch: { name: string; address: string | null; phone: string | null }; customerName: string }

/** Unauthenticated calls: public pages must never attach (or refresh) a staff session. */
async function publicApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/public/booking/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!json?.success) throw new Error(json?.error?.message ?? 'Something went wrong. Please try again.');
  return json.data as T;
}

const time12 = (t: string) => format(parseISO(`2000-01-01T${t}`), 'h:mm a');

function BookingInner() {
  const { slug } = useParams<{ slug: string }>();
  const preselect = useSearchParams().get('branch')?.toLowerCase();
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [date, setDate] = useState<string>('');
  const [therapistId, setTherapistId] = useState('');
  const [slots, setSlots] = useState<Slots | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [slot, setSlot] = useState<{ time: string; therapistIds: string[] } | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);

  useEffect(() => {
    publicApi<Info>(encodeURIComponent(slug)).then(
      (i) => {
        setInfo(i);
        setDate(i.today);
        applyBrandColor(i.business.primaryColor);
        document.title = `Book online · ${i.business.name}`;
        const pre = i.branches.find((b) => b.code.toLowerCase() === preselect) ?? (i.branches.length === 1 ? i.branches[0] : undefined);
        if (pre) setBranchId(pre.id);
      },
      (e: Error) => setLoadError(e.message),
    );
  }, [slug, preselect]);

  useEffect(() => {
    if (!branchId || !serviceId || !date) return;
    setSlotsLoading(true);
    setSlotsError(null);
    setSlot(null);
    const q = new URLSearchParams({ branchId, serviceId, date, ...(therapistId ? { therapistId } : {}) });
    publicApi<Slots>(`${encodeURIComponent(slug)}/slots?${q}`)
      .then(setSlots, (e: Error) => setSlotsError(e.message))
      .finally(() => setSlotsLoading(false));
  }, [slug, branchId, serviceId, date, therapistId]);

  const branch = info?.branches.find((b) => b.id === branchId) ?? null;
  const services = useMemo(() => (info && branchId ? info.services.filter((s) => s.branches.some((b) => b.branchId === branchId)) : []), [info, branchId]);
  const service = services.find((s) => s.id === serviceId) ?? null;
  const offer = service?.branches.find((b) => b.branchId === branchId);
  const byCategory = useMemo(() => {
    const groups = new Map<string, Service[]>();
    for (const s of services) groups.set(s.category?.name ?? 'Services', [...(groups.get(s.category?.name ?? 'Services') ?? []), s]);
    return [...groups.entries()];
  }, [services]);
  const days = useMemo(() => {
    if (!info) return [];
    const start = parseISO(info.today);
    return Array.from({ length: 14 }, (_, i) => format(addDays(start, i), 'yyyy-MM-dd'));
  }, [info]);
  const money = (v: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: info?.business.currency ?? 'INR', maximumFractionDigits: 0 }).format(v);

  const submit = async () => {
    if (!branchId || !serviceId || !slot) return;
    setBusy(true);
    setError(null);
    try {
      const r = await publicApi<Booked>(encodeURIComponent(slug), {
        branchId,
        serviceId,
        date,
        startTime: slot.time,
        therapistId: therapistId || slot.therapistIds[0] || undefined,
        name: form.name,
        phone: form.phone.replace(/\s/g, ''),
        email: form.email || undefined,
        notes: form.notes || undefined,
      });
      setBooked(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-gradient-to-b from-brand-50 to-white px-4 py-8">
      <div className="mx-auto w-full max-w-2xl">
        {info && (
          <header className="mb-6 flex items-center gap-3">
            {info.business.logoUrl ? (
               
              <img src={info.business.logoUrl} alt="" className="h-12 w-12 rounded-lg object-cover" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-brand-600 text-lg font-bold text-white">{info.business.name.charAt(0)}</div>
            )}
            <div>
              <h1 className="text-lg font-semibold text-slate-900">{info.business.name}</h1>
              <p className="text-sm text-slate-500">Book an appointment online</p>
            </div>
          </header>
        )}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">{children}</div>
        {info?.business.poweredBy && <p className="mt-4 text-center text-xs text-slate-400">Powered by TherapyOS</p>}
      </div>
    </div>
  );

  if (loadError) return shell(<p className="py-6 text-center text-sm text-slate-600">{loadError.includes('not found') ? 'This booking page is not available.' : loadError}</p>);
  if (!info) return shell(<div className="flex justify-center py-10"><Spinner /></div>);
  if (!info.branches.length) return shell(<p className="py-6 text-center text-sm text-slate-600">Online booking is not open right now. {info.business.phone ? `Call us on ${info.business.phone} to book.` : ''}</p>);

  if (booked) {
    return shell(
      <div className="py-4 text-center" data-testid="booking-confirmed">
        <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-500" />
        <h2 className="mt-3 text-xl font-semibold">You are booked, {booked.customerName.split(' ')[0]}!</h2>
        <p className="mt-1 text-sm text-slate-600">You will get a confirmation message on your phone shortly.</p>
        <div className="mx-auto mt-5 max-w-sm space-y-2 rounded-xl bg-slate-50 p-4 text-left text-sm">
          <p className="font-medium text-slate-900">{booked.service}{booked.therapist ? ` with ${booked.therapist}` : ''}</p>
          <p className="flex items-center gap-2 text-slate-600"><CalendarCheck className="h-4 w-4" />{format(parseISO(booked.date), 'EEEE, d MMMM')} at {time12(booked.startTime)}</p>
          <p className="flex items-center gap-2 text-slate-600"><MapPin className="h-4 w-4" />{booked.branch.name}{booked.branch.address ? `, ${booked.branch.address}` : ''}</p>
          {booked.branch.phone && <p className="flex items-center gap-2 text-slate-600"><Phone className="h-4 w-4" />{booked.branch.phone}</p>}
        </div>
        <Button variant="outline" className="mt-5" onClick={() => { setBooked(null); setSlot(null); setServiceId(null); }}>Book another</Button>
      </div>,
    );
  }

  const step = !branchId ? 'branch' : !serviceId ? 'service' : !slot ? 'time' : 'details';
  const back = () => {
    if (step === 'details') setSlot(null);
    else if (step === 'time') setServiceId(null);
    else if (step === 'service' && info.branches.length > 1) setBranchId(null);
  };

  return shell(
    <div className="space-y-5">
      {(step !== 'branch' && !(step === 'service' && info.branches.length === 1)) && (
        <button type="button" onClick={back} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Back</button>
      )}
      {branch && step !== 'branch' && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{branch.name}</span>
          {service && <span>{service.name} · {offer?.durationMinutes ?? service.durationMinutes} min · {money(offer?.price ?? service.price)}</span>}
          {slot && <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{format(parseISO(date), 'EEE d MMM')}, {time12(slot.time)}</span>}
        </div>
      )}

      {step === 'branch' && (
        <section>
          <h2 className="mb-3 text-base font-semibold">Choose a location</h2>
          <div className="grid gap-2">
            {info.branches.map((b) => (
              <button key={b.id} type="button" onClick={() => setBranchId(b.id)} className="rounded-xl border border-slate-200 p-4 text-left transition hover:border-brand-400 hover:bg-brand-50" data-testid="booking-branch">
                <p className="font-medium text-slate-900">{b.name}</p>
                <p className="text-sm text-slate-500">{[b.address, b.city].filter(Boolean).join(', ')}</p>
                {b.openingTime && b.closingTime && <p className="mt-1 text-xs text-slate-400">Open {time12(b.openingTime)} – {time12(b.closingTime)}</p>}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 'service' && (
        <section>
          <h2 className="mb-3 text-base font-semibold">Choose a service</h2>
          {!services.length && <p className="text-sm text-slate-500">No services are bookable online at this location yet.</p>}
          <div className="space-y-4">
            {byCategory.map(([cat, list]) => (
              <div key={cat}>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{cat}</p>
                <div className="grid gap-2">
                  {list.map((s) => {
                    const o = s.branches.find((b) => b.branchId === branchId);
                    return (
                      <button key={s.id} type="button" onClick={() => setServiceId(s.id)} className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 p-3.5 text-left transition hover:border-brand-400 hover:bg-brand-50" data-testid="booking-service">
                        <div>
                          <p className="font-medium text-slate-900">{s.name}</p>
                          {s.description && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{s.description}</p>}
                          <p className="mt-1 text-xs text-slate-500">{o?.durationMinutes ?? s.durationMinutes} min</p>
                        </div>
                        <p className="whitespace-nowrap font-semibold text-slate-900">{money(o?.price ?? s.price)}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {step === 'time' && (
        <section className="space-y-4">
          <h2 className="text-base font-semibold">Pick a date and time</h2>
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {days.map((d) => {
              const dt = parseISO(d);
              return (
                <button key={d} type="button" onClick={() => setDate(d)} className={`flex min-w-[3.75rem] flex-col items-center rounded-lg border px-2 py-2 text-xs transition ${date === d ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 hover:border-brand-400'}`}>
                  <span className="uppercase">{d === info.today ? 'Today' : format(dt, 'EEE')}</span>
                  <span className="text-lg font-semibold leading-tight">{format(dt, 'd')}</span>
                  <span>{format(dt, 'MMM')}</span>
                </button>
              );
            })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Or choose another date"><Input type="date" min={info.today} max={info.maxDate} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Booking date" /></Field>
            <Field label="Therapist">
              <Select value={therapistId} onChange={(e) => setTherapistId(e.target.value)} aria-label="Therapist">
                <option value="">Any available</option>
                {slots?.therapists.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          </div>
          {slotsLoading ? <div className="flex justify-center py-6"><Spinner /></div> : slotsError ? <p className="text-sm text-rose-600">{slotsError}</p> : slots && !slots.slots.length ? (
            <p className="rounded-lg bg-slate-50 p-4 text-center text-sm text-slate-600">No times left on {format(parseISO(date), 'EEEE, d MMM')}. Try another day{therapistId ? ' or any therapist' : ''}.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-testid="booking-slots">
              {slots?.slots.map((s) => (
                <button key={s.time} type="button" onClick={() => setSlot(s)} className="rounded-lg border border-slate-200 py-2 text-sm font-medium transition hover:border-brand-500 hover:bg-brand-50">{time12(s.time)}</button>
              ))}
            </div>
          )}
        </section>
      )}

      {step === 'details' && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Your details</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" aria-label="Full name" /></Field>
            <Field label="Mobile number" hint="For your confirmation and reminders."><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" autoComplete="tel" aria-label="Mobile number" /></Field>
            <Field label="Email (optional)" className="sm:col-span-2"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" /></Field>
            <Field label="Anything we should know? (optional)" className="sm:col-span-2"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={500} /></Field>
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <Button className="w-full" size="lg" onClick={submit} loading={busy} disabled={form.name.trim().length < 2 || form.phone.replace(/\D/g, '').length < 10}>Confirm booking</Button>
          <p className="text-center text-xs text-slate-400">Pay at the clinic after your session.</p>
        </section>
      )}
    </div>,
  );
}

export default function PublicBookingPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><Spinner /></div>}>
      <BookingInner />
    </Suspense>
  );
}
