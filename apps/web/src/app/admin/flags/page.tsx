'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Card, CardHeader, LoadingBlock, PageHeader, Select, Table, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { titleCase } from '@/lib/format';

interface Flag { key: string; global: boolean | null; plans: string[]; overrides: { tenantId: string; tenantName: string; enabled: boolean }[] }

export default function AdminFlagsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'flags'], queryFn: () => api.get<Flag[]>('/admin/flags') });
  const [saving, setSaving] = useState<string | null>(null);
  const put = async (key: string, enabled: boolean | null, tenantId?: string) => {
    setSaving(`${key}:${tenantId ?? ''}`);
    try {
      const next = await api.put<Flag[]>('/admin/flags', { key, enabled, tenantId });
      qc.setQueryData(['admin', 'flags'], next);
      toast.success('Flag updated');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader title="Feature flags" description="Plans decide the default. A global flag overrides every plan (use it as a kill switch); per-business overrides win over both." />
      <Card>
        <CardHeader title="Flags" description="Set per-business overrides from the business page." />
        {isLoading || !data ? <LoadingBlock /> : (
          <Table>
            <THead><TR><TH>Feature</TH><TH>Global</TH><TH>Included in plans</TH><TH>Business overrides</TH></TR></THead>
            <TBody>
              {data.map((f) => (
                <TR key={f.key} data-testid={`global-flag-${f.key}`}>
                  <TD><p className="font-medium">{titleCase(f.key.replace(/_ENABLED$/, ''))}</p><p className="font-mono text-[11px] text-slate-500">{f.key}</p></TD>
                  <TD>
                    <Select value={f.global === null ? '' : f.global ? 'on' : 'off'} disabled={saving === `${f.key}:`} onChange={(e) => put(f.key, e.target.value === '' ? null : e.target.value === 'on')} className="h-8 w-40 text-xs" aria-label={`Global ${f.key}`}>
                      <option value="">Follow plans</option>
                      <option value="on">On for everyone</option>
                      <option value="off">Off for everyone</option>
                    </Select>
                  </TD>
                  <TD><div className="flex flex-wrap gap-1">{f.plans.length ? f.plans.map((p) => <Badge key={p} tone="brand">{p}</Badge>) : <span className="text-xs text-slate-400">None</span>}</div></TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {f.overrides.map((o) => (
                        <span key={o.tenantId} className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ring-1 ring-inset ${o.enabled ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-rose-200'}`}>
                          <Link href={`/admin/tenants/${o.tenantId}`} className="hover:underline">{o.tenantName}</Link>: {o.enabled ? 'on' : 'off'}
                          <button type="button" aria-label={`Remove override for ${o.tenantName}`} onClick={() => put(f.key, null, o.tenantId)} className="opacity-60 hover:opacity-100"><X className="h-3 w-3" /></button>
                        </span>
                      ))}
                      {!f.overrides.length && <span className="text-xs text-slate-400">None</span>}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
