'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Mail, MessageCircle, MessageSquare, Pencil, RotateCcw, Send } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Pagination,
  Select,
  StatCard,
  Table,
  Tabs,
  TBody,
  TD,
  TH,
  THead,
  Textarea,
  TR,
} from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime, titleCase } from '@/lib/format';

type Channel = 'WHATSAPP' | 'SMS' | 'EMAIL';
const CHANNELS: Channel[] = ['WHATSAPP', 'SMS', 'EMAIL'];
const CHANNEL_ICON = { WHATSAPP: MessageCircle, SMS: MessageSquare, EMAIL: Mail } as const;
const CHANNEL_LABEL: Record<Channel, string> = { WHATSAPP: 'WhatsApp', SMS: 'SMS', EMAIL: 'Email' };

interface TemplateRow {
  id: string;
  tenantId: string | null;
  name: string;
  subject: string | null;
  body: string;
  whatsappTemplateName: string | null;
  isActive: boolean;
}
interface TemplateEvent {
  event: string;
  channels: Array<{ channel: Channel; system: TemplateRow | null; custom: TemplateRow | null; effective: TemplateRow | null; active: boolean }>;
}
interface Preview {
  valid: boolean;
  error?: string;
  subject?: string | null;
  html?: string;
  text?: string;
  unknownVariables?: string[];
}

const EVENT_HELP: Record<string, string> = {
  APPOINTMENT_BOOKED: 'Sent when an appointment is booked (not for walk-ins).',
  APPOINTMENT_REMINDER: 'Sent before the appointment, per the reminder setting.',
  APPOINTMENT_CANCELLED: 'Sent when an upcoming appointment is cancelled.',
  SESSION_COMPLETED: 'Thank-you after a session (only when feedback requests are off).',
  PAYMENT_RECEIVED: 'Receipt for every payment against an invoice.',
  PACKAGE_EXPIRING: 'Warns customers with unused package sessions before expiry.',
  MEMBERSHIP_EXPIRING: 'Renewal reminder for non auto-renewing memberships.',
  BIRTHDAY: 'Birthday wishes (marketing consent required).',
  WIN_BACK: 'Automatic win-back when a customer becomes inactive (marketing consent required).',
  LOW_STOCK: 'Emailed to inventory staff when stock falls below reorder level.',
  FEEDBACK_REQUEST: 'Asks for a rating after each session with a one-tap link.',
};

function TemplateEditor({ event, channel, row, variables, onClose }: { event: string; channel: Channel; row: TemplateRow | null; variables: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: row?.name ?? titleCase(event), subject: row?.subject ?? '', body: row?.body ?? '', whatsappTemplateName: row?.whatsappTemplateName ?? '', isActive: row?.isActive ?? true });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!form.body) return setPreview(null);
    const t = setTimeout(() => {
      api
        .post<Preview>('/notifications/templates/preview', { event, body: form.body, subject: channel === 'EMAIL' ? form.subject : undefined })
        .then(setPreview)
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(t);
  }, [form.body, form.subject, event, channel]);

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/notifications/templates', { event, channel, ...form, language: 'en' });
      toast.success('Template saved');
      await qc.invalidateQueries({ queryKey: ['notification-templates'] });
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
      size="xl"
      title={`${titleCase(event)} · ${CHANNEL_LABEL[channel]}`}
      description="Saving creates your own version; the system default stays available to restore."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={preview?.valid === false}>Save template</Button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          {channel === 'EMAIL' && <Field label="Subject"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>}
          <Field label="Message" hint={channel === 'EMAIL' ? 'HTML is allowed.' : 'Plain text.'}>
            <Textarea rows={channel === 'EMAIL' ? 9 : 6} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} className="font-mono text-xs" />
          </Field>
          {channel === 'WHATSAPP' && (
            <Field label="Approved WhatsApp template name" hint="Optional. With the WhatsApp Cloud API, business-initiated messages must use a Meta-approved template.">
              <Input value={form.whatsappTemplateName} onChange={(e) => setForm({ ...form, whatsappTemplateName: e.target.value })} placeholder="appointment_confirmation" />
            </Field>
          )}
          <Checkbox label="Active (untick to stop sending on this channel)" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500">Variables (click to insert)</p>
            <div className="flex flex-wrap gap-1">
              {variables.map((v) => (
                <button key={v} type="button" onClick={() => setForm((f) => ({ ...f, body: `${f.body}{{${v}}}` }))} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 hover:bg-brand-100">
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">Preview with sample data</p>
          {preview?.valid === false ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">Template error: {preview.error}</div>
          ) : channel === 'EMAIL' ? (
            <div className="rounded-lg border border-slate-200">
              <div className="border-b border-slate-100 px-3 py-2 text-sm font-medium">{preview?.subject}</div>
              <div className="prose prose-sm max-w-none p-3" dangerouslySetInnerHTML={{ __html: preview?.html ?? '' }} />
            </div>
          ) : (
            <div className="rounded-xl bg-[#e5ddd5] p-4">
              <div className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-white px-3 py-2 text-sm shadow-sm" data-testid="template-preview">{preview?.text}</div>
            </div>
          )}
          {!!preview?.unknownVariables?.length && <p className="mt-2 text-xs text-amber-600">Unknown variables will render empty: {preview.unknownVariables.join(', ')}</p>}
        </div>
      </div>
    </Modal>
  );
}

function TemplatesPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['notification-templates'], queryFn: () => api.get<{ events: TemplateEvent[]; variables: string[] }>('/notifications/templates') });
  const [editing, setEditing] = useState<{ event: string; channel: Channel; row: TemplateRow | null } | null>(null);
  if (isLoading || !data) return <LoadingBlock />;
  const reset = async (id: string) => {
    try {
      await api.delete(`/notifications/templates/${id}`);
      toast.success('Restored the default template');
      await qc.invalidateQueries({ queryKey: ['notification-templates'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Card>
      <CardHeader title="Message templates" description="What customers receive for each event. When WhatsApp is off or a customer opted out, WhatsApp copy is sent by SMS instead." />
      <Table>
        <THead><TR><TH>Event</TH>{CHANNELS.map((c) => <TH key={c}>{CHANNEL_LABEL[c]}</TH>)}</TR></THead>
        <TBody>
          {data.events.map((e) => (
            <TR key={e.event}>
              <TD className="max-w-xs">
                <p className="font-medium">{titleCase(e.event)}</p>
                <p className="text-xs text-slate-500">{EVENT_HELP[e.event]}</p>
              </TD>
              {e.channels.map((c) => {
                const Icon = CHANNEL_ICON[c.channel];
                return (
                  <TD key={c.channel}>
                    <div className="flex items-center gap-1.5">
                      {c.effective ? (
                        <>
                          <Icon className={`h-4 w-4 ${c.active ? 'text-emerald-600' : 'text-slate-300'}`} />
                          {c.custom ? <Badge tone="brand">Custom</Badge> : <Badge>Default</Badge>}
                          {!c.active && <Badge tone="amber">Off</Badge>}
                        </>
                      ) : (
                        <span className="text-xs text-slate-400">Not set</span>
                      )}
                      <Button size="icon" variant="ghost" aria-label={`Edit ${e.event} ${c.channel}`} onClick={() => setEditing({ event: e.event, channel: c.channel, row: c.effective })}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {c.custom && (
                        <Button size="icon" variant="ghost" aria-label="Restore default" onClick={() => reset(c.custom!.id)}>
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TD>
                );
              })}
            </TR>
          ))}
        </TBody>
      </Table>
      {editing && <TemplateEditor {...editing} variables={data.variables} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function PreferencesPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['notification-preferences'], queryFn: () => api.get<Array<{ event: string; channels: Record<Channel, boolean> }>>('/notifications/preferences') });
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setLocal(Object.fromEntries(data.flatMap((d) => CHANNELS.map((c) => [`${d.event}:${c}`, d.channels[c]]))));
  }, [data]);
  if (isLoading || !data) return <LoadingBlock />;
  const save = async () => {
    setBusy(true);
    try {
      const preferences = Object.entries(local).map(([k, enabled]) => {
        const [event, channel] = k.split(':');
        return { event, channel, enabled };
      });
      await api.put('/notifications/preferences', { preferences });
      await qc.invalidateQueries({ queryKey: ['notification-preferences'] });
      toast.success('Preferences saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Channel preferences" description="Switch individual messages off per channel. Customer consent (marketing and WhatsApp opt-in) is always respected on top of this." actions={<Button size="sm" onClick={save} loading={busy}>Save</Button>} />
      <Table>
        <THead><TR><TH>Event</TH>{CHANNELS.map((c) => <TH key={c} className="text-center">{CHANNEL_LABEL[c]}</TH>)}</TR></THead>
        <TBody>
          {data.map((d) => (
            <TR key={d.event}>
              <TD className="font-medium">{titleCase(d.event)}</TD>
              {CHANNELS.map((c) => (
                <TD key={c} className="text-center">
                  <input type="checkbox" aria-label={`${d.event} ${c}`} className="h-4 w-4 accent-brand-600" checked={local[`${d.event}:${c}`] ?? true} onChange={(e) => setLocal((l) => ({ ...l, [`${d.event}:${c}`]: e.target.checked }))} />
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

interface LogRow {
  id: string;
  event: string;
  channel: Channel;
  recipient: string;
  subject: string | null;
  body: string;
  status: string;
  provider: string | null;
  error: string | null;
  customerName: string | null;
  createdAt: string;
  sentAt: string | null;
}

const STATUS_TONE: Record<string, 'green' | 'red' | 'amber' | 'gray' | 'blue'> = { SENT: 'green', DELIVERED: 'green', FAILED: 'red', QUEUED: 'blue', SKIPPED: 'gray' };

function LogPanel() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ channel: '', status: '', event: '', search: '' });
  const [open, setOpen] = useState<LogRow | null>(null);
  const [test, setTest] = useState<{ event: string; channel: Channel; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['notification-logs', page, filters],
    queryFn: () => api.page<LogRow>('/notifications/logs', { page, pageSize: 25, ...filters }),
  });
  const summary = (data?.meta as { summary?: { last30Days: Record<string, number>; sentByChannel: Record<string, number> } } | undefined)?.summary;
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };
  const sendTest = async () => {
    if (!test) return;
    setBusy(true);
    try {
      const r = await api.post<LogRow>('/notifications/test', test);
      if (r.status === 'SENT') toast.success(`Test ${CHANNEL_LABEL[test.channel]} sent to ${test.to}`);
      else toast.error(r.error ?? 'Test message failed');
      setTest(null);
      await qc.invalidateQueries({ queryKey: ['notification-logs'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label="Sent (30 days)" value={(summary?.last30Days.SENT ?? 0) + (summary?.last30Days.DELIVERED ?? 0)} />
        <StatCard label="Failed" value={summary?.last30Days.FAILED ?? 0} />
        <StatCard label="Skipped (consent)" value={summary?.last30Days.SKIPPED ?? 0} />
        <StatCard label="By channel" value={<span className="text-base">{CHANNELS.map((c) => `${CHANNEL_LABEL[c]} ${summary?.sentByChannel[c] ?? 0}`).join(' · ')}</span>} />
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <Input className="max-w-[14rem]" placeholder="Search recipient or text" value={filters.search} onChange={set('search')} />
          <Select className="w-36" value={filters.channel} onChange={set('channel')} aria-label="Channel">
            <option value="">All channels</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
          </Select>
          <Select className="w-36" value={filters.status} onChange={set('status')} aria-label="Status">
            <option value="">All statuses</option>
            {['SENT', 'QUEUED', 'FAILED', 'SKIPPED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
          <Select className="w-48" value={filters.event} onChange={set('event')} aria-label="Event">
            <option value="">All events</option>
            {Object.keys(EVENT_HELP).concat('MARKETING').map((e) => <option key={e} value={e}>{titleCase(e)}</option>)}
          </Select>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setTest({ event: 'APPOINTMENT_BOOKED', channel: 'WHATSAPP', to: '' })}>
            <Send className="h-4 w-4" /> Send test
          </Button>
        </div>
        {isLoading ? <LoadingBlock /> : (
          <>
            <Table>
              <THead><TR><TH>When</TH><TH>Event</TH><TH>Channel</TH><TH>To</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {data?.items.map((l) => (
                  <TR key={l.id}>
                    <TD className="whitespace-nowrap text-xs">{fmtDateTime(l.createdAt)}</TD>
                    <TD className="text-xs">{titleCase(l.event)}</TD>
                    <TD>{CHANNEL_LABEL[l.channel] ?? l.channel}</TD>
                    <TD className="text-xs"><p>{l.customerName ?? '—'}</p><p className="text-slate-500">{l.recipient}</p></TD>
                    <TD><Badge tone={STATUS_TONE[l.status] ?? 'gray'}>{titleCase(l.status)}</Badge>{l.error && <p className="mt-0.5 max-w-[14rem] truncate text-[11px] text-rose-600">{l.error}</p>}</TD>
                    <TD><Button size="sm" variant="ghost" onClick={() => setOpen(l)}>View</Button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {!data?.items.length && <p className="p-6 text-center text-sm text-slate-500">No messages match these filters.</p>}
            <Pagination page={page} totalPages={data?.meta.totalPages ?? 1} onChange={setPage} />
          </>
        )}
      </Card>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `${titleCase(open.event)} · ${CHANNEL_LABEL[open.channel]}` : ''} size="lg">
        {open && (
          <div className="space-y-2 text-sm">
            <p><span className="text-slate-500">To:</span> {open.recipient} {open.provider && <span className="text-slate-400">via {open.provider}</span>}</p>
            {open.subject && <p><span className="text-slate-500">Subject:</span> {open.subject}</p>}
            {open.channel === 'EMAIL' ? (
              <div className="rounded border border-slate-200 p-3" dangerouslySetInnerHTML={{ __html: open.body }} />
            ) : (
              <pre className="whitespace-pre-wrap rounded bg-slate-50 p-3 font-sans">{open.body || '(not sent)'}</pre>
            )}
            {open.error && <p className="text-rose-600">{open.error}</p>}
          </div>
        )}
      </Modal>
      <Modal open={!!test} onClose={() => setTest(null)} title="Send a test message" size="sm"
        footer={<><Button variant="outline" onClick={() => setTest(null)}>Cancel</Button><Button onClick={sendTest} loading={busy} disabled={!test?.to}>Send</Button></>}>
        {test && (
          <div className="space-y-3">
            <Field label="Template">
              <Select value={test.event} onChange={(e) => setTest({ ...test, event: e.target.value })}>
                {Object.keys(EVENT_HELP).map((e) => <option key={e} value={e}>{titleCase(e)}</option>)}
              </Select>
            </Field>
            <Field label="Channel">
              <Select value={test.channel} onChange={(e) => setTest({ ...test, channel: e.target.value as Channel })}>
                {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
              </Select>
            </Field>
            <Field label={test.channel === 'EMAIL' ? 'Email address' : 'Phone number'}>
              <Input value={test.to} onChange={(e) => setTest({ ...test, to: e.target.value })} placeholder={test.channel === 'EMAIL' ? 'you@example.com' : '+919800000000'} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

function AutomationPanel() {
  const { data, refetch } = useQuery({
    queryKey: ['automation-status'],
    queryFn: () => api.get<{ lastDailyRun: string | null; jobs: string[]; queues: Array<{ queue: string; waiting?: number; active?: number; failed?: number; completed?: number }>; schedulers: Array<{ key: string; every: number | null; pattern: string | null; next: string | null }> }>('/automation/status'),
  });
  const [running, setRunning] = useState<string | null>(null);
  const run = async (job: string) => {
    setRunning(job);
    try {
      const r = await api.post<{ result: unknown }>(`/automation/jobs/${job}/run`);
      toast.success(`${titleCase(job)} job finished`, { description: JSON.stringify(r.result).slice(0, 160) });
      await refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRunning(null);
    }
  };
  const labels: Record<string, string> = { reminders: 'Appointment reminders', daily: 'All daily jobs', expiry: 'Package & membership expiry', birthdays: 'Birthday wishes', metrics: 'Recompute segments & LTV', summary: 'Daily summary', campaigns: 'Dispatch campaigns' };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Scheduled jobs" description={`Daily jobs run each morning. Last run: ${data?.lastDailyRun ?? 'never'}`} />
        <CardContent className="space-y-2">
          {(data?.jobs ?? []).map((j) => (
            <div key={j} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
              <span className="text-sm">{labels[j] ?? titleCase(j)}</span>
              <Button size="sm" variant="outline" loading={running === j} onClick={() => run(j)}>Run now</Button>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Queues" description="Background workers (outbox events, notifications, schedules)." />
        <Table>
          <THead><TR><TH>Queue</TH><TH>Waiting</TH><TH>Active</TH><TH>Failed</TH><TH>Done</TH></TR></THead>
          <TBody>
            {(data?.queues ?? []).map((q) => (
              <TR key={q.queue}><TD className="font-mono text-xs">{q.queue}</TD><TD>{q.waiting ?? 0}</TD><TD>{q.active ?? 0}</TD><TD>{q.failed ?? 0}</TD><TD>{q.completed ?? 0}</TD></TR>
            ))}
          </TBody>
        </Table>
        <CardContent className="text-xs text-slate-500">
          {(data?.schedulers ?? []).map((s) => (
            <p key={s.key}>{s.key}: {s.pattern ?? `every ${Math.round((s.every ?? 0) / 60000)} min`}{s.next ? ` · next ${fmtDateTime(s.next)}` : ''}</p>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function NotificationsTab() {
  const [tab, setTab] = useState<'templates' | 'preferences' | 'log' | 'automation'>('templates');
  const tabs = useMemo(
    () => [
      { value: 'templates' as const, label: 'Templates' },
      { value: 'preferences' as const, label: 'Preferences' },
      { value: 'log' as const, label: 'Delivery log' },
      { value: 'automation' as const, label: 'Automation' },
    ],
    [],
  );
  return (
    <div className="space-y-4">
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'templates' && <TemplatesPanel />}
      {tab === 'preferences' && <PreferencesPanel />}
      {tab === 'log' && <LogPanel />}
      {tab === 'automation' && <AutomationPanel />}
    </div>
  );
}
