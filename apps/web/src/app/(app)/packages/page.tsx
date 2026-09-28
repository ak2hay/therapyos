'use client';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Gift, Pencil, Plus, Search, Trash2, Undo2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, LoadingBlock, Modal, PageHeader, Pagination, Select, StatusBadge, Table, Tabs, TBody, TD, Textarea, TH, THead, TR } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import { useBranches, useServices, useWorkingBranch } from '@/lib/queries';
import { SellModal } from '@/components/billing-actions';

interface PackageRow {
  id: string;
  name: string;
  description: string | null;
  validityDays: number;
  price: number;
  taxRate: number;
  status: 'ACTIVE' | 'INACTIVE';
  soldCount: number;
  worth: number;
  savings: number;
  items: { serviceId: string; quantity: number; service: { id: string; name: string; basePrice: number } }[];
}

interface CustomerPackageRow {
  id: string;
  status: string;
  purchasedAt: string;
  expiresAt: string;
  purchaseInvoiceId: string | null;
  package: { id: string; name: string };
  customer: { id: string; name: string; phone: string; customerCode: string };
  items: { id: string; serviceId: string; totalQuantity: number; usedQuantity: number; service: { id: string; name: string } }[];
  totalSessions: number;
  usedSessions: number;
  remainingSessions: number;
}
interface CustomerPackageDetail extends CustomerPackageRow {
  redemptions: { id: string; serviceName: string | null; quantity: number; redeemedAt: string; reversedAt: string | null; sessionId: string | null }[];
}

