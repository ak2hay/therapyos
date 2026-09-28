'use client';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRightLeft, Boxes, Pencil, Plus, SlidersHorizontal, Trash2, Truck } from 'lucide-react';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, LoadingBlock, Modal, PageHeader, Pagination, Select, StatCard, StatusBadge, Table, Tabs, TBody, TD, Textarea, TH, THead, TR } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { fmtDate, fmtDateTime, money, num, titleCase, todayIso } from '@/lib/format';
import { BranchLite, useBranches, useWorkingBranch } from '@/lib/queries';

interface Category {
  id: string;
  name: string;
  _count?: { products: number };
}
interface Product {
  id: string;
  name: string;
  sku: string;
  unit: string;
  costPrice: number;
  sellingPrice: number;
  taxRate: number;
  isRetail: boolean;
  isConsumable: boolean;
  barcode: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  categoryId: string | null;
  category: { id: string; name: string } | null;
  onHand: number;
  stockValue: number;
  lowStock: boolean;
  stock: { branchId: string; quantity: number; reorderLevel: number }[];
}
interface StockRow {
  id: string;
  branchId: string;
  productId: string;
  quantity: number;
  reorderLevel: number;
  lowStock: boolean;
  stockValue: number;
  product: { id: string; name: string; sku: string; unit: string; costPrice: number; sellingPrice: number; category: { name: string } | null };
  branch: { id: string; name: string };
}
interface Txn {
  id: string;
  type: string;
  quantity: number;
  unitCost: number | null;
  referenceType: string | null;
  notes: string | null;
  createdAt: string;
  branchName: string | null;
  product: { id: string; name: string; sku: string; unit: string };
}
interface Purchase {
  id: string;
  supplierName: string;
  referenceNumber: string | null;
  totalCost: number;
  purchasedAt: string;
  branchName: string | null;
  items: { id: string; productName: string | null; unit: string | null; quantity: number; unitCost: number }[];
}
interface Transfer {
  id: string;
  status: string;
  fromBranchId: string;
  toBranchId: string;
  fromBranchName: string | null;
  toBranchName: string | null;
  notes: string | null;
  createdAt: string;
  approvedAt: string | null;
  completedAt: string | null;
  items: { id: string; productName: string | null; unit: string | null; quantity: number }[];
}

type Tab = 'stock' | 'products' | 'purchases' | 'transfers' | 'movements';
const TXN_TYPES = ['PURCHASE', 'SALE', 'CONSUMPTION', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT', 'RETURN', 'DAMAGE'];
const OUTFLOW_METHODS = [
  ['BANK_TRANSFER', 'Bank transfer'],
  ['UPI', 'UPI'],
  ['CASH', 'Cash'],
  ['CARD', 'Card'],
  ['OTHER', 'Other'],
] as const;

const useProducts = (opts: { all?: boolean; search?: string } = {}) =>
  useQuery({ queryKey: ['products', opts], queryFn: () => api.get<Product[]>('/products', { all: opts.all ? 'true' : undefined, search: opts.search || undefined }) });
const useCategories = () => useQuery({ queryKey: ['product-categories'], queryFn: () => api.get<Category[]>('/product-categories') });

function qty(v: number, unit: string) {
  return `${num(v, 3)} ${unit}`;
}

export default function InventoryPage() {
  const user = useAuth((s) => s.user);
  const [tab, setTab] = useState<Tab>('stock');
  const tabs: { value: Tab; label: string }[] = [
    { value: 'stock', label: 'Stock' },
    { value: 'products', label: 'Products' },
    { value: 'purchases', label: 'Purchases' },
    { value: 'transfers', label: 'Transfers' },
    { value: 'movements', label: 'Movements' },
  ];
  return (
    <div className="space-y-5">
      <PageHeader title="Inventory" description="Stock by branch, purchases, transfers and every stock movement" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'stock' && <StockTab canAdjust={hasPermission(user, PERMISSIONS.INVENTORY_ADJUST)} />}
      {tab === 'products' && <ProductsTab canManage={hasPermission(user, PERMISSIONS.PRODUCT_MANAGE)} />}
      {tab === 'purchases' && <PurchasesTab canBuy={hasPermission(user, PERMISSIONS.INVENTORY_PURCHASE)} />}
      {tab === 'transfers' && (
        <TransfersTab canTransfer={hasPermission(user, PERMISSIONS.INVENTORY_TRANSFER)} canApprove={hasPermission(user, PERMISSIONS.INVENTORY_TRANSFER_APPROVE)} />
      )}
      {tab === 'movements' && <MovementsTab />}
    </div>
  );
}

