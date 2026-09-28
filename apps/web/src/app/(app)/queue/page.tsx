'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Bell, CheckCircle2, Clock, Play, Plus, UserCheck, Wifi, WifiOff, X } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, EmptyState, Field, Input, LoadingBlock, Modal, PageHeader, Select, StatCard, StatusBadge, Textarea } from '@therapyos/ui';
import { cn } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { fmtTime, titleCase } from '@/lib/format';
import { useBranches, useServices, useWorkingBranch } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime';
import { CustomerPicker, SEGMENT_TONE, type CustomerHit } from '@/components/customer-picker';

interface Entry {
  id: string;
  queueNumber: number;
  status: string;
  priority: number;
  notes: string | null;
  checkedInAt: string;
  waitingMinutes: number;
  customer: { id: string; name: string; phone: string; customerCode: string; metrics: { segment: string; visitCount: number } | null };
  service: { id: string; name: string; durationMinutes: number } | null;
  therapist: { id: string; name: string } | null;
  appointment: { id: string; startTime: string } | null;
  sessions: { id: string; status: string; startedAt: string | null }[];
}

interface TherapistState {
  id: string;
  name: string;
  color: string | null;
  state: 'FREE' | 'BUSY' | 'PAUSED' | 'OFF_SHIFT';
  session: { id: string; customer: string; service: string; startedAt: string | null; expectedEnd: string | null } | null;
}

interface QueueBoard {
  branch: { id: string; name: string };
  date: string;
  stats: { waiting: number; inService: number; completed: number; freeTherapists: number; avgWaitMinutes: number };
  entries: Entry[];
  therapists: TherapistState[];
  upcoming: { id: string; localTime: string; status: string; customer: { name: string }; service: { name: string }; therapist: { name: string } | null }[];
}

const STATE_STYLE: Record<TherapistState['state'], string> = {
  FREE: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  BUSY: 'bg-amber-50 text-amber-800 ring-amber-200',
  PAUSED: 'bg-slate-100 text-slate-700 ring-slate-200',
  OFF_SHIFT: 'bg-slate-50 text-slate-400 ring-slate-200',
};

function minutesLeft(iso: string | null) {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
}

