'use client';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { APPOINTMENT_SOURCES } from '@therapyos/types';
import { Button, Field, Input, Modal, Select, Spinner, Textarea } from '@therapyos/ui';
import { cn } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { money, titleCase, todayIso } from '@/lib/format';
import { useBranches, useWorkingBranch } from '@/lib/queries';
import { CustomerFormModal } from './customer-form';
import { CustomerPicker, type CustomerHit } from './customer-picker';

interface BranchService {
  id: string;
  name: string;
  effectivePrice: number;
  effectiveDuration: number;
  availableAtBranch: boolean;
  category?: { name: string } | null;
}

interface Availability {
  date: string;
  durationMinutes: number;
  price: number;
  therapists: { id: string; name: string; color: string | null }[];
  slots: { time: string; therapistIds: string[] }[];
}

export interface BookingDefaults {
  customer?: CustomerHit | null;
  branchId?: string;
  date?: string;
  time?: string;
  therapistId?: string;
  serviceId?: string;
}

export function BookingModal({ open, onClose, defaults, onBooked }: { open: boolean; onClose: () => void; defaults?: BookingDefaults; onBooked?: (appointment: { id: string }) => void }) {
  const { data: branches } = useBranches();
  const working = useWorkingBranch(branches);
  const [customer, setCustomer] = useState<CustomerHit | null>(defaults?.customer ?? null);
  const [newSeed, setNewSeed] = useState<{ name: string; phone: string } | null>(null);
  const [branchId, setBranchId] = useState(defaults?.branchId ?? working ?? '');
  const [serviceId, setServiceId] = useState(defaults?.serviceId ?? '');
  const [date, setDate] = useState(defaults?.date ?? todayIso());
  const [therapistId, setTherapistId] = useState(defaults?.therapistId ?? '');
  const [time, setTime] = useState(defaults?.time ?? '');
  const [source, setSource] = useState('RECEPTION');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const effectiveBranch = branchId || working || '';

  const { data: services } = useQuery({
    queryKey: ['services', 'booking', effectiveBranch],
    queryFn: () => api.get<BranchService[]>('/services', { branchId: effectiveBranch, active: 'true' }),
    enabled: !!effectiveBranch,
  });
  const offered = useMemo(() => services?.filter((s) => s.availableAtBranch) ?? [], [services]);

  const { data: availability, isFetching } = useQuery({
    queryKey: ['availability', effectiveBranch, serviceId, date],
    queryFn: () => api.get<Availability>('/appointments/availability', { branchId: effectiveBranch, serviceId, date }),
    enabled: !!effectiveBranch && !!serviceId && !!date,
  });
  const slots = useMemo(
    () => (availability?.slots ?? []).filter((s) => !therapistId || s.therapistIds.includes(therapistId)),
    [availability, therapistId],
  );
  const chosenSlot = slots.find((s) => s.time === time);

  const book = async () => {
    if (!customer) return toast.error('Select a customer');
    if (!serviceId || !time) return toast.error('Pick a service and a time slot');
    setBusy(true);
    try {
      const appt = await api.post<{ id: string }>('/appointments', {
        branchId: effectiveBranch,
        customerId: customer.id,
        serviceId,
        therapistId: therapistId || undefined,
        date,
        startTime: time,
        source,
        notes: notes || undefined,
      });
      toast.success('Appointment booked');
      onBooked?.(appt);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const service = offered.find((s) => s.id === serviceId);
  const therapistName = (id: string) => availability?.therapists.find((t) => t.id === id)?.name;

  return (
    <>
      <Modal
        open={open && !newSeed}
        onClose={onClose}
        size="lg"
        title="Book appointment"
        footer={
          <>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={book} loading={busy} disabled={!customer || !time}>Confirm booking</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Customer">
            <CustomerPicker value={customer} onChange={setCustomer} allowNew onNew={setNewSeed} autoFocus={!customer} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Branch">
              <Select value={effectiveBranch} onChange={(e) => { setBranchId(e.target.value); setServiceId(''); setTime(''); }}>
                {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
            <Field label="Service" className="sm:col-span-2">
              <Select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setTime(''); }}>
                <option value="">Select a service</option>
                {offered.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.effectiveDuration} min · {money(s.effectivePrice)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date">
              <Input type="date" min={todayIso()} value={date} onChange={(e) => { setDate(e.target.value); setTime(''); }} />
            </Field>
            <Field label="Therapist" className="sm:col-span-2">
              <Select value={therapistId} onChange={(e) => { setTherapistId(e.target.value); setTime(''); }}>
                <option value="">Any available (auto-assign)</option>
                {availability?.therapists.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          </div>

          {serviceId && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium text-slate-600">Available times</p>
                {isFetching && <Spinner className="h-4 w-4 text-slate-400" />}
              </div>
              {availability && slots.length === 0 ? (
                <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">No free slots on this day. Try another date or therapist.</p>
              ) : (
                <div className="grid max-h-48 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
                  {slots.map((s) => (
                    <button
                      key={s.time}
                      type="button"
                      onClick={() => setTime(s.time)}
                      className={cn(
                        'rounded-lg border px-2 py-1.5 text-sm tabular-nums transition-colors',
                        time === s.time ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 hover:border-brand-400 hover:bg-brand-50',
                      )}
                    >
                      {s.time}
                    </button>
                  ))}
                </div>
              )}
              {chosenSlot && !therapistId && (
                <p className="mt-2 text-xs text-slate-500">
                  Free at {chosenSlot.time}: {chosenSlot.therapistIds.map(therapistName).filter(Boolean).join(', ')}. The least busy therapist will be assigned.
                </p>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Booked via">
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                {APPOINTMENT_SOURCES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
              </Select>
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Preferences, health notes..." />
            </Field>
          </div>
          {service && time && (
            <div className="rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-900">
              {service.name} on {date} at {time} ({availability?.durationMinutes ?? service.effectiveDuration} min) · {money(availability?.price ?? service.effectivePrice)}
            </div>
          )}
        </div>
      </Modal>
      {newSeed && (
        <CustomerFormModal
          open
          seed={newSeed}
          onClose={() => setNewSeed(null)}
          onSaved={(c) => {
            setCustomer({ id: c.id, name: c.name, phone: c.phone, customerCode: c.customerCode });
            setNewSeed(null);
          }}
        />
      )}
    </>
  );
}
