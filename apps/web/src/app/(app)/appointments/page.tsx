'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format, parseISO } from 'date-fns';
import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, List, Plus } from 'lucide-react';
import { Button, Card, EmptyState, Input, LoadingBlock, PageHeader, StatusBadge, Table, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { cn } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { todayIso, titleCase } from '@/lib/format';
import { useBranches, useWorkingBranch } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime';
import { AppointmentDrawer } from '@/components/appointment-drawer';
import { BookingModal, type BookingDefaults } from '@/components/booking-modal';

interface BoardAppointment {
  id: string;
  status: string;
  localStart: string;
  localEnd: string;
  notes: string | null;
  source: string;
  customer: { id: string; name: string; phone: string };
  service: { id: string; name: string; color: string | null };
  therapist: { id: string; name: string; color: string | null } | null;
  queueEntry: { queueNumber: number } | null;
}

interface Board {
  date: string;
  open: string;
  close: string;
  therapists: { id: string; name: string; color: string | null; windows: { start: number; end: number }[] }[];
  appointments: BoardAppointment[];
}

const PX_PER_MIN = 1.1;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const STATUS_STYLE: Record<string, string> = {
  BOOKED: 'border-sky-300 bg-sky-50 text-sky-900',
  CONFIRMED: 'border-blue-400 bg-blue-50 text-blue-900',
  CHECKED_IN: 'border-violet-400 bg-violet-50 text-violet-900',
  IN_PROGRESS: 'border-amber-400 bg-amber-50 text-amber-900',
  COMPLETED: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  NO_SHOW: 'border-rose-300 bg-rose-50 text-rose-800 line-through',
};

export default function AppointmentsPage() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const { data: branches } = useBranches();
  const branchId = useWorkingBranch(branches);
  const [date, setDate] = useState(todayIso());
  const [view, setView] = useState<'board' | 'list'>('board');
  const [booking, setBooking] = useState<BookingDefaults | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const { data: board, isLoading } = useQuery({
    queryKey: ['appointments-board', branchId, date],
    queryFn: () => api.get<Board>('/appointments/board', { branchId: branchId!, date }),
    enabled: !!branchId,
    refetchInterval: 60_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['appointments-board'] });
  useRealtime(['appointments.changed', 'sessions.changed'], refresh, branchId);

  const canBook = hasPermission(user, PERMISSIONS.APPOINTMENT_CREATE);
  const range = useMemo(() => {
    if (!board) return { start: 540, end: 1260 };
    const starts = [toMin(board.open), ...board.appointments.map((a) => toMin(a.localStart))];
    const ends = [toMin(board.close), ...board.appointments.map((a) => toMin(a.localEnd))];
    return { start: Math.floor(Math.min(...starts) / 60) * 60, end: Math.ceil(Math.max(...ends) / 60) * 60 };
  }, [board]);
  const hours = useMemo(() => {
    const out: number[] = [];
    for (let m = range.start; m < range.end; m += 60) out.push(m);
    return out;
  }, [range]);
  const height = (range.end - range.start) * PX_PER_MIN;
  const active = board?.appointments.filter((a) => a.status !== 'CANCELLED') ?? [];
  const counts = active.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.status]: (acc[a.status] ?? 0) + 1 }), {});

  const shift = (days: number) => setDate(format(addDays(parseISO(date), days), 'yyyy-MM-dd'));
  const nowMin = date === todayIso() ? new Date().getHours() * 60 + new Date().getMinutes() : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Appointments"
        description={format(parseISO(date), 'EEEE, dd MMMM yyyy')}
        actions={canBook && <Button onClick={() => setBooking({ branchId: branchId ?? undefined, date })}><Plus className="h-4 w-4" /> New booking</Button>}
      />

      <Card className="flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" onClick={() => shift(-1)} aria-label="Previous day"><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="sm" variant="outline" onClick={() => setDate(todayIso())}>Today</Button>
          <Button size="icon" variant="outline" onClick={() => shift(1)} aria-label="Next day"><ChevronRight className="h-4 w-4" /></Button>
        </div>
        <Input type="date" className="w-40" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <div className="flex flex-wrap gap-2 text-xs text-slate-600">
          {Object.entries(counts).map(([s, n]) => (
            <span key={s} className="rounded-md bg-slate-100 px-2 py-1">{titleCase(s)}: <strong>{n}</strong></span>
          ))}
        </div>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant={view === 'board' ? 'secondary' : 'ghost'} onClick={() => setView('board')}><CalendarDays className="h-4 w-4" /> Board</Button>
          <Button size="sm" variant={view === 'list' ? 'secondary' : 'ghost'} onClick={() => setView('list')}><List className="h-4 w-4" /> List</Button>
        </div>
      </Card>

      {!branchId ? (
        <EmptyState title="Select a branch" description="Choose a branch in the top bar to see its calendar." />
      ) : isLoading || !board ? (
        <LoadingBlock />
      ) : view === 'list' ? (
        <Card>
          {!board.appointments.length ? (
            <EmptyState title="No appointments on this day" />
          ) : (
            <Table>
              <THead><TR><TH>Time</TH><TH>Customer</TH><TH>Service</TH><TH>Therapist</TH><TH>Source</TH><TH>Status</TH></TR></THead>
              <TBody>
                {board.appointments.map((a) => (
                  <TR key={a.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setSelected(a.id)}>
                    <TD className="tabular-nums">{a.localStart} - {a.localEnd}</TD>
                    <TD><p className="font-medium">{a.customer.name}</p><p className="text-xs text-slate-500">{a.customer.phone}</p></TD>
                    <TD>{a.service.name}</TD>
                    <TD>{a.therapist?.name ?? '-'}</TD>
                    <TD>{titleCase(a.source)}</TD>
                    <TD><StatusBadge status={a.status} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      ) : !board.therapists.length ? (
        <EmptyState title="No therapists at this branch" description="Add therapists and their weekly schedule to start taking bookings." />
      ) : (
        <Card className="overflow-x-auto">
          <div className="flex min-w-max">
            <div className="sticky left-0 z-10 w-16 shrink-0 border-r border-slate-200 bg-white">
              <div className="h-12 border-b border-slate-200" />
              <div className="relative" style={{ height }}>
                {hours.map((m) => (
                  <div key={m} className="absolute right-2 -translate-y-2 text-[11px] text-slate-400" style={{ top: (m - range.start) * PX_PER_MIN }}>{fmtMin(m)}</div>
                ))}
              </div>
            </div>
            {board.therapists.map((t) => {
              const mine = active.filter((a) => a.therapist?.id === t.id);
              return (
                <div key={t.id} className="w-48 shrink-0 border-r border-slate-100">
                  <div className="flex h-12 items-center gap-2 border-b border-slate-200 px-3">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color ?? '#94a3b8' }} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">{t.name}</p>
                      <p className="text-[11px] text-slate-500">{t.windows.length ? t.windows.map((w) => `${fmtMin(w.start)}-${fmtMin(w.end)}`).join(', ') : 'Off today'}</p>
                    </div>
                  </div>
                  <div
                    className={cn('relative', t.windows.length ? 'bg-slate-50/60' : 'bg-slate-100')}
                    style={{ height }}
                    onClick={(e) => {
                      if (!canBook) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const minute = range.start + Math.floor((e.clientY - rect.top) / PX_PER_MIN / 15) * 15;
                      setBooking({ branchId, date, therapistId: t.id, time: fmtMin(minute) });
                    }}
                  >
                    {t.windows.map((w) => (
                      <div key={w.start} className="absolute inset-x-0 bg-white" style={{ top: (w.start - range.start) * PX_PER_MIN, height: (w.end - w.start) * PX_PER_MIN }} />
                    ))}
                    {hours.map((m) => (
                      <div key={m} className="pointer-events-none absolute inset-x-0 border-t border-slate-100" style={{ top: (m - range.start) * PX_PER_MIN }} />
                    ))}
                    {nowMin !== null && nowMin >= range.start && nowMin <= range.end && (
                      <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-rose-400" style={{ top: (nowMin - range.start) * PX_PER_MIN }} />
                    )}
                    {mine.map((a) => {
                      const top = (toMin(a.localStart) - range.start) * PX_PER_MIN;
                      const h = Math.max(24, (toMin(a.localEnd) - toMin(a.localStart)) * PX_PER_MIN - 2);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(a.id);
                          }}
                          className={cn('absolute inset-x-1 z-20 overflow-hidden rounded-md border-l-4 px-2 py-1 text-left text-xs shadow-sm transition hover:shadow', STATUS_STYLE[a.status] ?? 'border-slate-300 bg-white')}
                          style={{ top, height: h }}
                        >
                          <p className="truncate font-semibold">{a.customer.name}</p>
                          <p className="truncate opacity-80">{a.localStart} · {a.service.name}</p>
                          {a.queueEntry && <p className="truncate opacity-70">Token #{a.queueEntry.queueNumber}</p>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {booking && <BookingModal open onClose={() => setBooking(null)} defaults={booking} onBooked={refresh} />}
      {selected && <AppointmentDrawer id={selected} onClose={() => setSelected(null)} onChanged={refresh} />}
    </div>
  );
}