function PackageForm({ existing, onDone }: { existing?: PackageRow; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: services } = useServices({ activeOnly: true });
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    validityDays: String(existing?.validityDays ?? 90),
    price: existing ? String(existing.price) : '',
    taxRate: String(existing?.taxRate ?? 18),
    status: existing?.status ?? 'ACTIVE',
  });
  const [items, setItems] = useState(existing?.items.map((i) => ({ serviceId: i.serviceId, quantity: String(i.quantity) })) ?? [{ serviceId: '', quantity: '5' }]);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const worth = items.reduce((s, i) => s + (services?.find((x) => x.id === i.serviceId)?.basePrice ?? 0) * Number(i.quantity || 0), 0);

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        ...form,
        validityDays: Number(form.validityDays),
        price: Number(form.price),
        taxRate: Number(form.taxRate),
        items: items.filter((i) => i.serviceId).map((i) => ({ serviceId: i.serviceId, quantity: Number(i.quantity) })),
      };
      if (existing) await api.patch(`/packages/${existing.id}`, body);
      else await api.post('/packages', body);
      await qc.invalidateQueries({ queryKey: ['packages'] });
      toast.success('Package saved');
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Package name" className="sm:col-span-2"><Input value={form.name} onChange={set('name')} placeholder="e.g. Swedish Relax x5" /></Field>
        <Field label="Price"><Input type="number" min={0} step="0.01" value={form.price} onChange={set('price')} /></Field>
        <Field label="Valid for (days)"><Input type="number" min={1} value={form.validityDays} onChange={set('validityDays')} /></Field>
        <Field label="Tax rate (%)"><Input type="number" min={0} max={100} step="0.01" value={form.taxRate} onChange={set('taxRate')} /></Field>
        <Field label="Status">
          <Select value={form.status} onChange={set('status')}>
            <option value="ACTIVE">On sale</option>
            <option value="INACTIVE">Not on sale</option>
          </Select>
        </Field>
        <Field label="Description" className="sm:col-span-2"><Textarea value={form.description} onChange={set('description')} /></Field>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium text-slate-600">Sessions included</p>
        <div className="space-y-2">
          {items.map((it, i) => (
            <div key={i} className="flex gap-2">
              <Select value={it.serviceId} onChange={(e) => setItems((p) => p.map((x, j) => (j === i ? { ...x, serviceId: e.target.value } : x)))}>
                <option value="">Select service</option>
                {services?.map((s) => <option key={s.id} value={s.id}>{s.name} ({money(s.basePrice)})</option>)}
              </Select>
              <Input type="number" min={1} className="w-24" value={it.quantity} onChange={(e) => setItems((p) => p.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} aria-label="Sessions" />
              <Button variant="ghost" size="icon" onClick={() => setItems((p) => p.filter((_, j) => j !== i))} disabled={items.length === 1}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setItems((p) => [...p, { serviceId: '', quantity: '1' }])}><Plus className="h-3.5 w-3.5" /> Add service</Button>
        </div>
        {worth > 0 && form.price !== '' && (
          <p className="mt-3 text-sm text-slate-600">
            Worth {money(worth)} at list prices{worth > Number(form.price) && <span className="font-medium text-emerald-700"> · customer saves {money(worth - Number(form.price))}</span>}
          </p>
        )}
      </div>
      {existing && existing.soldCount > 0 && <p className="text-xs text-slate-500">Changes apply to new sales only. The {existing.soldCount} packages already sold keep their original sessions.</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button onClick={save} loading={busy} disabled={!form.name || form.price === '' || !items.some((i) => i.serviceId)}>Save package</Button>
      </div>
    </div>
  );
}

function CatalogueTab({ canManage, canSell }: { canManage: boolean; canSell: boolean }) {
  const [editing, setEditing] = useState<PackageRow | null | undefined>(undefined);
  const [selling, setSelling] = useState<PackageRow | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['packages', 'catalogue'], queryFn: () => api.get<PackageRow[]>('/packages') });
  const onSale = (data ?? []).filter((p) => p.status === 'ACTIVE');

  return (
    <>
      {canManage && (
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> New package</Button>
        </div>
      )}
      {isLoading ? (
        <LoadingBlock />
      ) : !data?.length ? (
        <Card><EmptyState icon={<Gift className="h-6 w-6" />} title="No packages yet" description="Bundle sessions at a discount to bring customers back." action={canManage && <Button onClick={() => setEditing(null)}>Create package</Button>} /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((p) => (
            <Card key={p.id} className={`flex flex-col p-5 ${p.status !== 'ACTIVE' ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-slate-900">{p.name}</h3>
                  <p className="text-xs text-slate-500">Valid {p.validityDays} days · {p.soldCount} sold</p>
                </div>
                {p.status !== 'ACTIVE' ? <Badge>Not on sale</Badge> : p.savings > 0 && <Badge tone="green">Save {money(p.savings)}</Badge>}
              </div>
              <ul className="mt-3 flex-1 space-y-1 text-sm text-slate-600">
                {p.items.map((i) => <li key={i.serviceId}>{i.quantity} x {i.service.name}</li>)}
              </ul>
              <div className="mt-4 flex items-end justify-between">
                <div>
                  <p className="text-xl font-semibold text-slate-900">{money(p.price)}</p>
                  {p.savings > 0 && <p className="text-xs text-slate-400 line-through">{money(p.worth)}</p>}
                </div>
                <div className="flex gap-1">
                  {canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(p)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>}
                  {canSell && p.status === 'ACTIVE' && <Button size="sm" onClick={() => setSelling(p)}>Sell</Button>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? `Edit ${editing.name}` : 'New package'} size="lg">
        {editing !== undefined && <PackageForm existing={editing ?? undefined} onDone={() => setEditing(undefined)} />}
      </Modal>
      {selling && <SellModal kind="PACKAGE" options={onSale} defaultItemId={selling.id} onClose={() => setSelling(null)} />}
    </>
  );
}

function CustomerPackageModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const { data: branches } = useBranches();
  const branchId = useWorkingBranch(branches);
  const { data: cp } = useQuery({ queryKey: ['customer-package', id], queryFn: () => api.get<CustomerPackageDetail>(`/customer-packages/${id}`) });
  const [serviceId, setServiceId] = useState('');
  const [busy, setBusy] = useState(false);
  const canRedeem = hasPermission(user, PERMISSIONS.PACKAGE_REDEEM);
  const canReverse = hasPermission(user, PERMISSIONS.PACKAGE_MANAGE);
  const active = cp?.status === 'ACTIVE' && new Date(cp.expiresAt) > new Date();

  const refresh = (next: CustomerPackageDetail) => {
    qc.setQueryData(['customer-package', id], next);
    qc.invalidateQueries({ queryKey: ['packages'] });
  };
  const redeem = async () => {
    setBusy(true);
    try {
      refresh(await api.post<CustomerPackageDetail>(`/customer-packages/${id}/redeem`, { serviceId, quantity: 1, branchId }));
      toast.success('Session redeemed');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const reverse = async (redemptionId: string) => {
    try {
      await api.post(`/customer-packages/redemptions/${redemptionId}/reverse`, { reason: 'Reversed from package screen' });
      refresh(await api.get<CustomerPackageDetail>(`/customer-packages/${id}`));
      toast.success('Redemption reversed, session returned to the package');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Modal open onClose={onClose} title={cp ? cp.package.name : 'Package'} description={cp ? `${cp.customer.name} · ${cp.customer.customerCode}` : undefined} size="lg">
      {!cp ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <StatusBadge status={cp.status} />
            <span>Bought {fmtDate(cp.purchasedAt)}</span>
            <span>Expires {fmtDate(cp.expiresAt)}</span>
            {cp.purchaseInvoiceId && <Link className="text-brand-700 hover:underline" href={`/invoices/${cp.purchaseInvoiceId}`}>Purchase invoice</Link>}
          </div>
          <div className="space-y-2">
            {cp.items.map((i) => (
              <div key={i.id}>
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-slate-800">{i.service.name}</span>
                  <span className="tabular-nums text-slate-600">{i.totalQuantity - i.usedQuantity} of {i.totalQuantity} left</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-brand-500" style={{ width: `${(i.usedQuantity / i.totalQuantity) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          {canRedeem && active && (
            <div className="flex gap-2 rounded-lg border border-slate-200 p-3">
              <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                <option value="">Redeem a session manually…</option>
                {cp.items.filter((i) => i.totalQuantity > i.usedQuantity).map((i) => <option key={i.serviceId} value={i.serviceId}>{i.service.name}</option>)}
              </Select>
              <Button onClick={redeem} loading={busy} disabled={!serviceId || !branchId}>Redeem</Button>
            </div>
          )}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Redemption history</p>
            {!cp.redemptions.length ? (
              <p className="text-sm text-slate-500">No sessions used yet. Completed sessions for included services are deducted automatically.</p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {cp.redemptions.map((r) => (
                  <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <div className={r.reversedAt ? 'text-slate-400 line-through' : ''}>
                      {r.quantity} x {r.serviceName ?? 'Service'} <span className="text-xs text-slate-500">· {fmtDateTime(r.redeemedAt)}{r.sessionId ? ' · from session' : ''}</span>
                    </div>
                    {r.reversedAt ? (
                      <Badge>Reversed</Badge>
                    ) : (
                      canReverse && <Button size="sm" variant="ghost" onClick={() => reverse(r.id)} title="Return this session to the package"><Undo2 className="h-4 w-4" /></Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function SoldTab({ canSell }: { canSell: boolean }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [selling, setSelling] = useState(false);
  const { data: catalogue } = useQuery({ queryKey: ['packages', 'catalogue'], queryFn: () => api.get<PackageRow[]>('/packages') });
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const { data, isLoading } = useQuery({
    queryKey: ['packages', 'sold', debounced, status, page],
    queryFn: () =>
      api.page<CustomerPackageRow>('/customer-packages', {
        search: debounced || undefined,
        status: status === 'EXPIRING' ? undefined : status || undefined,
        expiringInDays: status === 'EXPIRING' ? '14' : undefined,
        page: String(page),
        pageSize: '25',
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input className="pl-9" placeholder="Customer name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select className="w-48" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="ACTIVE">Active</option>
          <option value="EXPIRING">Expiring in 14 days</option>
          <option value="PENDING_PAYMENT">Awaiting payment</option>
          <option value="EXHAUSTED">Used up</option>
          <option value="EXPIRED">Expired</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="">All</option>
        </Select>
        {canSell && !!catalogue?.some((p) => p.status === 'ACTIVE') && (
          <Button className="ml-auto" onClick={() => setSelling(true)}><Plus className="h-4 w-4" /> Sell package</Button>
        )}
      </div>
      {isLoading ? (
        <LoadingBlock />
      ) : !data?.items.length ? (
        <EmptyState icon={<Gift className="h-6 w-6" />} title="No packages match" />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Customer</TH>
                <TH>Package</TH>
                <TH>Sessions left</TH>
                <TH>Expires</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {data.items.map((cp) => {
                const days = Math.ceil((new Date(cp.expiresAt).getTime() - Date.now()) / 86_400_000);
                return (
                  <TR key={cp.id} className="cursor-pointer" onClick={() => setOpen(cp.id)}>
                    <TD><p className="font-medium text-slate-900">{cp.customer.name}</p><p className="text-xs text-slate-500">{cp.customer.phone}</p></TD>
                    <TD>{cp.package.name}</TD>
                    <TD className="tabular-nums">{cp.remainingSessions} / {cp.totalSessions}</TD>
                    <TD className={cp.status === 'ACTIVE' && days <= 14 ? 'font-medium text-amber-700' : 'text-slate-600'}>
                      {fmtDate(cp.expiresAt)}
                      {cp.status === 'ACTIVE' && days >= 0 && days <= 14 && <span className="ml-1 text-xs">({days}d)</span>}
                    </TD>
                    <TD><StatusBadge status={cp.status} /></TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
        </>
      )}
      {open && <CustomerPackageModal id={open} onClose={() => setOpen(null)} />}
      {selling && catalogue && <SellModal kind="PACKAGE" options={catalogue.filter((p) => p.status === 'ACTIVE')} onClose={() => setSelling(false)} />}
    </Card>
  );
}

export default function PackagesPage() {
  const user = useAuth((s) => s.user);
  const [tab, setTab] = useState<'catalogue' | 'sold'>('catalogue');
  const canManage = hasPermission(user, PERMISSIONS.PACKAGE_MANAGE);
  const canSell = hasPermission(user, PERMISSIONS.PACKAGE_SELL) && hasPermission(user, PERMISSIONS.INVOICE_CREATE);
  return (
    <div>
      <PageHeader title="Packages" description="Prepaid session bundles and the packages your customers hold" />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'catalogue', label: 'Catalogue' }, { value: 'sold', label: 'Customer packages' }]} />
      {tab === 'catalogue' ? <CatalogueTab canManage={canManage} canSell={canSell} /> : <SoldTab canSell={canSell} />}
    </div>
  );
}
