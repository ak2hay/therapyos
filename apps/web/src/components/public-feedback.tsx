'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Star } from 'lucide-react';
import { Button, Input, Spinner, Textarea } from '@therapyos/ui';

interface Info {
  businessName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  branchName: string;
  serviceName?: string | null;
  therapistName?: string | null;
  customerFirstName?: string | null;
  used?: boolean;
  expired?: boolean;
}

const LABELS = ['', 'Very poor', 'Poor', 'Okay', 'Good', 'Excellent'];

/** Unauthenticated calls: public pages must never attach (or refresh) a staff session. */
async function publicApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/public/feedback/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!json?.success) throw new Error(json?.error?.message ?? 'Something went wrong. Please try again.');
  return json.data as T;
}

export function PublicFeedback({ path, askContact = false }: { path: string; askContact?: boolean }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reviewUrl: string | null } | null>(null);

  useEffect(() => {
    publicApi<Info>(path).then(setInfo, (e: Error) => setLoadError(e.message));
  }, [path]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { rating, comment: comment || undefined };
      if (askContact) Object.assign(body, { name: name || undefined, phone: phone.replace(/\s/g, '') || undefined });
      setDone(await publicApi<{ reviewUrl: string | null }>(path, body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const accent = info?.primaryColor ?? undefined;
  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-start justify-center bg-gradient-to-b from-brand-50 to-white px-4 py-10 sm:items-center">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">{children}</div>
    </div>
  );

  if (loadError) return shell(<p className="text-center text-sm text-slate-600">{loadError === 'Feedback link not found.' ? 'This feedback link is not valid.' : loadError}</p>);
  if (!info) return shell(<div className="flex justify-center py-10"><Spinner /></div>);

  const header = (
    <div className="mb-5 text-center">
      {info.logoUrl ? (
         
        <img src={info.logoUrl} alt="" className="mx-auto mb-2 h-12 w-12 rounded-lg object-cover" />
      ) : (
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-brand-600 text-lg font-bold text-white" style={accent ? { background: accent } : undefined}>
          {info.businessName.charAt(0)}
        </div>
      )}
      <p className="text-sm font-semibold text-slate-900">{info.businessName}</p>
      <p className="text-xs text-slate-500">{info.branchName}</p>
    </div>
  );

  if (done) {
    return shell(
      <>
        {header}
        <div className="text-center" data-testid="feedback-thanks">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
          <h1 className="mt-3 text-lg font-semibold">Thank you{info.customerFirstName ? `, ${info.customerFirstName}` : ''}!</h1>
          <p className="mt-1 text-sm text-slate-600">{rating >= 4 ? 'We are so glad you enjoyed your visit.' : 'We are sorry it was not perfect. Our manager will look into this personally.'}</p>
          {done.reviewUrl && (
            <a href={done.reviewUrl} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              Share it on Google <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
      </>,
    );
  }

  if (info.used || info.expired) {
    return shell(
      <>
        {header}
        <p className="text-center text-sm text-slate-600">{info.used ? 'You have already shared feedback for this visit. Thank you!' : 'This feedback link has expired.'}</p>
      </>,
    );
  }

  const shown = hover || rating;
  return shell(
    <>
      {header}
      <h1 className="text-center text-lg font-semibold text-slate-900">
        {info.customerFirstName ? `Hi ${info.customerFirstName}, how` : 'How'} was your {info.serviceName ?? 'visit'}?
      </h1>
      {info.therapistName && <p className="mt-1 text-center text-sm text-slate-500">with {info.therapistName}</p>}
      <div className="mt-5 flex justify-center gap-1.5" onMouseLeave={() => setHover(0)} role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onMouseEnter={() => setHover(n)} onClick={() => setRating(n)} className="p-1">
            <Star className={`h-9 w-9 transition ${n <= shown ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} />
          </button>
        ))}
      </div>
      <p className="mt-1 h-5 text-center text-sm font-medium text-slate-600">{LABELS[shown]}</p>
      {rating > 0 && (
        <div className="mt-4 space-y-3">
          <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={rating >= 4 ? 'What did you love? (optional)' : 'What could we do better? (optional)'} maxLength={2000} />
          {askContact && (
            <div className="grid grid-cols-2 gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)" />
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (optional)" inputMode="tel" />
            </div>
          )}
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <Button className="w-full" onClick={submit} loading={busy}>Submit feedback</Button>
        </div>
      )}
    </>,
  );
}
