'use client';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { PERMISSIONS } from '@therapyos/types';
import { Card, EmptyState, Input, LoadingBlock, Modal, PageHeader, Pagination, Select, StatusBadge, Table, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { api } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { fmtDateTime, todayIso } from '@/lib/format';
import { useTherapists } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime';
import { formatDuration, SessionDetailBody, type SessionDetail } from '@/components/session-panel';

interface SessionRow {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  totalPausedSeconds: number;
  room: string | null;
  customer: { id: string; name: string };
  service: { name: string; durationMinutes: number };
  therapist: { id: string; name: string };
  branch: { name: string };
  feedback: { rating: number } | null;
}

function duration(s: SessionRow) {
  if (!s.startedAt) return '-';
  const end = s.completedAt ? new Date(s.completedAt) : new Date();
  return formatDuration((end.getTime() - new Date(s.startedAt).getTime()) / 1000 - s.totalPausedSeconds);
}

export default function SessionsPage() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const branchId = useBranch((s) => s.branchId);
  const readAll = hasPermission(user, PERMISSIONS.SESSION_READ);
  const { data: therapists } = useTherapists({ branchId, activeOnly: true });
  const [filters, setFilters] = useState({ date: todayIso(), status: '', therapistId: '' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['sessions', filters, page, branchId],
    queryFn: () =>
      api.page<SessionRow>('/sessions', {
        date: filters.date || undefined,
        status: filters.status || undefined,
        therapistId: filters.therapistId || undefined,
        branchId: branchId ?? undefined,
        mine: readAll ? undefined : 'true',
        page: String(page),
        pageSize: '25',
      }),
    placeholderData: keepPreviousData,
  });
  const { data: detail, refetch } = useQuery({
    queryKey: ['session', selected],
    queryFn: () => api.get<SessionDetail>(`/sessions/${selected}`),
    enabled: !!selected,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sessions'] });
    if (selected) void refetch();
  };
  useRealtime(['sessions.changed'], refresh, branchId);

  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Therapy sessions" description={readAll ? 'All sessions across your branches' : 'Your sessions'} />
      <Card className="grid gap-3 p-4 sm:grid-cols-4">
        <Input type="date" value={filters.date} onChange={set('date')} />
        <Select value={filters.status} onChange={set('status')}>
          <option value="">Any status</option>
          <option value="IN_PROGRESS,PAUSED">Running</option>
          <option value="SCHEDULED">Scheduled</option>
          <option value="COMPLETED">Completed</option>
          <option value="CANCELLED">Cancelled</option>
        </Select>
        {readAll && (
          <Select value={filters.therapistId} onChange={set('therapistId')}>
            <option value="">All therapists</option>
            {therapists?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        )}
      </Card>
      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.items.length ? (
          <EmptyState icon={<ClipboardList className="h-6 w-6" />} title="No sessions" description="Sessions start from the queue or a checked-in appointment." />
        ) : (
          <>
            <Table>
              <THead><TR><TH>Started</TH><TH>Customer</TH><TH>Service</TH><TH>Therapist</TH><TH>Duration</TH><TH>Status</TH><TH>Rating</TH></TR></THead>
              <TBody>
                {data.items.map((s) => (
                  <TR key={s.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setSelected(s.id)}>
                    <TD>{fmtDateTime(s.startedAt ?? s.createdAt)}</TD>
                    <TD className="font-medium">{s.customer.name}</TD>
                    <TD>{s.service.name}</TD>
                    <TD>{s.therapist.name}</TD>
                    <TD className="tabular-nums">{duration(s)}</TD>
                    <TD><StatusBadge status={s.status} /></TD>
                    <TD>{s.feedback ? `${s.feedback.rating}/5` : '-'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
          </>
        )}
      </Card>
      {selected && (
        <Modal open onClose={() => setSelected(null)} title="Session" size="md">
          {detail ? <SessionDetailBody session={detail} onChanged={refresh} /> : <LoadingBlock />}
        </Modal>
      )}
    </div>
  );
}
