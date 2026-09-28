'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@therapyos/types';
import { Button, Field, Input, LoadingBlock, Modal, Select, StatusBadge } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { fmtDateTime, titleCase } from '@/lib/format';
import { useTherapists } from '@/lib/queries';

interface AppointmentDetail {
  id: string;
  branchId: string;
  status: string;
  source: string;
  notes: string | null;
  startTime: string;
  endTime: string;
  cancelReason: string | null;
  customer: { id: string; name: string; phone: string; customerCode: string };
  service: { id: string; name: string; durationMinutes: number };
  therapist: { id: string; name: string } | null;
  branch: { id: string; name: string };
  queueEntry: { id: string; queueNumber: number; status: string } | null;
  sessions: { id: string; status: string }[];
}

export function AppointmentDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const user = useAuth((s) => s.user);
  const { data: a, isLoading, refetch } = useQuery({ queryKey: ['appointment', id], queryFn: () => api.get<AppointmentDetail>(`/appointments/${id}`) });
  const { data: therapists } = useTherapists({ branchId: a?.branchId, activeOnly: true });
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>('view');
  const [form, setForm] = useState({ date: '', startTime: '', therapistId: '' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(msg);
      onChanged();
      await refetch();
      setMode('view');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const startReschedule = () => {
    if (!a) return;
    const d = new Date(a.startTime);
    setForm({
      date: d.toLocaleDateString('en-CA'),
      startTime: d.toTimeString().slice(0, 5),
      therapistId: a.therapist?.id ?? '',
    });
    setMode('reschedule');
  };

  const open = a && ['BOOKED', 'CONFIRMED'].includes(a.status);
  const can = (p: string) => hasPermission(user, p);

  return (
    <Modal open onClose={onClose} size="md" title="Appointment" description={a ? `${a.service.name} · ${fmtDateTime(a.startTime)}` : undefined}>
      {isLoading || !a ? (
        <LoadingBlock />
      ) : mode === 'reschedule' ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date"><Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} /></Field>
            <Field label="Start time"><Input type="time" step={900} value={form.startTime} onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))} /></Field>
            <Field label="Therapist" className="sm:col-span-2">
              <Select value={form.therapistId} onChange={(e) => setForm((f) => ({ ...f, therapistId: e.target.value }))}>
                {therapists?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setMode('view')}>Back</Button>
            <Button loading={busy === 'reschedule'} onClick={() => act('reschedule', () => api.patch(`/appointments/${id}`, form), 'Appointment rescheduled')}>Save new time</Button>
          </div>
        </div>
      ) : mode === 'cancel' ? (
        <div className="space-y-4">
          <Field label="Reason (optional)"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer request, therapist unavailable..." /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setMode('view')}>Back</Button>
            <Button variant="danger" loading={busy === 'cancel'} onClick={() => act('cancel', () => api.post(`/appointments/${id}/cancel`, { reason: reason || undefined }), 'Appointment cancelled')}>Cancel appointment</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex items-center justify-between">
            <Link href={`/customers/${a.customer.id}`} className="font-medium text-brand-700 hover:underline">{a.customer.name}</Link>
            <StatusBadge status={a.status} />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <dt className="text-slate-500">Phone</dt><dd>{a.customer.phone}</dd>
            <dt className="text-slate-500">Therapist</dt><dd>{a.therapist?.name ?? 'Unassigned'}</dd>
            <dt className="text-slate-500">When</dt><dd>{fmtDateTime(a.startTime)} ({a.service.durationMinutes} min)</dd>
            <dt className="text-slate-500">Branch</dt><dd>{a.branch.name}</dd>
            <dt className="text-slate-500">Booked via</dt><dd>{titleCase(a.source)}</dd>
            {a.queueEntry && (<><dt className="text-slate-500">Queue token</dt><dd>#{a.queueEntry.queueNumber} ({titleCase(a.queueEntry.status)})</dd></>)}
            {a.cancelReason && (<><dt className="text-slate-500">Cancel reason</dt><dd>{a.cancelReason}</dd></>)}
          </dl>
          {a.notes && <p className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">{a.notes}</p>}
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            {a.status === 'BOOKED' && can(PERMISSIONS.APPOINTMENT_UPDATE) && (
              <Button size="sm" variant="outline" loading={busy === 'confirm'} onClick={() => act('confirm', () => api.patch(`/appointments/${id}`, { status: 'CONFIRMED' }), 'Confirmed')}>Confirm</Button>
            )}
            {open && (can(PERMISSIONS.APPOINTMENT_UPDATE) || can(PERMISSIONS.QUEUE_MANAGE)) && (
              <Button size="sm" loading={busy === 'checkin'} onClick={() => act('checkin', () => api.post(`/appointments/${id}/check-in`), 'Checked in and added to the queue')}>Check in</Button>
            )}
            {(open || a.status === 'CHECKED_IN') && a.therapist && can(PERMISSIONS.SESSION_MANAGE) && (
              <Button size="sm" variant="success" loading={busy === 'start'} onClick={() => act('start', () => api.post(`/appointments/${id}/start`, {}), 'Session started')}>Start session</Button>
            )}
            {open && can(PERMISSIONS.APPOINTMENT_UPDATE) && <Button size="sm" variant="outline" onClick={startReschedule}>Reschedule</Button>}
            {open && can(PERMISSIONS.APPOINTMENT_UPDATE) && new Date(a.startTime) < new Date() && (
              <Button size="sm" variant="outline" loading={busy === 'noshow'} onClick={() => act('noshow', () => api.patch(`/appointments/${id}`, { status: 'NO_SHOW' }), 'Marked as no-show')}>No-show</Button>
            )}
            {(open || a.status === 'CHECKED_IN') && can(PERMISSIONS.APPOINTMENT_CANCEL) && (
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => setMode('cancel')}>Cancel</Button>
            )}
            {a.sessions.some((s) => ['IN_PROGRESS', 'PAUSED'].includes(s.status)) && (
              <Link href="/sessions" className="text-sm text-brand-700 hover:underline">Session in progress</Link>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