// ---------- stock ----------

function StockTab({ canAdjust }: { canAdjust: boolean }) {
  const branchId = useBranch((s) => s.branchId);
  const { data: categories } = useCategories();
  const [filters, setFilters] = useState({ search: '', categoryId: '', lowStock: false });
  const [page, setPage] = useState(1);
  const [adjusting, setAdjusting] = useState<StockRow | null>(null);
  const [reorder, setReorder] = useState<StockRow | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['inventory-stock', filters, page, branchId],
    queryFn: () =>
      api.page<StockRow>('/inventory/stock', {
        search: filters.search || undefined,
        categoryId: filters.categoryId || undefined,
        lowStock: filters.lowStock ? 'true' : undefined,
        branchId: branchId ?? undefined,
        page: String(page),
        pageSize: '25',
      }),
    placeholderData: keepPreviousData,
  });
  const { data: low } = useQuery({ queryKey: ['low-stock', branchId], queryFn: () => api.get<StockRow[]>('/inventory/low-stock', { branchId: branchId ?? undefined }) });
  const value = (data?.meta as { summary?: { stockValue: number } } | undefined)?.summary?.stockValue ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Stock value (at cost)" value={money(value)} hint={`${data?.meta.total ?? 0} stock lines`} icon={<Boxes className="h-4 w-4" />} />
        <StatCard label="At or below reorder level" value={num(low?.length ?? 0)} hint={low?.length ? 'Needs reordering' : 'All good'} icon={<AlertTriangle className="h-4 w-4" />} />
        <StatCard label="Lowest line" value={low?.[0] ? low[0].product.name : '-'} hint={low?.[0] ? `${qty(low[0].quantity, low[0].product.unit)} at ${low[0].branch.name}` : undefined} />
      </div>
      <Card className="p-4">
        <div className="grid items-center gap-3 md:grid-cols-4">
          <Input placeholder="Search product or SKU" value={filters.search} onChange={(e) => { setFilters((f) => ({ ...f, search: e.target.value })); setPage(1); }} />
          <Select value={filters.categoryId} onChange={(e) => { setFilters((f) => ({ ...f, categoryId: e.target.value })); setPage(1); }}>
            <option value="">All categories</option>
            {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Checkbox label="Only low stock" checked={filters.lowStock} onChange={(e) => { setFilters((f) => ({ ...f, lowStock: e.target.checked })); setPage(1); }} />
        </div>
      </Card>
      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.items.length ? (
          <EmptyState icon={<Boxes className="h-6 w-6" />} title="No stock lines" description="Record a purchase to bring products into stock." />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Branch</TH>
                  <TH className="text-right">On hand</TH>
                  <TH className="text-right">Reorder at</TH>
                  <TH className="text-right">Value</TH>
                  <TH>Status</TH>
                  {canAdjust && <TH />}
                </TR>
              </THead>
              <TBody>
                {data.items.map((s) => (
                  <TR key={s.id}>
                    <TD>
                      <p className="font-medium text-slate-900">{s.product.name}</p>
                      <p className="text-xs text-slate-500">{s.product.sku}{s.product.category ? ` · ${s.product.category.name}` : ''}</p>
                    </TD>
                    <TD>{s.branch.name}</TD>
                    <TD className={`text-right tabular-nums ${s.quantity < 0 ? 'text-rose-600' : ''}`}>{qty(s.quantity, s.product.unit)}</TD>
                    <TD className="text-right tabular-nums text-slate-600">{s.reorderLevel ? num(s.reorderLevel, 3) : '-'}</TD>
                    <TD className="text-right tabular-nums">{money(s.stockValue)}</TD>
                    <TD>{s.lowStock ? <Badge tone="red">Low stock</Badge> : <Badge tone="green">OK</Badge>}</TD>
                    {canAdjust && (
                      <TD className="text-right whitespace-nowrap">
                        <Button size="sm" variant="ghost" onClick={() => setAdjusting(s)}><SlidersHorizontal className="h-3.5 w-3.5" /> Adjust</Button>
                        <Button size="sm" variant="ghost" onClick={() => setReorder(s)}>Reorder level</Button>
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
          </>
        )}
      </Card>
      {adjusting && <AdjustModal row={adjusting} onClose={() => setAdjusting(null)} />}
      {reorder && <ReorderModal row={reorder} onClose={() => setReorder(null)} />}
    </div>
  );
}

function useInvalidateStock() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['inventory-stock', 'low-stock', 'products', 'inventory-txns', 'inventory-purchases', 'inventory-transfers']) qc.invalidateQueries({ queryKey: [k] });
  };
}

