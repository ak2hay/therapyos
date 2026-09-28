'use client';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { Download, MessageSquareText, Plus, Printer, QrCode, Star, ThumbsDown, Users } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, EmptyState, Field, Input, LoadingBlock, Modal, PageHeader, Pagination, Select, StatCard, Tabs, Textarea } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { ago, fmtDateTime, titleCase } from '@/lib/format';
import { useBranches, useTherapists, useWorkingBranch } from '@/lib/queries';

interface FeedbackRow {
  id: string;
  rating: number;
  comment: string | null;
  source: string;
  createdAt: string;
  branchName: string | null;
  therapistName: string | null;
  serviceName: string | null;
  customer: { id: string; name: string; phone: string } | null;
}
interface Summary {
  count: number;
  average: number | null;
  score: number | null;
  lowRatings: number;
  distribution: { rating: number; count: number }[];
  bySource: Record<string, number>;
  byTherapist: { therapistId: string; name: string; average: number; count: number }[];
}

const SOURCES: Record<string, string> = { IN_APP: 'Feedback link', QR: 'QR code', WHATSAPP: 'WhatsApp', GOOGLE: 'Google', MANUAL: 'Front desk' };
const RATING_TABS = [
  { value: 'all', label: 'All' },
  { value: '5', label: '5★' },
  { value: '4', label: '4★' },
  { value: '3', label: '3★' },
  { value: 'low', label: '1–2★' },
] as const;

