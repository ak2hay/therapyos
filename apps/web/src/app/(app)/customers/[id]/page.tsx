'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, CalendarPlus, MessageSquarePlus, Pencil, ShoppingCart, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  StatCard,
  StatusBadge,
  Table,
  Tabs,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
} from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { ago, fmtDate, fmtDateTime, money, num, titleCase } from '@/lib/format';
import { BookingModal } from '@/components/booking-modal';
import { CustomerFormModal, type CustomerRecord } from '@/components/customer-form';
import { SEGMENT_TONE } from '@/components/customer-picker';

interface CustomerDetail extends CustomerRecord {
  createdAt: string;
  metrics: {
    segment: string;
    visitCount: number;
    firstVisitAt: string | null;
    lastVisitAt: string | null;
    avgVisitIntervalDays: number | null;
    totalSpend: number;
    avgSpend: number;
    lifetimeValue: number;
    expectedLtv: number;
    noShowCount: number;
  } | null;
  packages: { id: string; expiresAt: string; package: { name: string }; items: { serviceId: string; totalQuantity: number; usedQuantity: number; service: { name: string } }[] }[];
  memberships: { id: string; expiresAt: string; plan: { name: string } }[];
  appointments: { id: string; startTime: string; status: string; service: { name: string }; therapist: { name: string } | null; branch: { name: string } }[];
  referredBy: { id: string; name: string } | null;
  outstanding: number;
  lastFeedback: { rating: number; comment: string | null; createdAt: string } | null;
}

interface Activity {
  id: string;
  type: string;
  title: string;
  occurredAt: string;
  meta: Record<string, unknown> | null;
}

interface History {
  sessions: { id: string; status: string; completedAt: string | null; createdAt: string; notes: string | null; service: { name: string }; therapist: { name: string }; branch: { name: string }; feedback: { rating: number } | null }[];
  invoices: { id: string; invoiceNumber: string; total: number; amountPaid: number; status: string; createdAt: string }[];
  appointments: { id: string; startTime: string; status: string; source: string; service: { name: string }; therapist: { name: string } | null }[];
}

const ACTIVITY_DOT: Record<string, string> = {
  SESSION_COMPLETED: 'bg-emerald-500',
  APPOINTMENT_BOOKED: 'bg-sky-500',
  APPOINTMENT_CANCELLED: 'bg-rose-400',
  APPOINTMENT_NO_SHOW: 'bg-rose-600',
  PAYMENT_RECEIVED: 'bg-emerald-600',
  NOTE: 'bg-amber-400',
  WALK_IN: 'bg-violet-500',
  CHECKED_IN: 'bg-violet-400',
};

