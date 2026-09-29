'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { INTEGRATIONS, type IntegrationProviderKey, type IntegrationSource, type IntegrationView } from '@therapyos/types';
import { Badge, Button, Card, CardContent, CardHeader, Checkbox, Field, Input, LoadingBlock } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';

type Scope = 'platform' | 'tenant';

interface ListResponse {
  items: IntegrationView[];
  webhookUrls: { payments: string; subscriptions?: string };
}

const TEST_TARGET: Partial<Record<IntegrationProviderKey, { label: string; placeholder: string }>> = {
  MSG91: { label: 'Send a test OTP to', placeholder: '+9198xxxxxxxx' },
  WHATSAPP_CLOUD: { label: 'Send hello_world to', placeholder: '+9198xxxxxxxx' },
  SMTP: { label: 'Send a test email to', placeholder: 'you@example.com' },
};

function sourceBadge(scope: Scope, source: IntegrationSource) {
  if (scope === 'tenant') {
    if (source === 'tenant') return <Badge tone="green">Using your own</Badge>;
    if (source === 'mock') return <Badge tone="gray">Not configured</Badge>;
    return <Badge tone="blue">Using Rkyves default</Badge>;
  }
  if (source === 'platform') return <Badge tone="green">Active</Badge>;
  if (source === 'env') return <Badge tone="amber">From server environment</Badge>;
  return <Badge tone="gray">Not configured (mock)</Badge>;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs">
      <p className="text-slate-500">{label}</p>
      <div className="mt-0.5 flex items-center gap-2">
        <code className="flex-1 break-all text-slate-800">{value}</code>
        <button
          type="button"
          className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
          aria-label={`Copy ${label}`}
          onClick={() => navigator.clipboard.writeText(value).then(() => toast.success('Copied'))}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function IntegrationCard({ view, scope, basePath, webhookUrls }: { view: IntegrationView; scope: Scope; basePath: string; webhookUrls: ListResponse['webhookUrls'] }) {
  const qc = useQueryClient();
  const def = INTEGRATIONS[view.provider];
  const [enabled, setEnabled] = useState(view.enabled);
  const [config, setConfig] = useState<Record<string, string>>(() =>
    Object.fromEntries(def.fields.filter((f) => !f.secret).map((f) => [f.key, view.config[f.key] == null ? '' : String(view.config[f.key])])),
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [to, setTo] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const target = TEST_TARGET[view.provider];
  const showFields = scope === 'platform' || enabled || view.configured;

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        enabled,
        config: Object.fromEntries(def.fields.filter((f) => !f.secret).map((f) => [f.key, f.type === 'number' ? (config[f.key] ? Number(config[f.key]) : null) : config[f.key]?.trim() || null])),
        secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim())),
        clear,
      };
      await api.put(`${basePath}/${view.provider}`, body);
      setSecrets({});
      setClear([]);
      toast.success(`${def.name} saved`);
      await qc.invalidateQueries({ queryKey: ['integrations', scope] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.post<{ ok: boolean; message: string }>(`${basePath}/${view.provider}/test`, to.trim() ? { to: to.trim() } : {}));
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card data-testid={`integration-${view.provider}`}>
      <CardHeader
        title={<span className="flex items-center gap-2">{def.name} {sourceBadge(scope, view.effectiveSource)}</span>}
        description={def.description}
        actions={def.docsUrl ? <a href={def.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">Get keys <ExternalLink className="h-3 w-3" /></a> : undefined}
      />
      <CardContent className="space-y-4">
        <Checkbox
          label={scope === 'tenant' ? 'Use my own account instead of the Rkyves default' : 'Enabled for the whole platform'}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {showFields && (
          <div className="grid gap-3 sm:grid-cols-2">
            {def.fields.map((f) =>
              f.secret ? (
                <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.help}>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={secrets[f.key] ?? ''}
                      onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))}
                      placeholder={clear.includes(f.key) ? 'Will be removed on save' : view.secrets[f.key]?.set ? `Saved ${view.secrets[f.key]?.hint ?? ''} · leave blank to keep` : f.placeholder}
                    />
                    {view.secrets[f.key]?.set && !f.required && (
                      <Button type="button" size="sm" variant="ghost" className="h-9" onClick={() => setClear((c) => (c.includes(f.key) ? c.filter((k) => k !== f.key) : [...c, f.key]))}>
                        {clear.includes(f.key) ? 'Keep' : 'Remove'}
                      </Button>
                    )}
                  </div>
                </Field>
              ) : (
                <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.help}>
                  <Input
                    type={f.type === 'number' ? 'number' : 'text'}
                    value={config[f.key] ?? ''}
                    onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                    placeholder={f.placeholder ?? (f.defaultValue !== undefined ? String(f.defaultValue) : undefined)}
                  />
                </Field>
              ),
            )}
          </div>
        )}
        {view.provider === 'RAZORPAY' && showFields && (
          <div className="space-y-2">
            <CopyRow label="Webhook URL for payments (events: payment.captured, payment.failed, order.paid, refund.processed, refund.failed)" value={webhookUrls.payments} />
            {webhookUrls.subscriptions && <CopyRow label="Webhook URL for SaaS subscriptions (events: subscription.*)" value={webhookUrls.subscriptions} />}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
          <Button loading={busy} onClick={save}>Save</Button>
          {target && <Input className="w-56" value={to} onChange={(e) => setTo(e.target.value)} placeholder={target.placeholder} aria-label={target.label} title={target.label} />}
          <Button variant="outline" loading={testing} onClick={test}>Test connection</Button>
          {view.updatedAt && <span className="ml-auto text-xs text-slate-400">Updated {new Date(view.updatedAt).toLocaleString()}</span>}
        </div>
        {result && (
          <p className={`rounded-lg px-3 py-2 text-sm ${result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>{result.message}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Credential forms for every integration in a scope. Secrets are write-only: the API only returns hints. */
export function IntegrationsPanel({ scope }: { scope: Scope }) {
  const basePath = scope === 'platform' ? '/admin/integrations' : '/integrations';
  const { data, isLoading } = useQuery({ queryKey: ['integrations', scope], queryFn: () => api.get<ListResponse>(basePath) });
  if (isLoading || !data) return <LoadingBlock />;
  return (
    <div className="space-y-4">
      {data.items.map((v) => (
        <IntegrationCard key={`${v.provider}:${v.updatedAt ?? 'new'}`} view={v} scope={scope} basePath={basePath} webhookUrls={data.webhookUrls} />
      ))}
    </div>
  );
}