function AddWalkIn({ branchId, onClose, onAdded }: { branchId: string; onClose: () => void; onAdded: () => void }) {
  const { data: services } = useServices({ branchId, activeOnly: true });
  const { data: estimate } = useQuery({ queryKey: ['queue-estimate', branchId], queryFn: () => api.get<{ minutes: number }>('/queue/estimate', { branchId }) });
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [fresh, setFresh] = useState<{ name: string; phone: string } | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [priority, setPriority] = useState('0');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ queueNumber: number }>('/queue', {
        branchId,
        customerId: customer?.id,
        customer: !customer && fresh ? fresh : undefined,
        serviceId: serviceId || undefined,
        priority: Number(priority),
        notes: notes || undefined,
      });
      toast.success(`Token #${res.queueNumber} issued`);
      onAdded();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add walk-in"
      description={estimate ? (estimate.minutes === 0 ? 'A therapist is free right now.' : `Estimated wait about ${estimate.minutes} min.`) : undefined}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!customer && !(fresh?.name && fresh.phone)}>Issue token</Button></>}
    >
      <div className="space-y-4">
        {fresh ? (
          <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2">
            <Field label="Name"><Input autoFocus value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} /></Field>
            <Field label="Mobile"><Input value={fresh.phone} onChange={(e) => setFresh({ ...fresh, phone: e.target.value })} placeholder="+91..." /></Field>
            <button className="text-left text-xs text-brand-700 hover:underline sm:col-span-2" onClick={() => setFresh(null)}>Search existing customers instead</button>
          </div>
        ) : (
          <Field label="Customer">
            <CustomerPicker value={customer} onChange={setCustomer} allowNew onNew={setFresh} autoFocus />
          </Field>
        )}
        <Field label="Service (optional)">
          <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Decide later</option>
            {services?.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.durationMinutes} min</option>)}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="0">Normal</option>
              <option value="3">High</option>
              <option value="8">Urgent / VIP</option>
            </Select>
          </Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function AssignModal({ entry, therapists, services, onClose, onDone }: { entry: Entry; therapists: TherapistState[]; services: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [therapistId, setTherapistId] = useState(entry.therapist?.id ?? therapists.find((t) => t.state === 'FREE')?.id ?? '');
  const [serviceId, setServiceId] = useState(entry.service?.id ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async (start: boolean) => {
    setBusy(true);
    try {
      const res = await api.post<{ warning?: string }>(`/queue/${entry.id}/assign`, { therapistId, serviceId: serviceId || undefined });
      if (res.warning) toast.warning(res.warning);
      if (start) {
        await api.post(`/queue/${entry.id}/start`, {});
        toast.success('Session started');
      } else toast.success('Therapist assigned');
      onDone();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Assign token #${entry.queueNumber}`}
      description={entry.customer.name}
      footer={
        <>
          <Button variant="outline" onClick={() => submit(false)} loading={busy} disabled={!therapistId || !serviceId}>Assign only</Button>
          <Button variant="success" onClick={() => submit(true)} loading={busy} disabled={!therapistId || !serviceId}>Assign &amp; start</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Service">
          <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Select service</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Therapist">
          <div className="grid gap-2 sm:grid-cols-2">
            {therapists.filter((t) => t.state !== 'OFF_SHIFT').map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTherapistId(t.id)}
                className={cn('rounded-lg border px-3 py-2 text-left text-sm', therapistId === t.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50')}
              >
                <p className="font-medium">{t.name}</p>
                <p className="text-xs text-slate-500">
                  {t.state === 'FREE' ? 'Free now' : t.session?.expectedEnd ? `Free in ~${Math.max(0, minutesLeft(t.session.expectedEnd) ?? 0)} min` : titleCase(t.state)}
                </p>
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

export default function QueuePage() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const { data: branches } = useBranches();
  const branchId = useWorkingBranch(branches);
  const { data: services } = useServices({ branchId, activeOnly: true });
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState<Entry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['queue', branchId] });
  const live = useRealtime(['queue.updated', 'sessions.changed', 'appointments.changed'], refresh, branchId);
  const { data: board, isLoading } = useQuery({
    queryKey: ['queue', branchId],
    queryFn: () => api.get<QueueBoard>('/queue', { branchId: branchId! }),
    enabled: !!branchId,
    // Poll as a safety net; much faster when the socket is down.
    refetchInterval: live ? 60_000 : 10_000,
  });

  const manage = hasPermission(user, PERMISSIONS.QUEUE_MANAGE);
  const act = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(msg);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (!branchId) return <EmptyState title="Select a branch" description="Choose a branch in the top bar to open its queue." />;
  if (isLoading || !board) return <LoadingBlock />;

  const waiting = board.entries.filter((e) => ['WAITING', 'CALLED', 'ASSIGNED'].includes(e.status));
  const inService = board.entries.filter((e) => e.status === 'IN_SERVICE');
  const done = board.entries.filter((e) => ['COMPLETED', 'CANCELLED'].includes(e.status));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Walk-in queue"
        description={
          <span className="inline-flex items-center gap-2">
            {board.branch.name}
            {live ? <span className="inline-flex items-center gap-1 text-emerald-600"><Wifi className="h-3.5 w-3.5" /> Live</span> : <span className="inline-flex items-center gap-1 text-slate-400"><WifiOff className="h-3.5 w-3.5" /> Refreshing every 10s</span>}
          </span>
        }
        actions={manage && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add walk-in</Button>}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Waiting" value={board.stats.waiting} />
        <StatCard label="In service" value={board.stats.inService} />
        <StatCard label="Served today" value={board.stats.completed} />
        <StatCard label="Free therapists" value={board.stats.freeTherapists} />
        <StatCard label="Avg wait" value={`${board.stats.avgWaitMinutes} min`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Waiting" description="Ordered by priority, then token number" />
            <CardContent className="space-y-2">
              {!waiting.length && <p className="py-6 text-center text-sm text-slate-500">Nobody is waiting.</p>}
              {waiting.map((e) => (
                <div key={e.id} className={cn('flex flex-wrap items-center gap-3 rounded-lg border p-3', e.status === 'CALLED' ? 'border-violet-300 bg-violet-50' : 'border-slate-200')}>
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-lg font-bold text-white">{e.queueNumber}</div>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                      <Link href={`/customers/${e.customer.id}`} className="hover:underline">{e.customer.name}</Link>
                      {e.customer.metrics && <Badge tone={SEGMENT_TONE[e.customer.metrics.segment] ?? 'gray'}>{titleCase(e.customer.metrics.segment)}</Badge>}
                      {e.appointment && <Badge tone="blue">Booked {fmtTime(e.appointment.startTime)}</Badge>}
                      {e.priority >= 5 && <Badge tone="amber">Priority</Badge>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {e.service?.name ?? 'Service not chosen'}
                      {e.therapist && ` · ${e.therapist.name}`} · <Clock className="inline h-3 w-3" /> {e.waitingMinutes} min
                      {e.notes && ` · ${e.notes}`}
                    </p>
                  </div>
                  <StatusBadge status={e.status} />
                  {manage && (
                    <div className="flex gap-1">
                      {e.status === 'WAITING' && <Button size="sm" variant="outline" loading={busy === `call-${e.id}`} onClick={() => act(`call-${e.id}`, () => api.post(`/queue/${e.id}/call`), `Token #${e.queueNumber} called`)}><Bell className="h-3.5 w-3.5" /> Call</Button>}
                      {e.status === 'ASSIGNED' && e.therapist && e.service ? (
                        <Button size="sm" variant="success" loading={busy === `start-${e.id}`} onClick={() => act(`start-${e.id}`, () => api.post(`/queue/${e.id}/start`, {}), 'Session started')}><Play className="h-3.5 w-3.5" /> Start</Button>
                      ) : (
                        <Button size="sm" onClick={() => setAssigning(e)}><UserCheck className="h-3.5 w-3.5" /> Assign</Button>
                      )}
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:text-rose-600" aria-label="Remove from queue" onClick={() => act(`cancel-${e.id}`, () => api.post(`/queue/${e.id}/cancel`), 'Removed from queue')}><X className="h-4 w-4" /></Button>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="In service" />
            <CardContent className="space-y-2">
              {!inService.length && <p className="py-4 text-center text-sm text-slate-500">No sessions running.</p>}
              {inService.map((e) => {
                const started = e.sessions[0]?.startedAt;
                const elapsed = started ? Math.round((Date.now() - new Date(started).getTime()) / 60_000) : 0;
                return (
                  <div key={e.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-amber-500 text-lg font-bold text-white">{e.queueNumber}</div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-900">{e.customer.name}</p>
                      <p className="text-xs text-slate-600">{e.service?.name} with {e.therapist?.name} · {elapsed} of {e.service?.durationMinutes ?? '?'} min {e.sessions[0]?.status === 'PAUSED' && '(paused)'}</p>
                    </div>
                    {hasPermission(user, PERMISSIONS.SESSION_MANAGE) && (
                      <Button size="sm" variant="success" loading={busy === `done-${e.id}`} onClick={() => act(`done-${e.id}`, () => api.post(`/queue/${e.id}/complete`), 'Session completed')}><CheckCircle2 className="h-3.5 w-3.5" /> Complete</Button>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {done.length > 0 && (
            <Card>
              <CardHeader title={`Finished today (${done.length})`} />
              <CardContent className="flex flex-wrap gap-2">
                {done.map((e) => (
                  <span key={e.id} className={cn('rounded-md px-2 py-1 text-xs', e.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500 line-through')}>
                    #{e.queueNumber} {e.customer.name}
                  </span>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Therapists" />
            <CardContent className="space-y-2">
              {!board.therapists.length && <p className="text-sm text-slate-500">No therapists scheduled today.</p>}
              {board.therapists.map((t) => {
                const left = minutesLeft(t.session?.expectedEnd ?? null);
                return (
                  <div key={t.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color ?? '#94a3b8' }} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{t.name}</p>
                        {t.session && <p className="truncate text-xs text-slate-500">{t.session.customer} · {t.session.service}{left !== null && ` · ${left > 0 ? `${left} min left` : 'overrunning'}`}</p>}
                      </div>
                    </div>
                    <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', STATE_STYLE[t.state])}>{titleCase(t.state)}</span>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="Arriving soon" description="Today's upcoming bookings" />
            <CardContent className="space-y-2">
              {!board.upcoming.length && <p className="text-sm text-slate-500">No more bookings today.</p>}
              {board.upcoming.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{a.localTime} · {a.customer.name}</p>
                    <p className="truncate text-xs text-slate-500">{a.service.name}{a.therapist && ` · ${a.therapist.name}`}</p>
                  </div>
                  {manage && <Button size="sm" variant="outline" loading={busy === `ci-${a.id}`} onClick={() => act(`ci-${a.id}`, () => api.post(`/appointments/${a.id}/check-in`), `${a.customer.name} checked in`)}>Check in</Button>}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {adding && <AddWalkIn branchId={branchId} onClose={() => setAdding(false)} onAdded={refresh} />}
      {assigning && <AssignModal entry={assigning} therapists={board.therapists} services={services ?? []} onClose={() => setAssigning(null)} onDone={refresh} />}
    </div>
  );
}
