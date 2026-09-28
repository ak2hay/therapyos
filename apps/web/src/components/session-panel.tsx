'use client';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Pause, Play, Plus, Receipt, X, XCircle } from 'lucide-react';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { Button, Field, Input, Modal, Select, StatusBadge, Textarea } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { hasFeature, hasPermission, useAuth } from '@/lib/auth-store';
import { fmtDate, fmtDateTime } from '@/lib/format';

export interface SessionDetail {
  id: string;
  status: string;
  room: string | null;
  notes: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  totalPausedSeconds: number;
  elapsedSeconds: number;
  invoiceId?: string | null;
  customer: { id: string; name: string; phone: string; customerCode: string };
  service: { id: string; name: string; durationMinutes: number };
  therapist: { id: string; name: string };
  branch: { id: string; name: string };
  feedback: { rating: number; comment: string | null } | null;
  previousSessions?: { id: string; completedAt: string | null; notes: string | null; service: { name: string }; therapist: { name: string } }[];
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Ticking elapsed time for a running session (server value + local drift). */
export function useElapsed(session: Pick<SessionDetail, 'status' | 'elapsedSeconds'> | null | undefined) {
  const [base, setBase] = useState({ at: Date.now(), elapsed: session?.elapsedSeconds ?? 0 });
  const [, tick] = useState(0);
  useEffect(() => setBase({ at: Date.now(), elapsed: session?.elapsedSeconds ?? 0 }), [session?.elapsedSeconds, session?.status]);
  useEffect(() => {
    if (session?.status !== 'IN_PROGRESS') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [session?.status]);
  return session?.status === 'IN_PROGRESS' ? base.elapsed + (Date.now() - base.at) / 1000 : base.elapsed;
}

export function SessionControls({ session, onChanged, compact }: { session: SessionDetail; onChanged: () => void; compact?: boolean }) {
  const user = useAuth((s) => s.user);
  const router = useRouter();
  const elapsed = useElapsed(session);
  const [busy, setBusy] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notes, setNotes] = useState(session.notes ?? '');
  const [reason, setReason] = useState('');
  const target = session.service.durationMinutes * 60;
  const pct = Math.min(100, (elapsed / target) * 100);
  const canManage = hasPermission(user, PERMISSIONS.SESSION_MANAGE);
  const trackStock = hasFeature(user, FeatureFlagKey.INVENTORY_ENABLED);
  const [used, setUsed] = useState<{ productId: string; quantity: string }[]>([]);
  const { data: products } = useQuery({
    queryKey: ['products', 'consumable'],
    queryFn: () => api.get<{ id: string; name: string; unit: string }[]>('/products', { consumable: 'true' }),
    enabled: completing && trackStock,
    staleTime: 300_000,
  });

  const act = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(msg);
      onChanged();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const bill = async () => {
    setBusy('bill');
    try {
      const cart = await api.post<{ id: string }>('/invoices/from-session', { sessionId: session.id });
      router.push(`/pos?cart=${cart.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  };

  const running = ['IN_PROGRESS', 'PAUSED'].includes(session.status);
  return (
    <div className="space-y-3">
      {(running || session.status === 'COMPLETED') && (
        <div>
          <div className="flex items-end justify-between">
            <p className={compact ? 'text-2xl font-semibold tabular-nums' : 'text-4xl font-semibold tabular-nums'}>{formatDuration(elapsed)}</p>
            <p className="text-xs text-slate-500">of {session.service.durationMinutes} min {session.status === 'PAUSED' && '· paused'}</p>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full transition-all ${elapsed > target ? 'bg-rose-500' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          {session.status === 'SCHEDULED' && <Button size="sm" variant="success" loading={busy === 'start'} onClick={() => act('start', () => api.post(`/sessions/${session.id}/start`), 'Session started')}><Play className="h-4 w-4" /> Start</Button>}
          {session.status === 'IN_PROGRESS' && <Button size="sm" variant="outline" loading={busy === 'pause'} onClick={() => act('pause', () => api.post(`/sessions/${session.id}/pause`), 'Paused')}><Pause className="h-4 w-4" /> Pause</Button>}
          {session.status === 'PAUSED' && <Button size="sm" variant="outline" loading={busy === 'resume'} onClick={() => act('resume', () => api.post(`/sessions/${session.id}/resume`), 'Resumed')}><Play className="h-4 w-4" /> Resume</Button>}
          {running && <Button size="sm" variant="success" onClick={() => setCompleting(true)}><CheckCircle2 className="h-4 w-4" /> Complete</Button>}
          {(running || session.status === 'SCHEDULED') && <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => setCancelling(true)}><XCircle className="h-4 w-4" /> Cancel</Button>}
        </div>
      )}
      {session.status === 'COMPLETED' && session.invoiceId && hasPermission(user, PERMISSIONS.INVOICE_READ) && (
        <Button size="sm" variant="outline" onClick={() => router.push(`/invoices/${session.invoiceId}`)}><Receipt className="h-4 w-4" /> View invoice</Button>
      )}
      {session.status === 'COMPLETED' && !session.invoiceId && hasPermission(user, PERMISSIONS.POS_USE) && (
        <Button size="sm" loading={busy === 'bill'} onClick={bill}><Receipt className="h-4 w-4" /> Bill this session</Button>
      )}

      <Modal
        open={completing}
        onClose={() => setCompleting(false)}
        title="Complete session"
        description={`${session.service.name} for ${session.customer.name}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setCompleting(false)}>Back</Button>
            <Button
              variant="success"
              loading={busy === 'complete'}
              onClick={async () => {
                const productsUsed = used.filter((u) => u.productId && Number(u.quantity) > 0).map((u) => ({ productId: u.productId, quantity: Number(u.quantity) }));
                if (await act('complete', () => api.post(`/sessions/${session.id}/complete`, { notes: notes || undefined, productsUsed: productsUsed.length ? productsUsed : undefined }), 'Session completed')) setCompleting(false);
              }}
            >
              Complete session
            </Button>
          </>
        }
      >
        <Field label="Session notes" hint="Visible to therapists and managers on the customer's history">
          <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Pressure used, focus areas, recommendations..." />
        </Field>
        {trackStock && (
          <div className="mt-4">
            <p className="text-sm font-medium text-slate-700">Extra products used</p>
            <p className="mb-2 text-xs text-slate-500">The service&apos;s standard consumables are deducted automatically. Add anything used on top.</p>
            {used.map((u, i) => (
              <div key={i} className="mb-2 grid grid-cols-[1fr_6rem_2.25rem] gap-2">
                <Select value={u.productId} onChange={(e) => setUsed((l) => l.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))} aria-label="Product">
                  <option value="">Select a product</option>
                  {products?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Input type="number" min="0" step="any" value={u.quantity} onChange={(e) => setUsed((l) => l.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} placeholder={products?.find((p) => p.id === u.productId)?.unit} aria-label="Quantity" />
                <Button variant="ghost" size="icon" onClick={() => setUsed((l) => l.filter((_, j) => j !== i))} aria-label="Remove product"><X className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setUsed((l) => [...l, { productId: '', quantity: '1' }])}><Plus className="h-3.5 w-3.5" /> Add product</Button>
          </div>
        )}
      </Modal>
      <Modal
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel session?"
        description="The customer goes back to the queue (or checked-in state) so they can be re-assigned."
        footer={
          <>
            <Button variant="outline" onClick={() => setCancelling(false)}>Back</Button>
            <Button variant="danger" loading={busy === 'cancel'} onClick={async () => (await act('cancel', () => api.post(`/sessions/${session.id}/cancel`, { reason: reason || undefined }), 'Session cancelled')) && setCancelling(false)}>Cancel session</Button>
          </>
        }
      >
        <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

export function SessionDetailBody({ session, onChanged }: { session: SessionDetail; onChanged: () => void }) {
  const user = useAuth((s) => s.user);
  const [notes, setNotes] = useState(session.notes ?? '');
  const [saving, setSaving] = useState(false);
  const saveNotes = async () => {
    setSaving(true);
    try {
      await api.patch(`/sessions/${session.id}/notes`, { notes });
      toast.success('Notes saved');
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-slate-900">{session.customer.name}</p>
          <p className="text-xs text-slate-500">{session.customer.customerCode} · {session.customer.phone}</p>
        </div>
        <StatusBadge status={session.status} />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        <dt className="text-slate-500">Service</dt><dd>{session.service.name}</dd>
        <dt className="text-slate-500">Therapist</dt><dd>{session.therapist.name}</dd>
        <dt className="text-slate-500">Branch</dt><dd>{session.branch.name}{session.room && ` · ${session.room}`}</dd>
        <dt className="text-slate-500">Started</dt><dd>{session.startedAt ? fmtDateTime(session.startedAt) : '-'}</dd>
        {session.completedAt && (<><dt className="text-slate-500">Completed</dt><dd>{fmtDateTime(session.completedAt)}</dd></>)}
        {session.feedback && (<><dt className="text-slate-500">Rating</dt><dd>{session.feedback.rating}/5 {session.feedback.comment && `"${session.feedback.comment}"`}</dd></>)}
      </dl>
      <SessionControls session={session} onChanged={onChanged} />
      {hasPermission(user, PERMISSIONS.SESSION_NOTES) && session.status !== 'CANCELLED' && (
        <Field label="Notes">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="mt-2 flex justify-end"><Button size="sm" variant="outline" loading={saving} disabled={notes === (session.notes ?? '')} onClick={saveNotes}>Save notes</Button></div>
        </Field>
      )}
      {!!session.previousSessions?.length && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Previous visits</p>
          <div className="space-y-2">
            {session.previousSessions.map((p) => (
              <div key={p.id} className="rounded-lg bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500">{fmtDate(p.completedAt)} · {p.service.name} · {p.therapist.name}</p>
                {p.notes && <p className="text-slate-700">{p.notes}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
