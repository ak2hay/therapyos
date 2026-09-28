'use client';
import { useQuery } from '@tanstack/react-query';
import { Activity, Database, HardDrive, Play, RefreshCw, Server } from 'lucide-react';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardContent, CardHeader, LoadingBlock, PageHeader, StatCard, Table, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { ago, fmtDateTime, titleCase } from '@/lib/format';

interface Service { status: 'up' | 'down'; latencyMs?: number; error?: string; driver?: string }
interface QueueRow { name: string; waiting?: number; active?: number; delayed?: number; failed?: number; completed?: number; error?: string }
interface SystemHealth {
  checkedAt: string;
  services: { database: Service; redis: Service; storage: Service };
  queues: QueueRow[];
  outbox: { byStatus: Record<string, number>; oldestPendingSeconds: number; recentFailures: { id: string; type: string; tenantId: string | null; attempts: number; error: string | null; createdAt: string }[] };
  notificationsLast24h: Record<string, number>;
  pastDueSubscriptions: number;
  process: { uptimeSeconds: number; rssMb: number; heapUsedMb: number; node: string; pid: number; env: string };
  providers: Record<string, string>;
}

const duration = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`);

function ServiceTile({ name, icon, service }: { name: string; icon: React.ReactNode; service: Service }) {
  return (
    <Card data-testid={`service-${name.toLowerCase()}`}>
      <CardContent className="flex items-center gap-3">
        <div className={`rounded-lg p-2 ${service.status === 'up' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>{icon}</div>
        <div className="flex-1">
          <p className="text-sm font-medium">{name}</p>
          <p className="text-xs text-slate-500">{service.error ?? (service.driver ? `Driver: ${service.driver}` : `${service.latencyMs} ms`)}</p>
        </div>
        <Badge tone={service.status === 'up' ? 'green' : 'red'}>{service.status === 'up' ? 'Up' : 'Down'}</Badge>
      </CardContent>
    </Card>
  );
}

export default function AdminSystemPage() {
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: ['admin', 'system'], queryFn: () => api.get<SystemHealth>('/admin/system'), refetchInterval: 30_000 });
  const [running, setRunning] = useState(false);
  const runLifecycle = async () => {
    setRunning(true);
    try {
      const r = await api.post<Record<string, number>>('/admin/jobs/subscriptions');
      const changed = Object.entries(r).filter(([, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `${titleCase(k)}: ${v}`);
      toast.success('Subscription lifecycle ran', { description: changed.length ? changed.join(', ') : 'Nothing needed to change.' });
      await refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };
  if (isLoading || !data) return <LoadingBlock />;
  const failedJobs = data.queues.reduce((s, q) => s + (q.failed ?? 0), 0);
  return (
    <div className="space-y-5">
      <PageHeader
        title="System health"
        description={`Checked ${fmtDateTime(data.checkedAt)} · refreshes every 30 seconds`}
        actions={<><Button variant="outline" onClick={() => refetch()} loading={isFetching}><RefreshCw className="h-4 w-4" /> Refresh</Button><Button variant="outline" onClick={runLifecycle} loading={running}><Play className="h-4 w-4" /> Run subscription job</Button></>}
      />
      <div className="grid gap-4 md:grid-cols-3">
        <ServiceTile name="Database" icon={<Database className="h-5 w-5" />} service={data.services.database} />
        <ServiceTile name="Redis" icon={<Server className="h-5 w-5" />} service={data.services.redis} />
        <ServiceTile name="Storage" icon={<HardDrive className="h-5 w-5" />} service={data.services.storage} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Pending events" value={data.outbox.byStatus.PENDING ?? 0} hint={data.outbox.oldestPendingSeconds ? `Oldest waiting ${duration(data.outbox.oldestPendingSeconds)}` : 'Outbox is drained'} icon={<Activity className="h-4 w-4" />} />
        <StatCard label="Failed events" value={data.outbox.byStatus.FAILED ?? 0} hint={`${data.outbox.byStatus.PROCESSED ?? 0} processed in total`} />
        <StatCard label="Failed jobs" value={failedJobs} hint="Across all queues (retained)" />
        <StatCard label="Past-due subscriptions" value={data.pastDueSubscriptions} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Queues" />
          <Table>
            <THead><TR><TH>Queue</TH><TH className="text-right">Waiting</TH><TH className="text-right">Active</TH><TH className="text-right">Delayed</TH><TH className="text-right">Failed</TH><TH className="text-right">Completed</TH></TR></THead>
            <TBody>
              {data.queues.map((q) => (
                <TR key={q.name}>
                  <TD className="font-mono text-xs">{q.name}</TD>
                  {q.error ? <TD colSpan={5} className="text-xs text-rose-600">{q.error}</TD> : (
                    <>
                      <TD className="text-right">{q.waiting}</TD>
                      <TD className="text-right">{q.active}</TD>
                      <TD className="text-right">{q.delayed}</TD>
                      <TD className={`text-right ${q.failed ? 'font-medium text-rose-600' : ''}`}>{q.failed}</TD>
                      <TD className="text-right text-slate-500">{q.completed}</TD>
                    </>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="API process" />
            <CardContent className="grid grid-cols-2 gap-2 text-sm">
              <span className="text-slate-500">Uptime</span><span>{duration(data.process.uptimeSeconds)}</span>
              <span className="text-slate-500">Memory (RSS)</span><span>{data.process.rssMb} MB</span>
              <span className="text-slate-500">Heap used</span><span>{data.process.heapUsedMb} MB</span>
              <span className="text-slate-500">Node</span><span>{data.process.node}</span>
              <span className="text-slate-500">Environment</span><span>{data.process.env}</span>
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Providers" />
            <CardContent className="grid grid-cols-2 gap-2 text-sm">
              {Object.entries(data.providers).map(([k, v]) => (
                <Fragment key={k}>
                  <span className="text-slate-500">{titleCase(k)}</span>
                  <span><Badge tone={v === 'mock' || v === 'local' ? 'gray' : 'green'}>{v}</Badge></span>
                </Fragment>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Notifications (24 h)" />
            <CardContent className="space-y-1 text-sm">
              {Object.keys(data.notificationsLast24h).length ? Object.entries(data.notificationsLast24h).map(([k, v]) => (
                <div key={k} className="flex justify-between"><span className="text-slate-500">{titleCase(k)}</span><span className="font-medium">{v}</span></div>
              )) : <p className="text-slate-500">None sent.</p>}
            </CardContent>
          </Card>
        </div>
      </div>
      <Card>
        <CardHeader title="Recent failed events" description="Events that exhausted their retries. Their handlers did not run." />
        {data.outbox.recentFailures.length ? (
          <Table>
            <THead><TR><TH>Event</TH><TH>Tenant</TH><TH className="text-right">Attempts</TH><TH>Error</TH><TH>When</TH></TR></THead>
            <TBody>
              {data.outbox.recentFailures.map((f) => (
                <TR key={f.id}>
                  <TD className="font-mono text-xs">{f.type}</TD>
                  <TD className="font-mono text-xs">{f.tenantId ?? '—'}</TD>
                  <TD className="text-right">{f.attempts}</TD>
                  <TD className="max-w-md truncate text-xs text-rose-700" title={f.error ?? ''}>{f.error}</TD>
                  <TD className="text-xs">{ago(f.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <p className="p-6 text-center text-sm text-slate-500">No failed events.</p>}
      </Card>
    </div>
  );
}