function AdjustModal({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const refresh = useInvalidateStock();
  const [form, setForm] = useState({ type: 'ADJUSTMENT', direction: 'add', quantity: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const removes = form.type === 'DAMAGE' || form.type === 'CONSUMPTION' || (form.type === 'ADJUSTMENT' && form.direction === 'remove');
  const amount = Number(form.quantity) || 0;
  const after = row.quantity + (removes ? -amount : amount);
  const save = async () => {
    setBusy(true);
    try {
      const signed = form.type === 'ADJUSTMENT' && form.direction === 'remove' ? -amount : amount;
      await api.post('/inventory/adjustments', { branchId: row.branchId, productId: row.productId, type: form.type, quantity: signed, notes: form.notes });
      toast.success('Stock updated');
      refresh();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Adjust ${row.product.name}`}
      description={`${row.branch.name} · currently ${qty(row.quantity, row.product.unit)}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!amount}>Save</Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reason">
            <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
              <option value="ADJUSTMENT">Stock count correction</option>
              <option value="DAMAGE">Damaged / expired</option>
              <option value="CONSUMPTION">Used in-house</option>
              <option value="RETURN">Customer return</option>
            </Select>
          </Field>
          {form.type === 'ADJUSTMENT' && (
            <Field label="Direction">
              <Select value={form.direction} onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value }))}>
                <option value="add">Add to stock</option>
                <option value="remove">Remove from stock</option>
              </Select>
            </Field>
          )}
        </div>
        <Field label={`Quantity (${row.product.unit})`} hint={amount ? `Stock after: ${qty(after, row.product.unit)}` : undefined}>
          <Input type="number" min="0" step="any" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} autoFocus />
        </Field>
        <Field label="Notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Why is stock changing?" />
        </Field>
      </div>
    </Modal>
  );
}

