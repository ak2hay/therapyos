'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Building2, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  Tabs,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
} from '@therapyos/ui';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasFeature, hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { money } from '@/lib/format';
import { useBranches } from '@/lib/queries';

interface Category {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  status: string;
  serviceCount: number;
}
interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  durationMinutes: number;
  basePrice: number;
  taxRate: number;
  color: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  effectivePrice: number;
  effectiveDuration: number;
  availableAtBranch: boolean;
  therapistCount: number;
  branchServices: { branchId: string; price: number | null; durationMinutes: number | null; isActive: boolean }[];
}
interface ServiceDetail extends ServiceRow {
  consumables: { productId: string; quantity: number; product: { name: string; unit: string } }[];
}
interface TaxRate {
  id: string;
  name: string;
  rate: number;
  status: string;
  isDefault: boolean;
}
interface ProductLite {
  id: string;
  name: string;
  unit: string;
}

function ServiceForm({ serviceId, categories, onDone }: { serviceId?: string; categories: Category[]; onDone: () => void }) {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const inventory = hasFeature(user, FeatureFlagKey.INVENTORY_ENABLED);
  const { data: existing, isLoading } = useQuery({
    queryKey: ['service', serviceId],
    queryFn: () => api.get<ServiceDetail>(`/services/${serviceId}`),
    enabled: !!serviceId,
  });
  const { data: taxRates } = useQuery({ queryKey: ['tax-rates'], queryFn: () => api.get<TaxRate[]>('/tax-rates') });
  const { data: products } = useQuery({
    queryKey: ['products', 'consumable'],
    queryFn: () => api.get<ProductLite[]>('/products', { consumable: 'true', all: 'true' }),
    enabled: inventory,
  });
  if (serviceId && isLoading) return <LoadingBlock />;
  return <ServiceFormInner key={existing?.id ?? 'new'} existing={existing} categories={categories} taxRates={taxRates ?? []} products={products ?? []} inventory={inventory} onDone={async () => { await qc.invalidateQueries({ queryKey: ['services'] }); onDone(); }} />;
}