function Stars({ value, size = 'h-4 w-4' }: { value: number; size?: string }) {
  return (
    <span className="inline-flex" aria-label={`${value} stars`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} className={`${size} ${n <= value ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} />)}
    </span>
  );
}

function QrModal({ open, onClose, canManage }: { open: boolean; onClose: () => void; canManage: boolean }) {
  const { data: branches } = useBranches();
  const working = useWorkingBranch(branches);
  const [branchId, setBranchId] = useState<string | null>(null);
  const id = branchId ?? working;
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['feedback-qr', id],
    queryFn: () => api.get<{ url: string; png: string; branchName: string; businessName: string; googleReviewUrl: string | null }>(`/feedback/qr/${id}`),
    enabled: open && !!id,
  });
  const [review, setReview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saveReview = async () => {
    setBusy(true);
    try {
      await api.put(`/feedback/qr/${id}/review-url`, { googleReviewUrl: review ?? '' });
      toast.success('Google review link saved');
      setReview(null);
      await qc.invalidateQueries({ queryKey: ['feedback-qr', id] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const print = () => {
    if (!data) return;
    const w = window.open('', '_blank', 'width=600,height=800');
    if (!w) return;
    w.document.write(`<html><head><title>${data.branchName} feedback</title></head><body style="font-family:Segoe UI,Arial;text-align:center;padding:40px">
      <h1 style="margin:0">${data.businessName}</h1><p style="color:#555">${data.branchName}</p>
      <img src="${data.png}" style="width:360px;height:360px"/><h2>How was your visit?</h2><p>Scan to rate us. It takes 10 seconds.</p></body></html>`);
    w.document.close();
    w.onload = () => w.print();
  };
  return (
    <Modal open={open} onClose={onClose} title="Feedback QR codes" description="Place this at the front desk. Guests scan it to rate their visit; happy guests are invited to review you on Google." size="md">
      <div className="space-y-4">
        <Field label="Branch">
          <Select value={id ?? ''} onChange={(e) => { setBranchId(e.target.value); setReview(null); }}>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        {isLoading || !data ? <LoadingBlock /> : (
          <>
            <div className="flex flex-col items-center gap-2">
              { }
              <img src={data.png} alt={`Feedback QR code for ${data.branchName}`} className="h-56 w-56" data-testid="feedback-qr" />
              <a href={data.url} target="_blank" rel="noreferrer" className="break-all text-xs text-brand-700 hover:underline">{data.url}</a>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={print}><Printer className="h-4 w-4" /> Print</Button>
                <a href={data.png} download={`feedback-qr-${data.branchName.replace(/\s+/g, '-').toLowerCase()}.png`}>
                  <Button size="sm" variant="outline"><Download className="h-4 w-4" /> Download PNG</Button>
                </a>
              </div>
            </div>
            <Field label="Google review link" hint="Customers who rate 4★ or 5★ are offered this link.">
              <div className="flex gap-2">
                <Input value={review ?? data.googleReviewUrl ?? ''} onChange={(e) => setReview(e.target.value)} placeholder="https://g.page/r/.../review" disabled={!canManage} />
                {canManage && review !== null && <Button onClick={saveReview} loading={busy}>Save</Button>}
              </div>
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

function RecordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: branches } = useBranches();
  const working = useWorkingBranch(branches);
  const qc = useQueryClient();
  const [form, setForm] = useState({ branchId: '', rating: 5, comment: '', source: 'MANUAL' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/feedback', { ...form, branchId: form.branchId || working, comment: form.comment || undefined });
      toast.success('Feedback recorded');
      await qc.invalidateQueries({ queryKey: ['feedback'] });
      setForm({ branchId: '', rating: 5, comment: '', source: 'MANUAL' });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Record feedback" description="Capture feedback given in person, by phone or on Google." size="sm"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Branch">
          <Select value={form.branchId || working || ''} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="Rating">
          <div className="flex gap-1" role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={form.rating === n} aria-label={`${n} stars`} onClick={() => setForm({ ...form, rating: n })}>
                <Star className={`h-7 w-7 ${n <= form.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} />
              </button>
            ))}
          </div>
        </Field>
        <Field label="Source">
          <Select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
            {['MANUAL', 'GOOGLE', 'WHATSAPP'].map((s) => <option key={s} value={s}>{SOURCES[s]}</option>)}
          </Select>
        </Field>
        <Field label="Comment"><Textarea rows={3} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function FeedbackInner() {
  const params = useSearchParams();
  const user = useAuth((s) => s.user);
  const canManage = hasPermission(user, PERMISSIONS.FEEDBACK_MANAGE);
  const branchId = useBranch((s) => s.branchId);
  const { data: therapists } = useTherapists({ branchId });
  const highlight = params.get('highlight');
  const [ratingTab, setRatingTab] = useState<(typeof RATING_TABS)[number]['value']>(params.get('maxRating') === '2' ? 'low' : 'all');
  const [filters, setFilters] = useState({ source: '', therapistId: '', from: '', to: '', search: '' });
  const [page, setPage] = useState(1);
  const [qrOpen, setQrOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['feedback', filters, ratingTab, page, branchId],
    queryFn: () =>
      api.page<FeedbackRow>('/feedback', {
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
        rating: ratingTab !== 'all' && ratingTab !== 'low' ? ratingTab : undefined,
        maxRating: ratingTab === 'low' ? '2' : undefined,
        branchId: branchId ?? undefined,
        page: String(page),
        pageSize: '20',
      }),
    placeholderData: keepPreviousData,
  });
  const summary = (data?.meta as { summary?: Summary } | undefined)?.summary;
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };
  const maxDist = Math.max(1, ...(summary?.distribution.map((d) => d.count) ?? [1]));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Feedback"
        description="Ratings from post-visit links, QR codes and the front desk. Ratings of 2★ or less alert managers immediately."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setQrOpen(true)}><QrCode className="h-4 w-4" /> QR codes</Button>
            {canManage && <Button onClick={() => setRecordOpen(true)}><Plus className="h-4 w-4" /> Record feedback</Button>}
          </div>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Average rating" value={summary?.average ? `${summary.average.toFixed(2)} ★` : '—'} hint={`${summary?.count ?? 0} ratings`} icon={<Star className="h-4 w-4" />} />
        <StatCard label="Satisfaction score" value={summary?.score ?? '—'} hint="% 5★ minus % 1–3★" icon={<Users className="h-4 w-4" />} />
        <StatCard label="Low ratings (1–2★)" value={summary?.lowRatings ?? 0} hint="Follow up personally" icon={<ThumbsDown className="h-4 w-4" />} />
        <StatCard label="Top rated therapist" value={summary?.byTherapist[0]?.name ?? '—'} hint={summary?.byTherapist[0] ? `${summary.byTherapist[0].average.toFixed(2)}★ from ${summary.byTherapist[0].count}` : undefined} icon={<MessageSquareText className="h-4 w-4" />} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Rating distribution" />
          <CardContent className="space-y-2">
            {summary?.distribution.map((d) => (
              <div key={d.rating} className="flex items-center gap-2 text-sm">
                <span className="w-8 text-slate-600">{d.rating}★</span>
                <div className="h-2.5 flex-1 rounded bg-slate-100">
                  <div className={`h-2.5 rounded ${d.rating >= 4 ? 'bg-emerald-500' : d.rating === 3 ? 'bg-amber-400' : 'bg-rose-500'}`} style={{ width: `${(d.count / maxDist) * 100}%` }} />
                </div>
                <span className="w-10 text-right text-slate-500">{d.count}</span>
              </div>
            ))}
            <div className="flex flex-wrap gap-1 pt-2">
              {Object.entries(summary?.bySource ?? {}).map(([s, c]) => <Badge key={s}>{SOURCES[s] ?? s}: {c}</Badge>)}
            </div>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="By therapist" description="Average rating on sessions they delivered" />
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {summary?.byTherapist.map((t) => (
              <div key={t.therapistId} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{t.name}</p>
                  <p className="text-xs text-slate-500">{t.count} ratings</p>
                </div>
                <div className="text-right"><Stars value={Math.round(t.average)} /><p className="text-xs font-semibold text-slate-700">{t.average.toFixed(2)}</p></div>
              </div>
            ))}
            {!summary?.byTherapist.length && <p className="text-sm text-slate-500">No therapist ratings yet.</p>}
          </CardContent>
        </Card>
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-3">
          <Tabs value={ratingTab} onChange={(v) => { setRatingTab(v); setPage(1); }} tabs={RATING_TABS.map((t) => ({ ...t }))} />
          <Input className="max-w-[12rem]" placeholder="Search comments" value={filters.search} onChange={set('search')} />
          <Select className="w-40" value={filters.source} onChange={set('source')} aria-label="Source">
            <option value="">All sources</option>
            {Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Select className="w-40" value={filters.therapistId} onChange={set('therapistId')} aria-label="Therapist">
            <option value="">All therapists</option>
            {therapists?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Input type="date" className="w-36" value={filters.from} onChange={set('from')} aria-label="From date" />
          <Input type="date" className="w-36" value={filters.to} onChange={set('to')} aria-label="To date" />
        </div>
        {isLoading ? <LoadingBlock /> : !data?.items.length ? (
          <EmptyState icon={<Star className="h-6 w-6" />} title="No feedback matches" description="Feedback is requested automatically after each completed session." />
        ) : (
          <>
            <ul className="divide-y divide-slate-100">
              {data.items.map((f) => (
                <li key={f.id} className={`flex gap-4 px-4 py-3 ${f.id === highlight ? 'bg-amber-50' : ''}`} data-testid="feedback-row">
                  <div className="w-24 shrink-0 pt-0.5"><Stars value={f.rating} /></div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${f.comment ? 'text-slate-800' : 'italic text-slate-400'}`}>{f.comment ?? 'No comment'}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {[f.customer?.name ?? 'Guest', f.serviceName, f.therapistName && `with ${f.therapistName}`, f.branchName].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge tone={f.rating <= 2 ? 'red' : f.rating === 3 ? 'amber' : 'green'}>{SOURCES[f.source] ?? titleCase(f.source)}</Badge>
                    <p className="mt-1 text-[11px] text-slate-400" title={fmtDateTime(f.createdAt)}>{ago(f.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
            <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
          </>
        )}
      </Card>
      <QrModal open={qrOpen} onClose={() => setQrOpen(false)} canManage={canManage} />
      <RecordModal open={recordOpen} onClose={() => setRecordOpen(false)} />
    </div>
  );
}

export default function FeedbackPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <FeedbackInner />
    </Suspense>
  );
}
