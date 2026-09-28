'use client';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CalendarClock, Crown, IndianRupee, Megaphone, Plus, RefreshCw, Repeat, Send, Trash2, Users, XCircle } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  Select,
  StatCard,
  Table,
  Tabs,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
} from '@therapyos/ui';
import { CUSTOMER_SEGMENTS, PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { ago, fmtDate, fmtDateTime, money, num, titleCase } from '@/lib/format';
import { useBranches } from '@/lib/queries';

type Segment = (typeof CUSTOMER_SEGMENTS)[number];
const SEGMENT_INFO: Record<string, { label: string; tone: 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'purple' | 'brand'; help: string }> = {
  NEW: { label: 'New', tone: 'blue', help: 'One visit so far, or not visited yet' },
  ACTIVE: { label: 'Active', tone: 'green', help: 'Visiting regularly' },
  LOYAL: { label: 'Loyal', tone: 'brand', help: '5+ visits and still coming' },
  VIP: { label: 'VIP', tone: 'purple', help: 'Lifetime spend above the VIP threshold' },
  AT_RISK: { label: 'At risk', tone: 'amber', help: 'Overdue compared with their usual gap' },
  INACTIVE: { label: 'Inactive', tone: 'red', help: 'No visit for the inactive period' },
  CHURNED: { label: 'Churned', tone: 'gray', help: 'No visit for the churn period' },
};

interface Overview {
  totals: { customers: number; visited: number; repeatRate: number; churnRate: number; avgLifetimeValue: number; avgExpectedLtv: number; totalLifetimeValue: number; avgVisitIntervalDays: number | null; avgVisits: number; atRiskValue: number };
  segments: { segment: Segment; count: number; lifetimeValue: number; avgLifetimeValue: number }[];
  cohorts: { cohort: string; size: number; retention: number[] }[];
  atRisk: { customer: { id: string; name: string; phone: string; marketingOptIn: boolean }; segment: string; lifetimeValue: number; visitCount: number; lastVisitAt: string | null; daysSinceVisit: number | null }[];
}

function SegmentBadge({ segment }: { segment: string }) {
  const s = SEGMENT_INFO[segment];
  return <Badge tone={s?.tone ?? 'gray'}>{s?.label ?? titleCase(segment)}</Badge>;
}

function heat(pct: number) {
  if (pct <= 0) return 'bg-slate-50 text-slate-400';
  if (pct < 15) return 'bg-brand-50 text-brand-800';
  if (pct < 30) return 'bg-brand-100 text-brand-900';
  if (pct < 50) return 'bg-brand-300 text-brand-950';
  return 'bg-brand-500 text-white';
}

function RetentionTab({ onWinBack, canManage }: { onWinBack: (segment: Segment) => void; canManage: boolean }) {
  const branchId = useBranch((s) => s.branchId);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['retention-overview', branchId], queryFn: () => api.get<Overview>('/retention/overview', { branchId: branchId ?? undefined }) });
  const [busy, setBusy] = useState(false);
  if (isLoading || !data) return <LoadingBlock />;
  const recompute = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ customers: number; lapsed: number }>('/retention/recompute');
      toast.success(`Recomputed ${r.customers} customers`, { description: r.lapsed ? `${r.lapsed} newly inactive` : undefined });
      await qc.invalidateQueries({ queryKey: ['retention-overview'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const t = data.totals;
  const maxSeg = Math.max(1, ...data.segments.map((s) => s.count));
  const maxMonths = Math.max(0, ...data.cohorts.map((c) => c.retention.length));
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Repeat rate" value={`${t.repeatRate}%`} hint={`${t.visited} customers visited`} icon={<Repeat className="h-4 w-4" />} />
        <StatCard label="Churn rate" value={`${t.churnRate}%`} hint="Inactive or churned" icon={<AlertTriangle className="h-4 w-4" />} />
        <StatCard label="Avg lifetime value" value={money(t.avgLifetimeValue)} hint={`Projected ${money(t.avgExpectedLtv)}`} icon={<IndianRupee className="h-4 w-4" />} />
        <StatCard label="Revenue at risk" value={money(t.atRiskValue)} hint="Lifetime spend of at-risk + inactive" icon={<Crown className="h-4 w-4" />} />
      </div>
      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader title="Segments" description={`Avg ${num(t.avgVisits, 1)} visits · every ${t.avgVisitIntervalDays ?? '—'} days`} actions={canManage && <Button size="sm" variant="ghost" onClick={recompute} loading={busy}><RefreshCw className="h-4 w-4" /> Recompute</Button>} />
          <CardContent className="space-y-2.5">
            {data.segments.map((s) => (
              <div key={s.segment} title={SEGMENT_INFO[s.segment]?.help}>
                <div className="flex items-center justify-between text-sm">
                  <SegmentBadge segment={s.segment} />
                  <span className="text-slate-600">{s.count} · <span className="text-xs text-slate-400">LTV {money(s.lifetimeValue, undefined, true)}</span></span>
                </div>
                <div className="mt-1 h-2 rounded bg-slate-100"><div className="h-2 rounded bg-brand-500" style={{ width: `${(s.count / maxSeg) * 100}%` }} /></div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="lg:col-span-3">
          <CardHeader title="Monthly cohorts" description="Share of each month's first-time customers who came back in later months" />
          <CardContent className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="cohort-table">
              <thead>
                <tr className="text-slate-500">
                  <th className="px-2 py-1 text-left font-medium">Cohort</th>
                  <th className="px-2 py-1 text-right font-medium">New</th>
                  {Array.from({ length: maxMonths }, (_, i) => <th key={i} className="px-2 py-1 text-center font-medium">M{i + 1}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.cohorts.map((c) => (
                  <tr key={c.cohort}>
                    <td className="px-2 py-1 font-medium text-slate-700">{fmtDate(`${c.cohort}-01`, 'MMM yyyy')}</td>
                    <td className="px-2 py-1 text-right">{c.size}</td>
                    {Array.from({ length: maxMonths }, (_, i) => (
                      <td key={i} className="p-0.5">
                        {i < c.retention.length ? <div className={`rounded px-1 py-1 text-center ${heat(c.retention[i])}`}>{Math.round(c.retention[i])}%</div> : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.cohorts.length && <p className="text-sm text-slate-500">Not enough visit history yet.</p>}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader
          title="Win these customers back"
          description="Highest-value customers who are overdue or inactive"
          actions={canManage && <Button size="sm" onClick={() => onWinBack('INACTIVE')}><Megaphone className="h-4 w-4" /> Win-back campaign</Button>}
        />
        <Table>
          <THead><TR><TH>Customer</TH><TH>Segment</TH><TH>Last visit</TH><TH className="text-right">Visits</TH><TH className="text-right">Lifetime value</TH><TH>Marketing</TH></TR></THead>
          <TBody>
            {data.atRisk.map((r) => (
              <TR key={r.customer.id}>
                <TD><a href={`/customers/${r.customer.id}`} className="font-medium text-brand-700 hover:underline">{r.customer.name}</a><p className="text-xs text-slate-500">{r.customer.phone}</p></TD>
                <TD><SegmentBadge segment={r.segment} /></TD>
                <TD className="text-xs">{r.lastVisitAt ? `${fmtDate(r.lastVisitAt)} (${r.daysSinceVisit}d ago)` : '—'}</TD>
                <TD className="text-right">{r.visitCount}</TD>
                <TD className="text-right font-medium">{money(r.lifetimeValue)}</TD>
                <TD>{r.customer.marketingOptIn ? <Badge tone="green">Opted in</Badge> : <Badge>No consent</Badge>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {!data.atRisk.length && <p className="p-6 text-center text-sm text-slate-500">No at-risk customers right now.</p>}
      </Card>
    </div>
  );
}

interface MetricRow {
  customerId: string;
  segment: string;
  visitCount: number;
  lifetimeValue: number;
  expectedLtv: number;
  lastVisitAt: string | null;
  daysSinceVisit: number | null;
  hasActivePackage: boolean;
  hasActiveMembership: boolean;
  customer: { id: string; name: string; phone: string; customerCode: string; marketingOptIn: boolean };
}

function SegmentsTab() {
  const branchId = useBranch((s) => s.branchId);
  const [segment, setSegment] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('lifetimeValue');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['retention-customers', segment, search, sort, page, branchId],
    queryFn: () => api.page<MetricRow>('/retention/customers', { segment: segment || undefined, search: search || undefined, sort, order: sort === 'lastVisitAt' ? 'asc' : 'desc', page: String(page), pageSize: '25', branchId: branchId ?? undefined }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
        <Input className="max-w-xs" placeholder="Search name or phone" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <Select className="w-40" value={segment} onChange={(e) => { setSegment(e.target.value); setPage(1); }} aria-label="Segment">
          <option value="">All segments</option>
          {CUSTOMER_SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_INFO[s]?.label ?? s}</option>)}
        </Select>
        <Select className="w-48" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="lifetimeValue">Highest lifetime value</option>
          <option value="expectedLtv">Highest projected LTV</option>
          <option value="visitCount">Most visits</option>
          <option value="lastVisitAt">Longest since last visit</option>
        </Select>
      </div>
      {isLoading ? <LoadingBlock /> : (
        <>
          <Table>
            <THead><TR><TH>Customer</TH><TH>Segment</TH><TH className="text-right">Visits</TH><TH>Last visit</TH><TH className="text-right">Lifetime value</TH><TH className="text-right">Projected</TH><TH>Holds</TH></TR></THead>
            <TBody>
              {data?.items.map((m) => (
                <TR key={m.customerId}>
                  <TD><a href={`/customers/${m.customer.id}`} className="font-medium text-brand-700 hover:underline">{m.customer.name}</a><p className="text-xs text-slate-500">{m.customer.customerCode} · {m.customer.phone}</p></TD>
                  <TD><SegmentBadge segment={m.segment} /></TD>
                  <TD className="text-right">{m.visitCount}</TD>
                  <TD className="text-xs">{m.lastVisitAt ? ago(m.lastVisitAt) : 'Never'}</TD>
                  <TD className="text-right font-medium">{money(m.lifetimeValue)}</TD>
                  <TD className="text-right text-slate-500">{money(m.expectedLtv)}</TD>
                  <TD className="space-x-1">{m.hasActivePackage && <Badge tone="blue">Package</Badge>}{m.hasActiveMembership && <Badge tone="purple">Member</Badge>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={data?.meta.totalPages ?? 1} onChange={setPage} />
        </>
      )}
    </Card>
  );
}

interface CampaignStats { total: number; sent: number; failed: number; skipped: number; pending: number; converted: number; revenue: number }
interface Campaign {
  id: string;
  name: string;
  segment: string | null;
  filters: Record<string, unknown>;
  channel: 'SMS' | 'EMAIL' | 'WHATSAPP';
  subject: string | null;
  templateBody: string;
  couponId: string | null;
  status: string;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  stats: CampaignStats;
}
interface CampaignDetail extends Campaign {
  coupon: { id: string; code: string } | null;
  recipients: { id: string; status: string; sentAt: string | null; convertedAt: string | null; revenue: number; customer: { id: string; name: string; phone: string } | null }[];
}

const STATUS_TONE: Record<string, 'gray' | 'blue' | 'amber' | 'green' | 'red'> = { DRAFT: 'gray', SCHEDULED: 'blue', RUNNING: 'amber', COMPLETED: 'green', CANCELLED: 'red' };
const CHANNEL_LABEL = { SMS: 'SMS', EMAIL: 'Email', WHATSAPP: 'WhatsApp' } as const;

interface CampaignForm {
  name: string;
  channel: 'SMS' | 'EMAIL' | 'WHATSAPP';
  segment: string;
  subject: string;
  templateBody: string;
  couponId: string;
  scheduledAt: string;
  filters: { branchId?: string; birthdayThisMonth?: boolean; firstTimeVisitors?: boolean; packageExpiringInDays?: number; membershipExpiringInDays?: number; minLifetimeValue?: number };
}

const EMPTY_FORM: CampaignForm = { name: '', channel: 'WHATSAPP', segment: '', subject: '', templateBody: 'Hi {{customer_name}}, ', couponId: '', scheduledAt: '', filters: {} };

function cleanFilters(f: CampaignForm['filters']) {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== '' && v !== false && !(typeof v === 'number' && Number.isNaN(v))));
}

function CampaignEditor({ initial, onClose }: { initial: Partial<CampaignForm> & { id?: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: branches } = useBranches();
  const { data: coupons } = useQuery({ queryKey: ['coupons-lite'], queryFn: () => api.page<{ id: string; code: string; status: string }>('/coupons', { pageSize: '100' }) });
  const [form, setForm] = useState<CampaignForm>({ ...EMPTY_FORM, ...initial, filters: { ...(initial.filters ?? {}) } });
  const [audience, setAudience] = useState<{ count: number; excludedNoConsent: number; sample: { id: string; name: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const filtersKey = JSON.stringify([form.segment, form.channel, cleanFilters(form.filters)]);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .post<typeof audience>('/campaigns/audience', { channel: form.channel, segment: form.segment || undefined, filters: cleanFilters(form.filters) })
        .then(setAudience)
        .catch(() => setAudience(null));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const setF = (k: keyof CampaignForm['filters'], v: unknown) => setForm((f) => ({ ...f, filters: { ...f.filters, [k]: v } }));
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: form.name,
        channel: form.channel,
        segment: form.segment || undefined,
        subject: form.channel === 'EMAIL' ? form.subject : undefined,
        templateBody: form.templateBody,
        couponId: form.couponId || undefined,
        filters: cleanFilters(form.filters),
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
      };
      if (initial.id) await api.patch(`/campaigns/${initial.id}`, body);
      else await api.post('/campaigns', body);
      toast.success(form.scheduledAt ? 'Campaign scheduled' : 'Campaign saved as draft');
      await qc.invalidateQueries({ queryKey: ['campaigns'] });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const vars = ['customer_name', 'business_name', 'offer_code', 'booking_link'];
  return (
    <Modal open onClose={onClose} size="xl" title={initial.id ? 'Edit campaign' : 'New campaign'} description="Only customers who opted in to marketing are ever included."
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={!form.name || !form.templateBody}>{form.scheduledAt ? 'Schedule' : 'Save draft'}</Button></>}>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Campaign name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Diwali offer" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Channel">
              <Select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as CampaignForm['channel'] })}>
                {Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Coupon (optional)">
              <Select value={form.couponId} onChange={(e) => setForm({ ...form, couponId: e.target.value })}>
                <option value="">None</option>
                {coupons?.items.filter((c) => c.status === 'ACTIVE').map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
              </Select>
            </Field>
          </div>
          {form.channel === 'EMAIL' && <Field label="Subject"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>}
          <Field label="Message" hint={form.channel === 'EMAIL' ? 'HTML allowed' : 'Keep it short and personal'}>
            <Textarea rows={5} value={form.templateBody} onChange={(e) => setForm({ ...form, templateBody: e.target.value })} />
          </Field>
          <div className="flex flex-wrap gap-1">
            {vars.map((v) => (
              <button key={v} type="button" className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] hover:bg-brand-100" onClick={() => setForm((f) => ({ ...f, templateBody: `${f.templateBody}{{${v}}}` }))}>{`{{${v}}}`}</button>
            ))}
          </div>
          <Field label="Send at (optional)" hint="Leave empty to save as a draft you can send any time.">
            <Input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
          </Field>
        </div>
        <div className="space-y-3">
          <p className="text-sm font-semibold text-slate-800">Audience</p>
          <Field label="Segment">
            <Select value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })} aria-label="Audience segment">
              <option value="">Everyone</option>
              {CUSTOMER_SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_INFO[s]?.label ?? s}</option>)}
            </Select>
          </Field>
          <Field label="Branch">
            <Select value={form.filters.branchId ?? ''} onChange={(e) => setF('branchId', e.target.value || undefined)}>
              <option value="">All branches</option>
              {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
          <Checkbox label="Birthday this month" checked={!!form.filters.birthdayThisMonth} onChange={(e) => setF('birthdayThisMonth', e.target.checked)} />
          <Checkbox label="First-time visitors only" checked={!!form.filters.firstTimeVisitors} onChange={(e) => setF('firstTimeVisitors', e.target.checked)} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Package expiring in (days)"><Input type="number" min={1} value={form.filters.packageExpiringInDays ?? ''} onChange={(e) => setF('packageExpiringInDays', e.target.value ? Number(e.target.value) : undefined)} /></Field>
            <Field label="Min lifetime value"><Input type="number" min={0} value={form.filters.minLifetimeValue ?? ''} onChange={(e) => setF('minLifetimeValue', e.target.value ? Number(e.target.value) : undefined)} /></Field>
          </div>
          <div className="rounded-lg border border-brand-200 bg-brand-50 p-3" data-testid="audience-preview">
            <p className="text-2xl font-semibold text-brand-900">{audience?.count ?? '…'} <span className="text-sm font-normal text-brand-800">customers will receive this</span></p>
            {!!audience?.excludedNoConsent && <p className="text-xs text-brand-800">{audience.excludedNoConsent} more match but have not opted in to marketing</p>}
            {!!audience?.sample.length && <p className="mt-1 truncate text-xs text-slate-600">e.g. {audience.sample.map((s) => s.name).join(', ')}</p>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function CampaignDetailModal({ id, onClose, canManage }: { id: string; onClose: () => void; canManage: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['campaign', id], queryFn: () => api.get<CampaignDetail>(`/campaigns/${id}`), refetchInterval: (q) => (q.state.data?.status === 'RUNNING' ? 3000 : false) });
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (action: 'send' | 'cancel') => {
    setBusy(action);
    try {
      await api.post(`/campaigns/${id}/${action}`);
      toast.success(action === 'send' ? 'Campaign sent' : 'Campaign cancelled');
      await Promise.all([qc.invalidateQueries({ queryKey: ['campaign', id] }), qc.invalidateQueries({ queryKey: ['campaigns'] })]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const s = data?.stats;
  return (
    <Modal open onClose={onClose} size="lg" title={data?.name ?? 'Campaign'} description={data ? `${CHANNEL_LABEL[data.channel]} · ${data.segment ? SEGMENT_INFO[data.segment]?.label : 'Everyone'}${data.coupon ? ` · coupon ${data.coupon.code}` : ''}` : undefined}
      footer={data && canManage && (
        <>
          {['DRAFT', 'SCHEDULED', 'RUNNING'].includes(data.status) && <Button variant="outline" onClick={() => act('cancel')} loading={busy === 'cancel'}><XCircle className="h-4 w-4" /> Cancel campaign</Button>}
          {['DRAFT', 'SCHEDULED'].includes(data.status) && <Button onClick={() => act('send')} loading={busy === 'send'}><Send className="h-4 w-4" /> Send now</Button>}
        </>
      )}>
      {!data ? <LoadingBlock /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Sent" value={s!.sent} hint={`${s!.total} recipients`} />
            <StatCard label="Converted" value={s!.converted} hint={s!.sent ? `${Math.round((s!.converted / s!.sent) * 100)}% conversion` : undefined} />
            <StatCard label="Revenue" value={money(s!.revenue)} />
            <StatCard label="Failed / skipped" value={`${s!.failed} / ${s!.skipped}`} />
          </div>
          <div className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{data.subject && <p className="mb-1 font-medium">{data.subject}</p>}{data.templateBody}</div>
          <p className="text-xs text-slate-500">
            <Badge tone={STATUS_TONE[data.status]}>{titleCase(data.status)}</Badge>{' '}
            {data.status === 'SCHEDULED' && data.scheduledAt && `Sends ${fmtDateTime(data.scheduledAt)}`}
            {data.startedAt && `Started ${fmtDateTime(data.startedAt)}`}
            {data.completedAt && ` · finished ${fmtDateTime(data.completedAt)}`}
          </p>
          {!!data.recipients.length && (
            <Table>
              <THead><TR><TH>Customer</TH><TH>Status</TH><TH>Sent</TH><TH className="text-right">Revenue</TH></TR></THead>
              <TBody>
                {data.recipients.map((r) => (
                  <TR key={r.id}>
                    <TD>{r.customer?.name ?? '—'}</TD>
                    <TD><Badge tone={r.status === 'CONVERTED' ? 'green' : r.status === 'FAILED' ? 'red' : r.status === 'SENT' ? 'blue' : 'gray'}>{titleCase(r.status)}</Badge></TD>
                    <TD className="text-xs">{r.sentAt ? fmtDateTime(r.sentAt) : '—'}</TD>
                    <TD className="text-right">{Number(r.revenue) ? money(r.revenue) : ''}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      )}
    </Modal>
  );
}

function CampaignsTab({ canManage, editor, setEditor }: { canManage: boolean; editor: (Partial<CampaignForm> & { id?: string }) | null; setEditor: (v: (Partial<CampaignForm> & { id?: string }) | null) => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Campaign | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', status, page],
    queryFn: () => api.page<Campaign>('/campaigns', { status: status || undefined, page: String(page), pageSize: '20' }),
    placeholderData: keepPreviousData,
  });
  const summary = (data?.meta as { summary?: { sent: number; converted: number; revenue: number; conversionRate: number } } | undefined)?.summary;
  const remove = async () => {
    if (!deleting) return;
    try {
      await api.delete(`/campaigns/${deleting.id}`);
      toast.success('Campaign deleted');
      await qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(null);
    }
  };
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Messages sent" value={summary?.sent ?? 0} icon={<Send className="h-4 w-4" />} />
        <StatCard label="Conversions" value={summary?.converted ?? 0} hint="Paid within the attribution window" icon={<Users className="h-4 w-4" />} />
        <StatCard label="Conversion rate" value={`${summary?.conversionRate ?? 0}%`} icon={<Repeat className="h-4 w-4" />} />
        <StatCard label="Attributed revenue" value={money(summary?.revenue ?? 0)} icon={<IndianRupee className="h-4 w-4" />} />
      </div>
      <Card>
        <div className="flex items-center gap-2 border-b border-slate-100 p-3">
          <Select className="w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status">
            <option value="">All statuses</option>
            {Object.keys(STATUS_TONE).map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        {isLoading ? <LoadingBlock /> : !data?.items.length ? (
          <EmptyState icon={<Megaphone className="h-6 w-6" />} title="No campaigns yet" description="Reach opted-in customers on WhatsApp, SMS or email and track the revenue they bring back." action={canManage && <Button onClick={() => setEditor({})}><Plus className="h-4 w-4" /> New campaign</Button>} />
        ) : (
          <>
            <Table>
              <THead><TR><TH>Campaign</TH><TH>Audience</TH><TH>Status</TH><TH className="text-right">Sent</TH><TH className="text-right">Converted</TH><TH className="text-right">Revenue</TH><TH /></TR></THead>
              <TBody>
                {data.items.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <button className="text-left font-medium text-brand-700 hover:underline" onClick={() => setDetail(c.id)}>{c.name}</button>
                      <p className="text-xs text-slate-500">{CHANNEL_LABEL[c.channel]} · created {fmtDate(c.createdAt)}</p>
                    </TD>
                    <TD className="text-xs">{c.segment ? <SegmentBadge segment={c.segment} /> : 'Everyone'}{Object.keys(c.filters ?? {}).length ? <span className="ml-1 text-slate-500">+ filters</span> : null}</TD>
                    <TD>
                      <Badge tone={STATUS_TONE[c.status]}>{titleCase(c.status)}</Badge>
                      {c.status === 'SCHEDULED' && c.scheduledAt && <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500"><CalendarClock className="h-3 w-3" />{fmtDateTime(c.scheduledAt)}</p>}
                    </TD>
                    <TD className="text-right">{c.stats.sent}</TD>
                    <TD className="text-right">{c.stats.converted}{c.stats.sent ? <span className="text-xs text-slate-400"> ({Math.round((c.stats.converted / c.stats.sent) * 100)}%)</span> : null}</TD>
                    <TD className="text-right font-medium">{money(c.stats.revenue)}</TD>
                    <TD className="whitespace-nowrap text-right">
                      {canManage && ['DRAFT', 'SCHEDULED'].includes(c.status) && (
                        <Button size="sm" variant="ghost" onClick={() => setEditor({ id: c.id, name: c.name, channel: c.channel, segment: c.segment ?? '', subject: c.subject ?? '', templateBody: c.templateBody, couponId: c.couponId ?? '', filters: c.filters as CampaignForm['filters'], scheduledAt: '' })}>Edit</Button>
                      )}
                      {canManage && ['DRAFT', 'CANCELLED'].includes(c.status) && (
                        <Button size="icon" variant="ghost" aria-label="Delete campaign" onClick={() => setDeleting(c)}><Trash2 className="h-4 w-4" /></Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
          </>
        )}
      </Card>
      {editor && <CampaignEditor initial={editor} onClose={() => setEditor(null)} />}
      {detail && <CampaignDetailModal id={detail} onClose={() => setDetail(null)} canManage={canManage} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={remove} danger title="Delete campaign?" message={`"${deleting?.name}" will be removed permanently.`} confirmLabel="Delete" />
    </div>
  );
}

function MarketingInner() {
  const user = useAuth((s) => s.user);
  const canRetention = hasPermission(user, PERMISSIONS.RETENTION_READ);
  const canCampaigns = hasPermission(user, PERMISSIONS.CAMPAIGN_READ);
  const canManage = hasPermission(user, PERMISSIONS.CAMPAIGN_MANAGE);
  const tabs = [
    ...(canRetention ? [{ value: 'retention' as const, label: 'Retention' }, { value: 'segments' as const, label: 'Customer segments' }] : []),
    ...(canCampaigns ? [{ value: 'campaigns' as const, label: 'Campaigns' }] : []),
  ];
  const [tab, setTab] = useState<'retention' | 'segments' | 'campaigns'>(tabs[0]?.value ?? 'campaigns');
  const [editor, setEditor] = useState<(Partial<CampaignForm> & { id?: string }) | null>(null);
  const winBack = (segment: Segment) => {
    setTab('campaigns');
    setEditor({
      name: 'We miss you',
      segment,
      channel: 'WHATSAPP',
      templateBody: 'Hi {{customer_name}}, we miss you at {{business_name}}! Come back this week and enjoy something special. Book: {{booking_link}}',
    });
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Marketing & Retention"
        description="Understand who keeps coming back, spot customers slipping away and win them back with targeted campaigns."
        actions={canManage && <Button onClick={() => { setTab('campaigns'); setEditor({}); }}><Plus className="h-4 w-4" /> New campaign</Button>}
      />
      {tabs.length > 1 && <Tabs value={tab} onChange={setTab} tabs={tabs} />}
      {tab === 'retention' && canRetention && <RetentionTab onWinBack={winBack} canManage={canManage} />}
      {tab === 'segments' && canRetention && <SegmentsTab />}
      {tab === 'campaigns' && canCampaigns && <CampaignsTab canManage={canManage} editor={editor} setEditor={setEditor} />}
    </div>
  );
}

export default function MarketingPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <MarketingInner />
    </Suspense>
  );
}