function ServiceFormInner({
  existing,
  categories,
  taxRates,
  products,
  inventory,
  onDone,
}: {
  existing?: ServiceDetail;
  categories: Category[];
  taxRates: TaxRate[];
  products: ProductLite[];
  inventory: boolean;
  onDone: () => void;
}) {
  const defaultTax = taxRates.find((t) => t.isDefault)?.rate ?? 0;
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    categoryId: existing?.categoryId ?? '',
    durationMinutes: String(existing?.durationMinutes ?? 60),
    basePrice: String(existing?.basePrice ?? ''),
    taxRate: String(existing?.taxRate ?? defaultTax),
    color: existing?.color ?? '#0d9488',
    status: existing?.status ?? 'ACTIVE',
  });
  const [consumables, setConsumables] = useState(existing?.consumables.map((c) => ({ productId: c.productId, quantity: String(c.quantity) })) ?? []);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        ...form,
        categoryId: form.categoryId || undefined,
        durationMinutes: Number(form.durationMinutes),
        basePrice: Number(form.basePrice),
        taxRate: Number(form.taxRate),
        ...(inventory ? { consumables: consumables.filter((c) => c.productId).map((c) => ({ productId: c.productId, quantity: Number(c.quantity) })) } : {}),
      };
      if (existing) await api.patch(`/services/${existing.id}`, body);
      else await api.post('/services', body);
      toast.success('Service saved');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const taxOptions = [...new Set([0, ...taxRates.filter((t) => t.status === 'ACTIVE').map((t) => Number(t.rate))])];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Service name" className="sm:col-span-2"><Input value={form.name} onChange={set('name')} /></Field>
        <Field label="Category">
          <Select value={form.categoryId} onChange={set('categoryId')}>
            <option value="">Uncategorised</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Duration (minutes)"><Input type="number" min={5} step={5} value={form.durationMinutes} onChange={set('durationMinutes')} /></Field>
        <Field label="Base price"><Input type="number" min={0} step="0.01" value={form.basePrice} onChange={set('basePrice')} /></Field>
        <Field label="Tax rate (%)">
          <Select value={form.taxRate} onChange={set('taxRate')}>
            {taxOptions.map((r) => <option key={r} value={r}>{r}%</option>)}
          </Select>
        </Field>
        <Field label="Calendar colour"><Input type="color" value={form.color} onChange={set('color')} className="h-9 p-1" /></Field>
        <Field label="Status">
          <Select value={form.status} onChange={set('status')}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </Field>
        <Field label="Description" className="sm:col-span-2"><Textarea value={form.description} onChange={set('description')} /></Field>
      </div>
      {inventory && (
        <div>
          <p className="mb-2 text-xs font-medium text-slate-600">Consumables used per session (auto-deducted from stock)</p>
          <div className="space-y-2">
            {consumables.map((c, i) => (
              <div key={i} className="flex gap-2">
                <Select value={c.productId} onChange={(e) => setConsumables((p) => p.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
                  <option value="">Select product</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
                </Select>
                <Input type="number" step="0.001" className="w-28" value={c.quantity} onChange={(e) => setConsumables((p) => p.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                <Button variant="ghost" size="icon" onClick={() => setConsumables((p) => p.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setConsumables((p) => [...p, { productId: '', quantity: '1' }])}><Plus className="h-3.5 w-3.5" /> Add consumable</Button>
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button onClick={save} loading={busy} disabled={!form.name || form.basePrice === ''}>Save service</Button>
      </div>
    </div>
  );
}

function BranchPricing({ service, onDone }: { service: ServiceRow; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: branches } = useBranches();
  const [rows, setRows] = useState<Record<string, { price: string; duration: string; isActive: boolean; overridden: boolean }>>(() =>
    Object.fromEntries(
      service.branchServices.map((b) => [b.branchId, { price: b.price != null ? String(b.price) : '', duration: b.durationMinutes ? String(b.durationMinutes) : '', isActive: b.isActive, overridden: true }]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      for (const b of branches ?? []) {
        const r = rows[b.id];
        if (!r) continue;
        const isDefault = !r.price && !r.duration && r.isActive;
        if (isDefault) {
          if (r.overridden) await api.delete(`/services/${service.id}/branches/${b.id}`);
        } else {
          await api.put(`/services/${service.id}/branches`, {
            branchId: b.id,
            price: r.price ? Number(r.price) : undefined,
            durationMinutes: r.duration ? Number(r.duration) : undefined,
            isActive: r.isActive,
          });
        }
      }
      await qc.invalidateQueries({ queryKey: ['services'] });
      toast.success('Branch pricing saved');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        Default: {money(service.basePrice)} · {service.durationMinutes} min. Leave blank to use the default.
      </p>
      <Table>
        <THead><TR><TH>Branch</TH><TH>Price</TH><TH>Duration</TH><TH>Offered</TH></TR></THead>
        <TBody>
          {branches?.map((b) => {
            const r = rows[b.id] ?? { price: '', duration: '', isActive: true, overridden: false };
            const update = (patch: Partial<typeof r>) => setRows((p) => ({ ...p, [b.id]: { ...r, ...patch } }));
            return (
              <TR key={b.id}>
                <TD className="font-medium">{b.name}</TD>
                <TD><Input type="number" className="w-28" placeholder={String(service.basePrice)} value={r.price} onChange={(e) => update({ price: e.target.value })} /></TD>
                <TD><Input type="number" className="w-24" placeholder={String(service.durationMinutes)} value={r.duration} onChange={(e) => update({ duration: e.target.value })} /></TD>
                <TD><Checkbox checked={r.isActive} onChange={(e) => update({ isActive: e.target.checked })} /></TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button onClick={save} loading={busy}>Save</Button>
      </div>
    </div>
  );
}

function CategoriesTab({ categories, canManage }: { categories: Category[]; canManage: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<Category> | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const save = async () => {
    try {
      const body = { name: editing!.name, description: editing!.description ?? '', sortOrder: Number(editing!.sortOrder ?? 0) };
      if (editing!.id) await api.patch(`/service-categories/${editing!.id}`, body);
      else await api.post('/service-categories', body);
      await qc.invalidateQueries({ queryKey: ['service-categories'] });
      setEditing(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Card>
      <div className="flex justify-end border-b border-slate-100 p-3">
        {canManage && <Button size="sm" onClick={() => setEditing({ sortOrder: categories.length })}><Plus className="h-4 w-4" /> Add category</Button>}
      </div>
      <Table>
        <THead><TR><TH>Category</TH><TH>Services</TH><TH>Order</TH><TH /></TR></THead>
        <TBody>
          {categories.map((c) => (
            <TR key={c.id}>
              <TD><p className="font-medium">{c.name}</p><p className="text-xs text-slate-500">{c.description}</p></TD>
              <TD>{c.serviceCount}</TD>
              <TD>{c.sortOrder}</TD>
              <TD className="text-right">
                {canManage && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(c)}><Pencil className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(c)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>
                  </>
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit category' : 'New category'} size="sm"
        footer={<><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save} disabled={!editing?.name}>Save</Button></>}>
        <div className="space-y-3">
          <Field label="Name"><Input value={editing?.name ?? ''} onChange={(e) => setEditing((p) => ({ ...p, name: e.target.value }))} /></Field>
          <Field label="Description"><Input value={editing?.description ?? ''} onChange={(e) => setEditing((p) => ({ ...p, description: e.target.value }))} /></Field>
          <Field label="Display order"><Input type="number" value={editing?.sortOrder ?? 0} onChange={(e) => setEditing((p) => ({ ...p, sortOrder: Number(e.target.value) }))} /></Field>
        </div>
      </Modal>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete category" danger confirmLabel="Delete"
        message={`Delete "${deleting?.name}"? Its services become uncategorised.`}
        onConfirm={async () => {
          try {
            await api.delete(`/service-categories/${deleting!.id}`);
            await qc.invalidateQueries({ queryKey: ['service-categories'] });
            await qc.invalidateQueries({ queryKey: ['services'] });
            setDeleting(null);
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }} />
    </Card>
  );
}

export default function ServicesPage() {
  const user = useAuth((s) => s.user);
  const canManage = hasPermission(user, PERMISSIONS.SERVICE_MANAGE);
  const branchId = useBranch((s) => s.branchId);
  const [tab, setTab] = useState<'services' | 'categories'>('services');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [pricing, setPricing] = useState<ServiceRow | null>(null);
  const { data: categories } = useQuery({ queryKey: ['service-categories'], queryFn: () => api.get<Category[]>('/service-categories') });
  const { data: services, isLoading } = useQuery({
    queryKey: ['services', { branchId, all: true }],
    queryFn: () => api.get<ServiceRow[]>('/services', { branchId: branchId ?? undefined }),
  });

  const grouped = useMemo(() => {
    const filtered = (services ?? []).filter(
      (s) => (showInactive || s.status === 'ACTIVE') && (!search || s.name.toLowerCase().includes(search.toLowerCase())),
    );
    const map = new Map<string, ServiceRow[]>();
    for (const s of filtered) {
      const key = s.category?.name ?? 'Uncategorised';
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()];
  }, [services, search, showInactive]);

  return (
    <div>
      <PageHeader
        title="Services"
        description={branchId ? 'Prices shown for the selected branch.' : 'Base prices shown. Select a branch to see branch pricing.'}
        actions={canManage && tab === 'services' && <Button onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> Add service</Button>}
      />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'services', label: 'Services' }, { value: 'categories', label: 'Categories' }]} />
      {tab === 'categories' ? (
        <CategoriesTab categories={categories ?? []} canManage={canManage} />
      ) : (
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-3">
            <Input placeholder="Search services" className="max-w-xs" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          </div>
          {isLoading ? (
            <LoadingBlock />
          ) : !grouped.length ? (
            <EmptyState title="No services yet" description="Add the therapies your business offers." action={canManage && <Button onClick={() => setEditing(null)}>Add service</Button>} />
          ) : (
            <Table>
              <THead><TR><TH>Service</TH><TH>Duration</TH><TH>Price</TH><TH>Tax</TH><TH>Therapists</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {grouped.map(([cat, list]) => (
                  <Fragment key={cat}>
                    <TR className="bg-slate-50/70 hover:bg-slate-50/70">
                      <TD colSpan={7} className="py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{cat}</TD>
                    </TR>
                    {list.map((s) => (
                      <TR key={s.id}>
                        <TD>
                          <div className="flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color ?? '#94a3b8' }} />
                            <span className="font-medium text-slate-900">{s.name}</span>
                            {branchId && !s.availableAtBranch && <Badge tone="red">Not offered here</Badge>}
                            {s.branchServices.length > 0 && <Badge tone="blue">{s.branchServices.length} branch override{s.branchServices.length > 1 ? 's' : ''}</Badge>}
                          </div>
                        </TD>
                        <TD>{s.effectiveDuration} min</TD>
                        <TD className="font-medium">
                          {money(s.effectivePrice)}
                          {s.effectivePrice !== Number(s.basePrice) && <span className="ml-1 text-xs text-slate-400 line-through">{money(s.basePrice)}</span>}
                        </TD>
                        <TD>{Number(s.taxRate)}%</TD>
                        <TD>{s.therapistCount}</TD>
                        <TD><StatusBadge status={s.status} /></TD>
                        <TD className="whitespace-nowrap text-right">
                          {canManage && (
                            <>
                              <Button size="sm" variant="ghost" title="Branch pricing" onClick={() => setPricing(s)}><Building2 className="h-4 w-4" /></Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditing(s.id)}><Pencil className="h-4 w-4" /></Button>
                            </>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </Fragment>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}
      <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? 'Edit service' : 'New service'} size="lg">
        <ServiceForm serviceId={editing ?? undefined} categories={categories ?? []} onDone={() => setEditing(undefined)} />
      </Modal>
      <Modal open={!!pricing} onClose={() => setPricing(null)} title={`Branch pricing: ${pricing?.name}`} size="lg">
        {pricing && <BranchPricing service={pricing} onDone={() => setPricing(null)} />}
      </Modal>
    </div>
  );
}