function ReorderModal({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const refresh = useInvalidateStock();
  const [level, setLevel] = useState(String(row.reorderLevel || ''));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/inventory/reorder-level', { branchId: row.branchId, productId: row.productId, reorderLevel: Number(level) || 0 });
      toast.success('Reorder level saved');
      refresh();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="sm" title="Reorder level" description={`${row.product.name} at ${row.branch.name}`} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>Save</Button></>}>
      <Field label={`Alert when stock falls to (${row.product.unit})`} hint="Set 0 to turn off low-stock alerts for this line.">
        <Input type="number" min="0" step="any" value={level} onChange={(e) => setLevel(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

// ---------- products ----------

function ProductsTab({ canManage }: { canManage: boolean }) {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useProducts({ all: true, search });
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [newCategory, setNewCategory] = useState(false);
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <Input className="max-w-xs" placeholder="Search name, SKU or barcode" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex-1" />
        {canManage && (
          <>
            <Button variant="outline" onClick={() => setNewCategory(true)}><Plus className="h-4 w-4" /> Category</Button>
            <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Product</Button>
          </>
        )}
      </Card>
      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.length ? (
          <EmptyState icon={<Boxes className="h-6 w-6" />} title="No products yet" description="Add retail products and the consumables your therapies use." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Product</TH>
                <TH>Type</TH>
                <TH className="text-right">Cost</TH>
                <TH className="text-right">Price</TH>
                <TH className="text-right">On hand</TH>
                <TH>Status</TH>
                {canManage && <TH />}
              </TR>
            </THead>
            <TBody>
              {data.map((p) => (
                <TR key={p.id}>
                  <TD>
                    <p className="font-medium text-slate-900">{p.name}</p>
                    <p className="text-xs text-slate-500">{p.sku}{p.category ? ` · ${p.category.name}` : ''}</p>
                  </TD>
                  <TD className="space-x-1">
                    {p.isRetail && <Badge tone="blue">Retail</Badge>}
                    {p.isConsumable && <Badge tone="purple">Consumable</Badge>}
                  </TD>
                  <TD className="text-right tabular-nums">{money(p.costPrice)}<span className="text-xs text-slate-400">/{p.unit}</span></TD>
                  <TD className="text-right tabular-nums">{p.isRetail ? money(p.sellingPrice) : '-'}</TD>
                  <TD className={`text-right tabular-nums ${p.lowStock ? 'text-rose-600 font-medium' : ''}`}>{qty(p.onHand, p.unit)}</TD>
                  <TD><StatusBadge status={p.status} /></TD>
                  {canManage && (
                    <TD className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}><Pencil className="h-3.5 w-3.5" /></Button>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {editing && <ProductForm existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {newCategory && <CategoryForm onClose={() => setNewCategory(false)} />}
    </div>
  );
}

function CategoryForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/product-categories', { name });
      toast.success('Category added');
      qc.invalidateQueries({ queryKey: ['product-categories'] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="sm" title="New product category" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={name.trim().length < 2}>Add</Button></>}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

function ProductForm({ existing, onClose }: { existing?: Product; onClose: () => void }) {
  const refresh = useInvalidateStock();
  const { data: categories } = useCategories();
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    sku: existing?.sku ?? '',
    categoryId: existing?.categoryId ?? '',
    unit: existing?.unit ?? 'pcs',
    costPrice: existing ? String(existing.costPrice) : '',
    sellingPrice: existing ? String(existing.sellingPrice) : '',
    taxRate: existing ? String(existing.taxRate) : '18',
    barcode: existing?.barcode ?? '',
    isRetail: existing?.isRetail ?? true,
    isConsumable: existing?.isConsumable ?? false,
    status: existing?.status ?? 'ACTIVE',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, costPrice: Number(form.costPrice) || 0, sellingPrice: Number(form.sellingPrice) || 0, taxRate: Number(form.taxRate) || 0 };
      if (existing) await api.patch(`/products/${existing.id}`, body);
      else await api.post('/products', body);
      toast.success(existing ? 'Product updated' : 'Product added');
      refresh();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={existing ? `Edit ${existing.name}` : 'New product'}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={form.name.trim().length < 2 || !form.sku.trim()}>Save</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><Input value={form.name} onChange={set('name')} autoFocus /></Field>
        <Field label="SKU"><Input value={form.sku} onChange={set('sku')} /></Field>
        <Field label="Barcode"><Input value={form.barcode} onChange={set('barcode')} /></Field>
        <Field label="Category">
          <Select value={form.categoryId} onChange={set('categoryId')}>
            <option value="">No category</option>
            {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Unit" hint="pcs, ml, g...">
          <Input value={form.unit} onChange={set('unit')} />
        </Field>
        <Field label="Cost price" hint={existing ? 'Updated automatically to the weighted average on each purchase.' : undefined}>
          <Input type="number" min="0" step="0.01" value={form.costPrice} onChange={set('costPrice')} />
        </Field>
        <Field label="Selling price"><Input type="number" min="0" step="0.01" value={form.sellingPrice} onChange={set('sellingPrice')} disabled={!form.isRetail} /></Field>
        <Field label="Tax rate (%)"><Input type="number" min="0" max="100" step="0.01" value={form.taxRate} onChange={set('taxRate')} /></Field>
        <Field label="Status">
          <Select value={form.status} onChange={set('status')}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </Field>
        <div className="flex flex-wrap gap-6 sm:col-span-2">
          <Checkbox label="Sold at the POS" checked={form.isRetail} onChange={(e) => setForm((f) => ({ ...f, isRetail: e.target.checked }))} />
          <Checkbox label="Used in therapies (consumable)" checked={form.isConsumable} onChange={(e) => setForm((f) => ({ ...f, isConsumable: e.target.checked }))} />
        </div>
      </div>
    </Modal>
  );
}

// ---------- purchases ----------

function PurchasesTab({ canBuy }: { canBuy: boolean }) {
  const branchId = useBranch((s) => s.branchId);
  const [range, setRange] = useState({ from: '', to: '' });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Purchase | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['inventory-purchases', range, page, branchId],
    queryFn: () => api.page<Purchase>('/inventory/purchases', { from: range.from || undefined, to: range.to || undefined, branchId: branchId ?? undefined, page: String(page), pageSize: '20' }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <Input type="date" className="max-w-[11rem]" value={range.from} onChange={(e) => { setRange((r) => ({ ...r, from: e.target.value })); setPage(1); }} aria-label="From date" />
        <Input type="date" className="max-w-[11rem]" value={range.to} onChange={(e) => { setRange((r) => ({ ...r, to: e.target.value })); setPage(1); }} aria-label="To date" />
        <div className="flex-1" />
        {canBuy && <Button onClick={() => setCreating(true)}><Truck className="h-4 w-4" /> Record purchase</Button>}
      </Card>
      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.items.length ? (
          <EmptyState icon={<Truck className="h-6 w-6" />} title="No purchases" description="Stock received from suppliers is recorded here." />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Supplier</TH>
                  <TH>Branch</TH>
                  <TH>Items</TH>
                  <TH className="text-right">Total cost</TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((p) => (
                  <TR key={p.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(p)}>
                    <TD className="text-slate-600">{fmtDate(p.purchasedAt)}</TD>
                    <TD>
                      <p className="font-medium text-slate-900">{p.supplierName}</p>
                      {p.referenceNumber && <p className="text-xs text-slate-500">{p.referenceNumber}</p>}
                    </TD>
                    <TD>{p.branchName}</TD>
                    <TD className="text-slate-600">{p.items.length} {p.items.length === 1 ? 'line' : 'lines'}</TD>
                    <TD className="text-right tabular-nums font-medium">{money(p.totalCost)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
          </>
        )}
      </Card>
      {creating && <PurchaseForm onClose={() => setCreating(false)} />}
      {open && (
        <Modal open onClose={() => setOpen(null)} title={`Purchase from ${open.supplierName}`} description={`${fmtDate(open.purchasedAt)} · ${open.branchName ?? ''}${open.referenceNumber ? ` · ${open.referenceNumber}` : ''}`}>
          <Table>
            <THead><TR><TH>Product</TH><TH className="text-right">Qty</TH><TH className="text-right">Unit cost</TH><TH className="text-right">Total</TH></TR></THead>
            <TBody>
              {open.items.map((i) => (
                <TR key={i.id}>
                  <TD>{i.productName}</TD>
                  <TD className="text-right tabular-nums">{qty(i.quantity, i.unit ?? '')}</TD>
                  <TD className="text-right tabular-nums">{money(i.unitCost)}</TD>
                  <TD className="text-right tabular-nums">{money(i.quantity * i.unitCost)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="mt-3 text-right text-sm font-semibold">Total {money(open.totalCost)}</p>
        </Modal>
      )}
    </div>
  );
}

interface Line {
  productId: string;
  quantity: string;
  unitCost: string;
}

function ProductLines({ products, lines, setLines, withCost }: { products: Product[]; lines: Line[]; setLines: (l: Line[]) => void; withCost?: boolean }) {
  const update = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      {lines.map((l, i) => {
        const p = products.find((x) => x.id === l.productId);
        return (
          <div key={i} className={`grid items-end gap-2 ${withCost ? 'grid-cols-[1fr_7rem_7rem_2.25rem]' : 'grid-cols-[1fr_8rem_2.25rem]'}`}>
            <Field label={i === 0 ? 'Product' : undefined}>
              <Select
                value={l.productId}
                onChange={(e) => {
                  const np = products.find((x) => x.id === e.target.value);
                  update(i, { productId: e.target.value, unitCost: withCost && np && !l.unitCost ? String(np.costPrice) : l.unitCost });
                }}
              >
                <option value="">Select a product</option>
                {products.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.sku})</option>)}
              </Select>
            </Field>
            <Field label={i === 0 ? `Quantity` : undefined}>
              <Input type="number" min="0" step="any" value={l.quantity} onChange={(e) => update(i, { quantity: e.target.value })} placeholder={p?.unit} />
            </Field>
            {withCost && (
              <Field label={i === 0 ? 'Unit cost' : undefined}>
                <Input type="number" min="0" step="0.01" value={l.unitCost} onChange={(e) => update(i, { unitCost: e.target.value })} />
              </Field>
            )}
            <Button variant="ghost" size="icon" onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1} aria-label="Remove line"><Trash2 className="h-4 w-4" /></Button>
          </div>
        );
      })}
      <Button size="sm" variant="outline" onClick={() => setLines([...lines, { productId: '', quantity: '', unitCost: '' }])}><Plus className="h-3.5 w-3.5" /> Add line</Button>
    </div>
  );
}

function BranchSelect({ branches, value, onChange, exclude }: { branches?: BranchLite[]; value: string; onChange: (v: string) => void; exclude?: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select a branch</option>
      {branches?.filter((b) => b.id !== exclude).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </Select>
  );
}

function PurchaseForm({ onClose }: { onClose: () => void }) {
  const refresh = useInvalidateStock();
  const { data: branches } = useBranches();
  const working = useWorkingBranch(branches);
  const { data: products } = useProducts();
  const [form, setForm] = useState({ branchId: working ?? '', supplierName: '', referenceNumber: '', purchasedAt: todayIso(), paymentMethod: 'BANK_TRANSFER', recordExpense: true });
  const [lines, setLines] = useState<Line[]>([{ productId: '', quantity: '', unitCost: '' }]);
  const [busy, setBusy] = useState(false);
  const valid = lines.filter((l) => l.productId && Number(l.quantity) > 0);
  const total = valid.reduce((s, l) => s + Number(l.quantity) * (Number(l.unitCost) || 0), 0);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/inventory/purchases', { ...form, branchId: form.branchId || working, items: valid.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitCost: Number(l.unitCost) || 0 })) });
      toast.success('Purchase recorded and stock updated');
      refresh();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Record a purchase"
      description="Received stock is added to the branch and product cost moves to the weighted average."
      footer={
        <>
          <span className="mr-auto self-center text-sm font-semibold">Total {money(total)}</span>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!valid.length || !form.supplierName.trim()}>Save purchase</Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Branch"><BranchSelect branches={branches} value={form.branchId} onChange={(v) => setForm((f) => ({ ...f, branchId: v }))} /></Field>
          <Field label="Supplier"><Input value={form.supplierName} onChange={(e) => setForm((f) => ({ ...f, supplierName: e.target.value }))} /></Field>
          <Field label="Bill / reference no."><Input value={form.referenceNumber} onChange={(e) => setForm((f) => ({ ...f, referenceNumber: e.target.value }))} /></Field>
          <Field label="Date"><Input type="date" value={form.purchasedAt} max={todayIso()} onChange={(e) => setForm((f) => ({ ...f, purchasedAt: e.target.value }))} /></Field>
          <Field label="Paid by">
            <Select value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))}>
              {OUTFLOW_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox label="Show in expense register" checked={form.recordExpense} onChange={(e) => setForm((f) => ({ ...f, recordExpense: e.target.checked }))} />
          </div>
        </div>
        <ProductLines products={products ?? []} lines={lines} setLines={setLines} withCost />
      </div>
    </Modal>
  );
}

// ---------- transfers ----------

function TransfersTab({ canTransfer, canApprove }: { canTransfer: boolean; canApprove: boolean }) {
  const branchId = useBranch((s) => s.branchId);
  const refresh = useInvalidateStock();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['inventory-transfers', status, page, branchId],
    queryFn: () => api.page<Transfer>('/inventory/transfers', { status: status || undefined, branchId: branchId ?? undefined, page: String(page), pageSize: '20' }),
    placeholderData: keepPreviousData,
  });
  const act = async (t: Transfer, action: 'approve' | 'receive' | 'reject' | 'cancel') => {
    setActing(`${t.id}:${action}`);
    try {
      await api.post(`/inventory/transfers/${t.id}/${action}`);
      toast.success({ approve: 'Transfer approved and dispatched', receive: 'Stock received', reject: 'Transfer rejected', cancel: 'Transfer cancelled' }[action]);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setActing(null);
    }
  };
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <Select className="max-w-[12rem]" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          <option value="REQUESTED">Requested</option>
          <option value="APPROVED">In transit</option>
          <option value="COMPLETED">Completed</option>
          <option value="REJECTED,CANCELLED">Rejected / cancelled</option>
        </Select>
        <div className="flex-1" />
        {canTransfer && <Button onClick={() => setCreating(true)}><ArrowRightLeft className="h-4 w-4" /> Request transfer</Button>}
      </Card>
      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.items.length ? (
          <EmptyState icon={<ArrowRightLeft className="h-6 w-6" />} title="No transfers" description="Move stock between branches: request, approve to dispatch, then receive." />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Requested</TH>
                  <TH>Route</TH>
                  <TH>Items</TH>
                  <TH>Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {data.items.map((t) => (
                  <TR key={t.id}>
                    <TD className="text-slate-600">{fmtDateTime(t.createdAt)}</TD>
                    <TD>
                      <p className="font-medium text-slate-900">{t.fromBranchName} → {t.toBranchName}</p>
                      {t.notes && <p className="text-xs text-slate-500">{t.notes}</p>}
                    </TD>
                    <TD className="text-sm text-slate-700">{t.items.map((i) => `${i.productName} × ${num(i.quantity, 3)}${i.unit && i.unit !== 'pcs' ? ` ${i.unit}` : ''}`).join(', ')}</TD>
                    <TD><StatusBadge status={t.status === 'APPROVED' ? 'IN_TRANSIT' : t.status} /></TD>
                    <TD className="text-right whitespace-nowrap">
                      {t.status === 'REQUESTED' && canApprove && (
                        <>
                          <Button size="sm" variant="success" loading={acting === `${t.id}:approve`} onClick={() => act(t, 'approve')}>Approve</Button>
                          <Button size="sm" variant="ghost" loading={acting === `${t.id}:reject`} onClick={() => act(t, 'reject')}>Reject</Button>
                        </>
                      )}
                      {t.status === 'APPROVED' && canTransfer && (
                        <>
                          <Button size="sm" loading={acting === `${t.id}:receive`} onClick={() => act(t, 'receive')}>Receive</Button>
                          <Button size="sm" variant="ghost" loading={acting === `${t.id}:cancel`} onClick={() => act(t, 'cancel')}>Cancel</Button>
                        </>
                      )}
                      {t.status === 'REQUESTED' && canTransfer && !canApprove && (
                        <Button size="sm" variant="ghost" loading={acting === `${t.id}:cancel`} onClick={() => act(t, 'cancel')}>Cancel</Button>
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
      {creating && <TransferForm onClose={() => setCreating(false)} />}
    </div>
  );
}

function TransferForm({ onClose }: { onClose: () => void }) {
  const refresh = useInvalidateStock();
  const { data: branches } = useBranches();
  const working = useWorkingBranch(branches);
  const { data: products } = useProducts();
  const [route, setRoute] = useState({ fromBranchId: '', toBranchId: working ?? '', notes: '' });
  const [lines, setLines] = useState<Line[]>([{ productId: '', quantity: '', unitCost: '' }]);
  const [busy, setBusy] = useState(false);
  const available = useMemo(() => (products ?? []).filter((p) => !route.fromBranchId || p.stock.some((s) => s.branchId === route.fromBranchId && s.quantity > 0)), [products, route.fromBranchId]);
  const valid = lines.filter((l) => l.productId && Number(l.quantity) > 0);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/inventory/transfers', { ...route, items: valid.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) });
      toast.success('Transfer requested');
      refresh();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Request a stock transfer"
      description="Stock leaves the source branch when the transfer is approved, and arrives when it is received."
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={!valid.length || !route.fromBranchId || !route.toBranchId || route.fromBranchId === route.toBranchId}>Request</Button></>}
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From branch"><BranchSelect branches={branches} value={route.fromBranchId} onChange={(v) => setRoute((r) => ({ ...r, fromBranchId: v }))} exclude={route.toBranchId} /></Field>
          <Field label="To branch"><BranchSelect branches={branches} value={route.toBranchId} onChange={(v) => setRoute((r) => ({ ...r, toBranchId: v }))} exclude={route.fromBranchId} /></Field>
        </div>
        <ProductLines products={available} lines={lines} setLines={setLines} />
        <Field label="Notes"><Textarea rows={2} value={route.notes} onChange={(e) => setRoute((r) => ({ ...r, notes: e.target.value }))} /></Field>
      </div>
    </Modal>
  );
}

// ---------- movements ----------

function MovementsTab() {
  const branchId = useBranch((s) => s.branchId);
  const [filters, setFilters] = useState({ type: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['inventory-txns', filters, page, branchId],
    queryFn: () => api.page<Txn>('/inventory/transactions', { type: filters.type || undefined, from: filters.from || undefined, to: filters.to || undefined, branchId: branchId ?? undefined, page: String(page), pageSize: '30' }),
    placeholderData: keepPreviousData,
  });
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Select value={filters.type} onChange={set('type')}>
            <option value="">All movement types</option>
            {TXN_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </Select>
          <Input type="date" value={filters.from} onChange={set('from')} aria-label="From date" />
          <Input type="date" value={filters.to} onChange={set('to')} aria-label="To date" />
        </div>
      </Card>
      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.items.length ? (
          <EmptyState icon={<Boxes className="h-6 w-6" />} title="No stock movements" />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Product</TH>
                  <TH>Branch</TH>
                  <TH>Type</TH>
                  <TH className="text-right">Change</TH>
                  <TH>Source</TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((t) => (
                  <TR key={t.id}>
                    <TD className="text-slate-600">{fmtDateTime(t.createdAt)}</TD>
                    <TD>
                      <p className="font-medium text-slate-900">{t.product.name}</p>
                      <p className="text-xs text-slate-500">{t.product.sku}</p>
                    </TD>
                    <TD>{t.branchName}</TD>
                    <TD><Badge tone={t.quantity >= 0 ? 'green' : t.type === 'DAMAGE' ? 'red' : 'gray'}>{titleCase(t.type)}</Badge></TD>
                    <TD className={`text-right tabular-nums font-medium ${t.quantity >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {t.quantity > 0 ? '+' : ''}{qty(t.quantity, t.product.unit)}
                    </TD>
                    <TD className="text-xs text-slate-500">{[t.referenceType && titleCase(t.referenceType), t.notes].filter(Boolean).join(' · ') || '-'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
