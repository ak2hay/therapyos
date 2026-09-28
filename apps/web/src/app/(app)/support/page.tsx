'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { LifeBuoy, MessageSquare, Plus, Send } from 'lucide-react';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, Field, Input, LoadingBlock, Modal, PageHeader, Select, Tabs, Textarea } from '@therapyos/ui';
import { Conversation, PRIORITY_TONE, Ticket, TICKET_STATUS } from '@/components/support-shared';
import { api, errorMessage } from '@/lib/api';
import { ago, titleCase } from '@/lib/format';

function NewTicketModal({ onClose }: { onClose: (id?: string) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ subject: '', description: '', priority: 'MEDIUM' });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const t = await api.post<Ticket>('/support/tickets', form);
      toast.success('Ticket created', { description: 'Our team usually replies within one business day.' });
      await qc.invalidateQueries({ queryKey: ['support'] });
      onClose(t.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={() => onClose()} title="Contact support" size="md" footer={<><Button variant="outline" onClick={() => onClose()}>Cancel</Button><Button onClick={submit} loading={busy} disabled={form.subject.length < 3 || form.description.length < 3}>Submit ticket</Button></>}>
      <div className="space-y-3">
        <Field label="Subject"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Short summary of the issue" /></Field>
        <Field label="Priority">
          <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            <option value="LOW">Low: a question or suggestion</option>
            <option value="MEDIUM">Medium: something is not working as expected</option>
            <option value="HIGH">High: it is affecting daily work</option>
            <option value="URGENT">Urgent: we cannot operate</option>
          </Select>
        </Field>
        <Field label="Details" hint="What happened, what you expected, and the steps to reproduce it.">
          <Textarea rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function TicketPane({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['support', 'ticket', id], queryFn: () => api.get<Ticket>(`/support/tickets/${id}`), refetchInterval: 30_000 });
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data) return <LoadingBlock />;
  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/support/tickets/${id}/messages`, { body: reply });
      setReply('');
      await qc.invalidateQueries({ queryKey: ['support'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    try {
      await api.post(`/support/tickets/${id}/close`);
      toast.success('Ticket closed');
      await qc.invalidateQueries({ queryKey: ['support'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-4">
        <div>
          <p className="font-semibold text-slate-900">{data.subject}</p>
          <div className="mt-1 flex gap-1.5"><Badge tone={TICKET_STATUS[data.status].tone}>{TICKET_STATUS[data.status].label}</Badge><Badge tone={PRIORITY_TONE[data.priority]}>{titleCase(data.priority)}</Badge></div>
        </div>
        {data.status !== 'CLOSED' && <Button size="sm" variant="ghost" onClick={close}>Close ticket</Button>}
      </div>
      <div className="flex-1 overflow-y-auto p-4"><Conversation ticket={data} mine="USER" /></div>
      {data.status !== 'CLOSED' ? (
        <div className="flex gap-2 border-t border-slate-100 p-3">
          <Textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" className="flex-1" />
          <Button onClick={send} loading={busy} disabled={!reply.trim()} aria-label="Send reply"><Send className="h-4 w-4" /></Button>
        </div>
      ) : (
        <p className="border-t border-slate-100 p-3 text-center text-xs text-slate-500">This ticket is closed. Open a new ticket if you need more help.</p>
      )}
    </div>
  );
}

function SupportInner() {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get('ticket');
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['support', 'list', filter],
    queryFn: () => api.page<Ticket>('/support/tickets', { status: filter === 'active' ? 'OPEN,IN_PROGRESS,WAITING_ON_CUSTOMER' : undefined, pageSize: '50' }),
  });
  const select = (id: string) => router.replace(`/support?ticket=${id}`);
  return (
    <div className="space-y-5">
      <PageHeader title="Support" description="Questions, problems or feature requests: our team replies here and notifies you in the app." actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New ticket</Button>} />
      <Card className="grid min-h-[32rem] overflow-hidden md:grid-cols-[22rem_1fr]">
        <div className="border-b border-slate-100 md:border-b-0 md:border-r">
          <div className="border-b border-slate-100 p-2"><Tabs value={filter} onChange={setFilter} tabs={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All tickets' }]} /></div>
          {isLoading ? <LoadingBlock /> : !data?.items.length ? (
            <EmptyState icon={<LifeBuoy className="h-6 w-6" />} title="No tickets" description="Need help? Open a ticket and we will get back to you." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.items.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => select(t.id)} className={`w-full px-3 py-2.5 text-left hover:bg-slate-50 ${selected === t.id ? 'bg-brand-50' : ''}`} data-testid="ticket-item">
                    <p className="truncate text-sm font-medium text-slate-800">{t.subject}</p>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                      <Badge tone={TICKET_STATUS[t.status].tone}>{TICKET_STATUS[t.status].label}</Badge>
                      <span>{ago(t.updatedAt)}</span>
                      {!!t.messageCount && <span className="flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{t.messageCount}</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-h-[24rem]">
          {selected ? <TicketPane key={selected} id={selected} /> : <div className="flex h-full items-center justify-center p-6 text-sm text-slate-500">Select a ticket to see the conversation.</div>}
        </div>
      </Card>
      {creating && <NewTicketModal onClose={(id) => { setCreating(false); if (id) select(id); }} />}
    </div>
  );
}

export default function SupportPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <SupportInner />
    </Suspense>
  );
}
