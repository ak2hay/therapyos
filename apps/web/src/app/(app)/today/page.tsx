'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Play, Sun } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, EmptyState, LoadingBlock, PageHeader, StatCard, StatusBadge } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { fmtTime, money } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { SessionDetailBody, type SessionDetail } from '@/components/session-panel';

interface MyDay {
  date: string;
  activeSession: SessionDetail | null;
  appointments: { id: string; status: string; localStart: string; localEnd: string; notes: string | null; customer: { id: string; name: string }; service: { id: string; name: string; durationMinutes: number }; branch: { id: string; name: string } }[];
  assignedQueue: { id: string; branchId: string; queueNumber: number; status: string; customer: { id: string; name: string }; service: { id: string; name: string } | null }[];
  completed: { id: string; completedAt: string; customer: { name: string }; service: { name: string }; feedback: { rating: number } | null }[];
  stats: { appointments: number; completedToday: number; monthSessions: number; monthCommission: number };
}

export default function TodayPage() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['my-day'],
    queryFn: () => api.get<MyDay>('/sessions/my-day'),
    enabled: !!user?.therapistId,
    refetchInterval: 60_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['my-day'] });
  useRealtime(['sessions.changed', 'queue.updated', 'appointments.changed'], refresh);

  const start = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      toast.success('Session started');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (!user?.therapistId) {
    return <EmptyState icon={<Sun className="h-6 w-6" />} title="My Day is for therapists" description="Your account is not linked to a therapist profile." />;
  }
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <EmptyState title="Could not load your day" description={errorMessage(error)} />;

  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const upcoming = data.appointments.filter((a) => ['BOOKED', 'CONFIRMED', 'CHECKED_IN'].includes(a.status));

  return (
    <div className="space-y-5">
      <PageHeader title={`${greeting}, ${user.name.split(' ')[0]}`} description="Your appointments, walk-ins and sessions for today" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Appointments today" value={data.stats.appointments} />
        <StatCard label="Completed today" value={data.stats.completedToday} />
        <StatCard label="Sessions this month" value={data.stats.monthSessions} />
        <StatCard label="Commission this month" value={money(data.stats.monthCommission)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Current session" />
            <CardContent>
              {data.activeSession ? (
                <SessionDetailBody session={data.activeSession} onChanged={refresh} />
              ) : (
                <p className="py-6 text-center text-sm text-slate-500">No session running. Start one from your queue or appointments.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="Appointments" />
            <CardContent className="space-y-2">
              {!data.appointments.length && <p className="py-4 text-center text-sm text-slate-500">No appointments today.</p>}
              {data.appointments.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3">
                  <div className="w-24 text-sm font-semibold tabular-nums">{a.localStart}<span className="block text-xs font-normal text-slate-500">to {a.localEnd}</span></div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{a.customer.name}</p>
                    <p className="text-xs text-slate-500">{a.service.name} · {a.branch.name}{a.notes && ` · ${a.notes}`}</p>
                  </div>
                  <StatusBadge status={a.status} />
                  {upcoming.includes(a) && !data.activeSession && (
                    <Button size="sm" variant="success" loading={busy === a.id} onClick={() => start(a.id, () => api.post(`/appointments/${a.id}/start`, {}))}><Play className="h-3.5 w-3.5" /> Start</Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Walk-ins assigned to you" />
            <CardContent className="space-y-2">
              {!data.assignedQueue.length && <p className="text-sm text-slate-500">None right now.</p>}
              {data.assignedQueue.map((q) => (
                <div key={q.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">#{q.queueNumber} {q.customer.name}</p>
                    <p className="text-xs text-slate-500">{q.service?.name ?? 'Service not set'}</p>
                  </div>
                  {q.service && !data.activeSession && (
                    <Button
                      size="sm"
                      variant="success"
                      loading={busy === q.id}
                      onClick={() => start(q.id, () => api.post('/sessions', { branchId: q.branchId, customerId: q.customer.id, therapistId: user.therapistId, serviceId: q.service!.id, queueEntryId: q.id, startNow: true }))}
                    >
                      Start
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="Completed today" />
            <CardContent className="space-y-2">
              {!data.completed.length && <p className="text-sm text-slate-500">Nothing yet.</p>}
              {data.completed.map((s) => (
                <div key={s.id} className="flex items-center justify-between text-sm">
                  <span>{fmtTime(s.completedAt)} · {s.customer.name}<span className="block text-xs text-slate-500">{s.service.name}</span></span>
                  {s.feedback && <span className="text-xs text-amber-600">{s.feedback.rating}/5</span>}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