function Timeline({ customerId }: { customerId: string }) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['customer-timeline', customerId, page],
    queryFn: () => api.page<Activity>(`/customers/${customerId}/timeline`, { page: String(page), pageSize: '20' }),
  });
  if (isLoading) return <LoadingBlock />;
  if (!data?.items.length) return <EmptyState title="No activity yet" />;
  return (
    <div>
      <ol className="relative ml-2 border-l border-slate-200">
        {data.items.map((a) => (
          <li key={a.id} className="mb-5 ml-5">
            <span className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${ACTIVITY_DOT[a.type] ?? 'bg-slate-400'}`} />
            <p className="text-sm font-medium text-slate-900">{a.title}</p>
            {a.type === 'NOTE' && typeof a.meta?.note === 'string' && <p className="mt-1 whitespace-pre-line rounded-lg bg-amber-50 px-3 py-2 text-sm text-slate-700">{a.meta.note}</p>}
            <p className="text-xs text-slate-500">
              {fmtDateTime(a.occurredAt)} · {titleCase(a.type)}
              {typeof a.meta?.by === 'string' && ` · by ${a.meta.by}`}
            </p>
          </li>
        ))}
      </ol>
      <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
    </div>
  );
}

function HistoryTab({ customerId, tab }: { customerId: string; tab: 'sessions' | 'appointments' | 'invoices' }) {
  const { data, isLoading } = useQuery({ queryKey: ['customer-history', customerId], queryFn: () => api.get<History>(`/customers/${customerId}/history`) });
  if (isLoading || !data) return <LoadingBlock />;
  if (tab === 'sessions') {
    if (!data.sessions.length) return <EmptyState title="No sessions yet" />;
    return (
      <Table>
        <THead><TR><TH>Date</TH><TH>Service</TH><TH>Therapist</TH><TH>Branch</TH><TH>Status</TH><TH>Rating</TH></TR></THead>
        <TBody>
          {data.sessions.map((s) => (
            <TR key={s.id}>
              <TD>{fmtDate(s.completedAt ?? s.createdAt)}</TD>
              <TD>
                <p>{s.service.name}</p>
                {s.notes && <p className="max-w-xs truncate text-xs text-slate-500" title={s.notes}>{s.notes}</p>}
              </TD>
              <TD>{s.therapist.name}</TD>
              <TD>{s.branch.name}</TD>
              <TD><StatusBadge status={s.status} /></TD>
              <TD>{s.feedback ? `${s.feedback.rating}/5` : '-'}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    );
  }
  if (tab === 'appointments') {
    if (!data.appointments.length) return <EmptyState title="No appointments yet" />;
    return (
      <Table>
        <THead><TR><TH>When</TH><TH>Service</TH><TH>Therapist</TH><TH>Source</TH><TH>Status</TH></TR></THead>
        <TBody>
          {data.appointments.map((a) => (
            <TR key={a.id}>
              <TD>{fmtDateTime(a.startTime)}</TD>
              <TD>{a.service.name}</TD>
              <TD>{a.therapist?.name ?? '-'}</TD>
              <TD>{titleCase(a.source)}</TD>
              <TD><StatusBadge status={a.status} /></TD>
            </TR>
          ))}
        </TBody>
      </Table>
    );
  }
  if (!data.invoices.length) return <EmptyState title="No invoices yet" />;
  return (
    <Table>
      <THead><TR><TH>Invoice</TH><TH>Date</TH><TH className="text-right">Total</TH><TH className="text-right">Paid</TH><TH>Status</TH></TR></THead>
      <TBody>
        {data.invoices.map((i) => (
          <TR key={i.id}>
            <TD><Link className="text-brand-700 hover:underline" href={`/invoices/${i.id}`}>{i.invoiceNumber}</Link></TD>
            <TD>{fmtDate(i.createdAt)}</TD>
            <TD className="text-right tabular-nums">{money(i.total)}</TD>
            <TD className="text-right tabular-nums">{money(i.amountPaid)}</TD>
            <TD><StatusBadge status={i.status} /></TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const [tab, setTab] = useState<'timeline' | 'sessions' | 'appointments' | 'invoices'>('timeline');
  const [editing, setEditing] = useState(false);
  const [booking, setBooking] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [deleting, setDeleting] = useState(false);
  const { data: c, isLoading } = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<CustomerDetail>(`/customers/${id}`) });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['customer', id] });
    void qc.invalidateQueries({ queryKey: ['customer-timeline', id] });
    void qc.invalidateQueries({ queryKey: ['customer-history', id] });
  };

  const saveNote = async () => {
    try {
      await api.post(`/customers/${id}/notes`, { note });
      toast.success('Note added');
      setNote('');
      setNoteOpen(false);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    try {
      const res = await api.delete<{ mode: string }>(`/customers/${id}`);
      toast.success(res.mode === 'deleted' ? 'Customer deleted' : 'Customer anonymised (financial records retained)');
      router.push('/customers');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (isLoading || !c) return <LoadingBlock />;
  const m = c.metrics;

  return (
    <div className="space-y-5">
      <Link href="/customers" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Customers
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.name}
            {m && <Badge tone={SEGMENT_TONE[m.segment] ?? 'gray'}>{titleCase(m.segment)}</Badge>}
            {c.status !== 'ACTIVE' && <StatusBadge status={c.status} />}
          </span>
        }
        description={`${c.customerCode} · customer since ${fmtDate(c.createdAt, 'MMM yyyy')}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {hasPermission(user, PERMISSIONS.CUSTOMER_UPDATE) && <Button variant="outline" onClick={() => setNoteOpen(true)}><MessageSquarePlus className="h-4 w-4" /> Note</Button>}
            {hasPermission(user, PERMISSIONS.CUSTOMER_UPDATE) && <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Edit</Button>}
            {hasPermission(user, PERMISSIONS.POS_USE) && c.status !== 'BLOCKED' && <Button variant="outline" onClick={() => router.push(`/pos?customer=${c.id}`)}><ShoppingCart className="h-4 w-4" /> New sale</Button>}
            {hasPermission(user, PERMISSIONS.APPOINTMENT_CREATE) && c.status !== 'BLOCKED' && <Button onClick={() => setBooking(true)}><CalendarPlus className="h-4 w-4" /> Book</Button>}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Visits" value={num(m?.visitCount)} hint={m?.lastVisitAt ? `Last ${ago(m.lastVisitAt)}` : 'No visits yet'} />
        <StatCard label="Total spend" value={money(m?.totalSpend)} hint={`Avg ${money(m?.avgSpend)} per bill`} />
        <StatCard label="Expected lifetime value" value={money(m?.expectedLtv, undefined, true)} />
        <StatCard label="Visits every" value={m?.avgVisitIntervalDays ? `${Math.round(Number(m.avgVisitIntervalDays))} days` : '-'} hint={m?.noShowCount ? `${m.noShowCount} no-shows` : 'No no-shows'} />
        <StatCard label="Outstanding" value={money(c.outstanding)} hint={c.outstanding > 0 ? 'Unpaid invoices' : 'All settled'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Profile" />
            <CardContent className="space-y-2 text-sm">
              <Row label="Phone" value={c.phone} />
              <Row label="Email" value={c.email ?? '-'} />
              <Row label="Gender" value={c.gender ? titleCase(c.gender) : '-'} />
              <Row label="Birthday" value={c.dob ? fmtDate(c.dob, 'dd MMM') : '-'} />
              <Row label="City" value={c.city ?? '-'} />
              <Row label="Source" value={titleCase(c.source)} />
              {c.referredBy && <Row label="Referred by" value={<Link className="text-brand-700 hover:underline" href={`/customers/${c.referredBy.id}`}>{c.referredBy.name}</Link>} />}
              <Row label="WhatsApp updates" value={c.whatsappOptIn ? 'Yes' : 'No'} />
              <Row label="Marketing" value={c.marketingOptIn ? 'Opted in' : 'Opted out'} />
              {c.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">{c.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>
              )}
              {c.notes && <p className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">{c.notes}</p>}
              {c.lastFeedback && (
                <p className="text-xs text-slate-500">Last feedback: {c.lastFeedback.rating}/5 {c.lastFeedback.comment && `"${c.lastFeedback.comment}"`}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="Packages & memberships" />
            <CardContent className="space-y-3 text-sm">
              {!c.packages.length && !c.memberships.length && <p className="text-slate-500">None active.</p>}
              {c.packages.map((p) => (
                <div key={p.id} className="rounded-lg border border-slate-200 p-3">
                  <p className="font-medium">{p.package.name}</p>
                  <p className="text-xs text-slate-500">Expires {fmtDate(p.expiresAt)}</p>
                  {p.items.map((i) => (
                    <p key={i.serviceId} className="mt-1 text-xs text-slate-600">
                      {i.service.name}: {i.totalQuantity - i.usedQuantity} of {i.totalQuantity} left
                    </p>
                  ))}
                </div>
              ))}
              {c.memberships.map((mm) => (
                <div key={mm.id} className="rounded-lg border border-violet-200 bg-violet-50 p-3">
                  <p className="font-medium text-violet-900">{mm.plan.name}</p>
                  <p className="text-xs text-violet-700">Valid until {fmtDate(mm.expiresAt)}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="Upcoming" />
            <CardContent className="space-y-2 text-sm">
              {!c.appointments.length && <p className="text-slate-500">No upcoming appointments.</p>}
              {c.appointments.map((a) => (
                <div key={a.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                  <div>
                    <p className="font-medium">{a.service.name}</p>
                    <p className="text-xs text-slate-500">{fmtDateTime(a.startTime)} · {a.therapist?.name ?? 'Any'} · {a.branch.name}</p>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
              ))}
            </CardContent>
          </Card>
          {hasPermission(user, PERMISSIONS.CUSTOMER_DELETE) && (
            <Button variant="ghost" className="text-rose-600" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4" /> Delete customer</Button>
          )}
        </div>

        <Card className="lg:col-span-2">
          <div className="border-b border-slate-100 px-4 pt-3">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'timeline', label: 'Timeline' },
                { value: 'sessions', label: 'Sessions' },
                { value: 'appointments', label: 'Appointments' },
                { value: 'invoices', label: 'Invoices' },
              ]}
            />
          </div>
          <CardContent>{tab === 'timeline' ? <Timeline customerId={id} /> : <HistoryTab customerId={id} tab={tab} />}</CardContent>
        </Card>
      </div>

      {editing && <CustomerFormModal open customer={c} onClose={() => setEditing(false)} onSaved={refresh} />}
      {booking && (
        <BookingModal
          open
          onClose={() => setBooking(false)}
          defaults={{ customer: { id: c.id, name: c.name, phone: c.phone, customerCode: c.customerCode }, branchId: c.primaryBranchId ?? undefined }}
          onBooked={refresh}
        />
      )}
      <Modal
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title="Add note"
        footer={<><Button variant="outline" onClick={() => setNoteOpen(false)}>Cancel</Button><Button onClick={saveNote} disabled={!note.trim()}>Save note</Button></>}
      >
        <Textarea rows={4} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Preferences, allergies, conversations..." />
      </Modal>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={remove}
        title="Delete customer?"
        message="Customers with invoices or sessions are anonymised instead of deleted so financial records stay intact. This cannot be undone."
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-slate-500">{label}</span>
      <span className="text-right text-slate-900">{value}</span>
    </div>
  );
}
