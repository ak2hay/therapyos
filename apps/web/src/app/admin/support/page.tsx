'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { LifeBuoy, MessageSquare, Send } from 'lucide-react';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, LoadingBlock, PageHeader, Select, Tabs, Textarea } from '@therapyos/ui';
import { Conversation, PRIORITY_TONE, Ticket, TICKET_STATUS } from '@/components/support-shared';
import { api, errorMessage } from '@/lib/api';
import { ago, titleCase } from '@/lib/format';

type AdminTicket = Ticket & {
  tenantId: string;
  tenant: { id: string; name: string; slug: string; email?: string | null; phone?: string | null; status?: string; subscriptionPlan?: { name: string } | null } | null;
  creator?: { id: string; name: string; email: string | null } | null;
};
const FILTERS = {
  attention: 'OPEN,IN_PROGRESS',
  waiting: 'WAITING_ON_CUSTOMER',
  done: 'RESOLVED,CLOSED',
  all: '',
} as const;
type FilterKey = keyof typeof FILTERS;

function AdminTicketPane({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin', 'support', 'ticket', id], queryFn: () => api.get<AdminTicket>(`/admin/support/${id}`), refetchInterval: 30_000 });
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data) return <LoadingBlock />;
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'support'] });
  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/support/${id}/messages`, { body: reply });
      setReply('');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const update = async (patch: { status?: string; priority?: string }) => {
    try {
      await api.patch(`/admin/support/${id}`, patch);
      toast.success('Ticket updated');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-slate-100 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold text-slate-900">{data.subject}</p>
            {data.tenant && (
              <p className="text-xs text-slate-500">
                <Link href={`/admin/tenants/${data.tenant.id}`} className="font-medium text-brand-700 hover:underline">{data.tenant.name}</Link>
                {data.tenant.subscriptionPlan ? ` · ${data.tenant.subscriptionPlan.name}` : ''}
                {data.creator ? ` · ${data.creator.name}${data.creator.email ? ` (${data.creator.email})` : ''}` : ''}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={data.status} onChange={(e) => update({ status: e.target.value })} className="h-8 w-48 text-xs" aria-label="Ticket status">
            {Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v.adminLabel}</option>)}
          </Select>
          <Select value={data.priority} onChange={(e) => update({ priority: e.target.value })} className="h-8 w-32 text-xs" aria-label="Ticket priority">
            {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}
          </Select>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4"><Conversation ticket={data} mine="ADMIN" /></div>
      <div className="flex gap-2 border-t border-slate-100 p-3">
        <Textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to the business… they are notified in the app." className="flex-1" />
        <Button onClick={send} loading={busy} disabled={!reply.trim()} aria-label="Send reply"><Send className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

function AdminSupportInner() {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get('ticket');
  const tenantId = params.get('tenantId') ?? undefined;
  const [filter, setFilter] = useState<FilterKey>(tenantId || selected ? 'all' : 'attention');
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'support', 'list', filter, tenantId],
    queryFn: () => api.page<AdminTicket>('/admin/support', { status: FILTERS[filter] || undefined, tenantId, pageSize: '50' }),
    refetchInterval: 60_000,
  });
  const summary = (data?.meta as { summary?: Record<string, number> } | undefined)?.summary ?? {};
  const count = (statuses: string) => statuses.split(',').reduce((s, k) => s + (summary[k] ?? 0), 0);
  const select = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set('ticket', id);
    router.replace(`/admin/support?${next}`);
  };
  return (
    <div className="space-y-5">
      <PageHeader title="Support" description={tenantId && data?.items[0]?.tenant ? `Tickets from ${data.items[0].tenant.name}` : 'Tickets from every business.'} />
      <Card className="grid min-h-[34rem] overflow-hidden md:grid-cols-[24rem_1fr]">
        <div className="border-b border-slate-100 md:border-b-0 md:border-r">
          <div className="border-b border-slate-100 p-2">
            <Tabs value={filter} onChange={setFilter} tabs={[
              { value: 'attention', label: `Needs reply (${count(FILTERS.attention)})` },
              { value: 'waiting', label: `Waiting (${count(FILTERS.waiting)})` },
              { value: 'done', label: 'Done' },
              { value: 'all', label: 'All' },
            ]} />
          </div>
          {isLoading ? <LoadingBlock /> : !data?.items.length ? (
            <EmptyState icon={<LifeBuoy className="h-6 w-6" />} title="Inbox zero" description="No tickets in this view." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.items.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => select(t.id)} className={`w-full px-3 py-2.5 text-left hover:bg-slate-50 ${selected === t.id ? 'bg-brand-50' : ''}`} data-testid="admin-ticket-item">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-slate-800">{t.subject}</p>
                      <Badge tone={PRIORITY_TONE[t.priority]}>{titleCase(t.priority)}</Badge>
                    </div>
                    <p className="truncate text-xs text-slate-500">{t.tenant?.name ?? 'Unknown business'}</p>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                      <Badge tone={TICKET_STATUS[t.status].tone}>{TICKET_STATUS[t.status].adminLabel}</Badge>
                      <span>{ago(t.updatedAt)}</span>
                      {!!t.messageCount && <span className="flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{t.messageCount}</span>}
                      {t.lastReplyBy === 'USER' && <span className="font-medium text-amber-700">customer replied</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-h-[24rem]">
          {selected ? <AdminTicketPane key={selected} id={selected} /> : <div className="flex h-full items-center justify-center p-6 text-sm text-slate-500">Select a ticket.</div>}
        </div>
      </Card>
    </div>
  );
}

export default function AdminSupportPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <AdminSupportInner />
    </Suspense>
  );
}
