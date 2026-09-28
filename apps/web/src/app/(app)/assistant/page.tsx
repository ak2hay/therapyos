'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ArrowRight, Bot, History, Send, Sparkles } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardContent, CardHeader, PageHeader, Spinner, Textarea } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { useBranch } from '@/lib/branch-store';
import { ago, money } from '@/lib/format';
import { useBranches } from '@/lib/queries';

interface AiAnswer {
  id: string;
  question: string;
  answer: string;
  provider: string;
  createdAt: string;
  intent: string;
  title: string;
  headline: string;
  insights: string[];
  period?: { from: string; to: string; label: string; previousLabel: string };
  table?: { columns: string[]; rows: (string | number | null)[][] };
  heatmap?: { days: string[]; hours: number[]; values: number[][] };
  actions?: { label: string; href: string }[];
  suggestions?: string[];
}

const MONEY_COLUMN = /sales|previous|value|revenue/i;
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;

function AnswerText({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^[-*•]\s/.test(l));
  if (bullets.length === lines.length) {
    return <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">{bullets.map((l, i) => <li key={i}>{l.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '')}</li>)}</ul>;
  }
  return <div className="space-y-2 text-sm text-slate-700">{lines.map((l, i) => (/^[-*•]\s/.test(l) ? <p key={i} className="pl-3">• {l.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '')}</p> : <p key={i}>{l.replace(/\*\*/g, '')}</p>))}</div>;
}

function Heatmap({ data }: { data: NonNullable<AiAnswer['heatmap']> }) {
  const max = Math.max(0.01, ...data.values.flat());
  return (
    <div className="overflow-x-auto" data-testid="ai-heatmap">
      <div className="inline-grid gap-0.5 text-[10px]" style={{ gridTemplateColumns: `2.5rem repeat(${data.hours.length}, minmax(1.6rem, 1fr))` }}>
        <span />
        {data.hours.map((h) => <span key={h} className="text-center text-slate-400">{hourLabel(h)}</span>)}
        {data.days.map((d, i) => (
          <Fragment key={d}>
            <span className="pr-1 text-right leading-6 text-slate-500">{d}</span>
            {data.values[i].map((v, j) => (
              <span key={j} title={`${d} ${hourLabel(data.hours[j])}: ${v} a week`} className="h-6 rounded-sm bg-slate-100">
                <span className="block h-full w-full rounded-sm bg-brand-600" style={{ opacity: v ? 0.12 + (v / max) * 0.88 : 0 }} />
              </span>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function AnswerCard({ a, onAsk }: { a: AiAnswer; onAsk: (q: string) => void }) {
  return (
    <div className="space-y-3" data-testid="ai-answer">
      <div className="flex justify-end"><div className="max-w-[80%] rounded-2xl rounded-br-sm bg-brand-600 px-4 py-2 text-sm text-white">{a.question}</div></div>
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-brand-50 p-2 text-brand-700"><Bot className="h-5 w-5" /></div>
            <div className="flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{a.title}</p>
                {a.period?.label && <Badge tone="gray">{a.period.label}{a.period.previousLabel ? ` vs ${a.period.previousLabel}` : ''}</Badge>}
              </div>
              <p className="font-medium text-slate-900" data-testid="ai-headline">{a.headline}</p>
            </div>
          </div>
          <AnswerText text={a.answer} />
          {a.heatmap && <Heatmap data={a.heatmap} />}
          {a.table && (
            <div className="overflow-x-auto rounded-lg border border-slate-100">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500"><tr>{a.table.columns.map((c, i) => <th key={c} className={`px-3 py-2 font-medium ${i ? 'text-right' : 'text-left'}`}>{c}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {a.table.rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((v, j) => (
                        <td key={j} className={`px-3 py-1.5 ${j ? 'text-right' : 'font-medium text-slate-800'}`}>
                          {v === null ? '—' : typeof v === 'number' && MONEY_COLUMN.test(a.table!.columns[j]) ? money(v) : v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {a.actions?.map((x) => (
              <Link key={x.href} href={x.href}><Button size="sm" variant="outline">{x.label} <ArrowRight className="h-3.5 w-3.5" /></Button></Link>
            ))}
          </div>
          <p className="text-[11px] text-slate-400">Computed from your TherapyOS data{a.provider.startsWith('openai') ? ' and phrased by AI' : ''}. Figures exclude tax.</p>
        </CardContent>
      </Card>
      {!!a.suggestions?.length && (
        <div className="flex flex-wrap gap-2">
          {a.suggestions.map((s) => <button key={s} type="button" onClick={() => onAsk(s)} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-brand-400 hover:text-brand-700">{s}</button>)}
        </div>
      )}
    </div>
  );
}

export default function AssistantPage() {
  const qc = useQueryClient();
  const branchId = useBranch((s) => s.branchId);
  const branchName = useBranches().data?.find((b) => b.id === branchId)?.name;
  const suggestions = useQuery({ queryKey: ['ai', 'suggestions'], queryFn: () => api.get<{ questions: string[] }>('/ai/suggestions') });
  const history = useQuery({ queryKey: ['ai', 'history'], queryFn: () => api.page<AiAnswer>('/ai/history', { pageSize: '15' }) });
  const [thread, setThread] = useState<AiAnswer[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [thread.length, busy]);

  const ask = async (q: string) => {
    const text = q.trim();
    if (text.length < 3 || busy) return;
    setBusy(true);
    setQuestion('');
    try {
      const a = await api.post<AiAnswer>('/ai/ask', { question: text, branchId: branchId || undefined });
      setThread((t) => [...t, a]);
      void qc.invalidateQueries({ queryKey: ['ai', 'history'] });
    } catch (err) {
      toast.error(errorMessage(err));
      setQuestion(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Assistant"
        description={`Ask about revenue, customers, services, branches and demand for ${branchName ?? 'all your branches'}. Every answer is computed from your own data; nothing is guessed.`}
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-5">
          {!thread.length && (
            <Card>
              <CardContent className="space-y-4 py-8 text-center">
                <Sparkles className="mx-auto h-8 w-8 text-brand-600" />
                <div>
                  <p className="font-semibold text-slate-900">What would you like to know?</p>
                  <p className="text-sm text-slate-500">Try one of these, or ask in your own words.</p>
                </div>
                <div className="mx-auto grid max-w-2xl gap-2 sm:grid-cols-2">
                  {suggestions.data?.questions.map((q) => (
                    <button key={q} type="button" onClick={() => ask(q)} className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-700 hover:border-brand-400 hover:bg-brand-50" data-testid="ai-suggestion">{q}</button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          {thread.map((a) => <AnswerCard key={a.id} a={a} onAsk={ask} />)}
          {busy && <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner className="h-4 w-4" /> Crunching your numbers…</div>}
          <div ref={bottom} />
          <Card className="sticky bottom-4">
            <form className="flex gap-2 p-3" onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
              <Textarea
                rows={1}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(question); } }}
                placeholder="e.g. Why did revenue fall last month?"
                className="min-h-10 flex-1 resize-none"
                aria-label="Ask the assistant"
                maxLength={500}
              />
              <Button type="submit" loading={busy} disabled={question.trim().length < 3} aria-label="Ask"><Send className="h-4 w-4" /></Button>
            </form>
          </Card>
        </div>
        <Card className="h-fit">
          <CardHeader title="Recent questions" actions={<History className="h-4 w-4 text-slate-400" />} />
          <CardContent className="space-y-1 p-2">
            {history.data?.items.length ? history.data.items.map((h) => (
              <button key={h.id} type="button" onClick={() => setThread((t) => (t.some((x) => x.id === h.id) ? t : [...t, h]))} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-50">
                <p className="line-clamp-2 text-sm text-slate-700">{h.question}</p>
                <p className="text-[11px] text-slate-400">{ago(h.createdAt)}</p>
              </button>
            )) : <p className="p-3 text-sm text-slate-500">Your questions will appear here.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
