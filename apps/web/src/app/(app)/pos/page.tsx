'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Crown, FileText, Minus, Package, PauseCircle, Plus, Printer, Receipt, Search, ShoppingBag, ShoppingCart, Sparkles, Tag, Trash2, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Input, LoadingBlock, Modal, PageHeader, Select, Spinner, Tabs, cn } from '@therapyos/ui';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasFeature, hasPermission, useAuth } from '@/lib/auth-store';
import { Cart, CartItem, DESK_METHODS, InvoiceDetail, openInvoicePdf, PAYMENT_METHOD_LABEL, QuoteLine } from '@/lib/billing';
import { money, num, titleCase } from '@/lib/format';
import { useBranches, useServices, useTherapists, useWorkingBranch } from '@/lib/queries';
import { CustomerHit, CustomerPicker } from '@/components/customer-picker';
import { CustomerFormModal } from '@/components/customer-form';
import { CollectOnlineButton } from '@/components/billing-actions';

interface PackageLite { id: string; name: string; price: number; validityDays: number; items: { serviceId: string; quantity: number; service: { name: string } }[]; savings: number }
interface PlanLite { id: string; name: string; price: number; durationDays: number; billingInterval: string; benefits: { type: string; value: number; quantity: number | null }[] }
interface EligiblePackage { id: string; package: { name: string }; expiresAt: string; items: { serviceId: string; totalQuantity: number; usedQuantity: number }[] }
interface ActiveMembership { id: string; plan: { name: string }; benefits: { benefitId: string; type: string; serviceId: string | null; remaining: number | null }[] }
interface OpenCart { id: string; customerName: string | null; itemCount: number; estimate: number; updatedAt: string; items: string[] }

interface ProductLite { id: string; name: string; sku: string; barcode: string | null; unit: string; sellingPrice: number; onHand: number; category: { name: string } | null }

type CatalogTab = 'services' | 'products' | 'packages' | 'memberships';

export default function PosPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <Pos />
    </Suspense>
  );
}

function Pos() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const { data: branches } = useBranches();
  const branchId = useWorkingBranch(branches);
  const cartId = params.get('cart');
  const [tab, setTab] = useState<CatalogTab>('services');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [newCustomer, setNewCustomer] = useState<{ name?: string; phone?: string } | null>(null);
  const [receipt, setReceipt] = useState<InvoiceDetail | null>(null);
  const [showHeld, setShowHeld] = useState(false);

  const canPackages = hasFeature(user, FeatureFlagKey.PACKAGES_ENABLED);
  const canMemberships = hasFeature(user, FeatureFlagKey.MEMBERSHIP_ENABLED);
  const canDiscount = hasPermission(user, PERMISSIONS.DISCOUNT_APPLY);

  const { data: cart, isLoading: cartLoading } = useQuery({
    queryKey: ['cart', cartId],
    queryFn: () => api.get<Cart>(`/carts/${cartId}`),
    enabled: !!cartId,
  });
  const { data: services } = useServices({ branchId, activeOnly: true });
  const { data: therapists } = useTherapists({ branchId, activeOnly: true });
  const { data: packages } = useQuery({ queryKey: ['packages', 'active'], queryFn: () => api.get<PackageLite[]>('/packages', { active: 'true' }), enabled: canPackages });
  const { data: plans } = useQuery({ queryKey: ['membership-plans', 'active'], queryFn: () => api.get<PlanLite[]>('/membership-plans', { active: 'true' }), enabled: canMemberships });
  const trackStock = hasFeature(user, FeatureFlagKey.INVENTORY_ENABLED);
  const { data: products } = useQuery({ queryKey: ['products', 'retail', branchId], queryFn: () => api.get<ProductLite[]>('/products', { retail: 'true', branchId: branchId ?? undefined }), enabled: !!branchId });
  const { data: held } = useQuery({ queryKey: ['carts-open', branchId], queryFn: () => api.get<OpenCart[]>('/carts', { branchId: branchId ?? undefined }), refetchInterval: 30_000 });
  const customerId = cart?.customerId ?? null;
  const { data: eligible } = useQuery({
    queryKey: ['eligible-packages', customerId],
    queryFn: () => api.get<EligiblePackage[]>('/customer-packages/eligible', { customerId: customerId! }),
    enabled: !!customerId && canPackages,
  });
  const { data: memberships } = useQuery({
    queryKey: ['active-memberships', customerId],
    queryFn: () => api.get<ActiveMembership[]>('/memberships/active', { customerId: customerId! }),
    enabled: !!customerId && canMemberships,
  });

  useEffect(() => {
    if (cart && cart.status !== 'OPEN') router.replace('/pos');
  }, [cart, router]);

  const presetCustomer = params.get('customer');
  const presetStarted = useRef(false);
  useEffect(() => {
    if (cartId || !presetCustomer || !branchId || presetStarted.current) return;
    presetStarted.current = true;
    api
      .post<Cart>('/carts', { branchId, customerId: presetCustomer })
      .then((c) => {
        qc.setQueryData(['cart', c.id], c);
        router.replace(`/pos?cart=${c.id}`);
      })
      .catch((e) => toast.error(errorMessage(e)));
  }, [cartId, presetCustomer, branchId, qc, router]);

  const setCart = (c: Cart) => {
    qc.setQueryData(['cart', c.id], c);
    if (c.id !== cartId) router.replace(`/pos?cart=${c.id}`);
  };

  const run = async (fn: () => Promise<Cart | void>) => {
    setBusy(true);
    try {
      const c = await fn();
      if (c) setCart(c);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const ensureCart = async (customer?: string): Promise<string> => {
    if (cart && cart.status === 'OPEN') return cart.id;
    if (!branchId) throw new Error('Select a branch first.');
    const c = await api.post<Cart>('/carts', { branchId, customerId: customer });
    setCart(c);
    return c.id;
  };

  const addItem = (body: Record<string, unknown>) =>
    run(async () => {
      const id = await ensureCart();
      return api.post<Cart>(`/carts/${id}/items`, body);
    });

  const selectCustomer = (c: CustomerHit | null) =>
    run(async () => {
      if (!c) return;
      if (!cart) {
        await ensureCart(c.id);
        return;
      }
      return api.patch<Cart>(`/carts/${cart.id}`, { customerId: c.id });
    });

  const filteredServices = useMemo(() => (services ?? []).filter((s) => s.name.toLowerCase().includes(search.toLowerCase())), [services, search]);
  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.barcode === search.trim());
  }, [products, search]);
  const priceAt = (s: { basePrice: number; branchServices?: { branchId: string; price: number | null }[] }) => s.branchServices?.find((b) => b.branchId === branchId)?.price ?? s.basePrice;

  const newSale = () => {
    setReceipt(null);
    router.replace('/pos');
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Point of Sale"
        description="Bill services and products, sell packages and memberships, and take payment"
        actions={
          <>
            <Button variant="outline" onClick={() => setShowHeld(true)}>
              <PauseCircle className="h-4 w-4" /> Held bills {held?.length ? <Badge tone="brand">{held.length}</Badge> : null}
            </Button>
            {cartId && (
              <Button variant="outline" onClick={newSale}>
                <Plus className="h-4 w-4" /> New sale
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_440px]">
        <Card className="flex min-h-[560px] flex-col">
          <div className="border-b border-slate-100 p-4 pb-0">
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input className="pl-9" placeholder="Search the catalogue" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'services', label: 'Services' },
                ...(products?.length ? [{ value: 'products' as const, label: 'Products' }] : []),
                ...(canPackages ? [{ value: 'packages' as const, label: 'Packages' }] : []),
                ...(canMemberships ? [{ value: 'memberships' as const, label: 'Memberships' }] : []),
              ]}
            />
          </div>
          <div className="grid flex-1 content-start gap-3 overflow-y-auto p-4 sm:grid-cols-2 lg:grid-cols-3">
            {tab === 'services' &&
              filteredServices.map((s) => (
                <button key={s.id} disabled={busy} onClick={() => addItem({ itemType: 'SERVICE', itemId: s.id, quantity: 1 })} className="group rounded-xl border border-slate-200 p-3 text-left transition hover:border-brand-400 hover:shadow-sm disabled:opacity-60">
                  <div className="flex items-start justify-between gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color ?? '#94a3b8' }} />
                    <Sparkles className="h-3.5 w-3.5 text-slate-300 group-hover:text-brand-500" />
                  </div>
                  <p className="mt-2 text-sm font-medium text-slate-900">{s.name}</p>
                  <p className="text-xs text-slate-500">{s.category?.name ?? 'Service'} · {s.durationMinutes} min</p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">{money(priceAt(s))}</p>
                </button>
              ))}
            {tab === 'products' &&
              filteredProducts.map((p) => {
                const out = trackStock && p.onHand <= 0;
                return (
                  <button key={p.id} disabled={busy || out} onClick={() => addItem({ itemType: 'PRODUCT', itemId: p.id, quantity: 1 })} className="rounded-xl border border-slate-200 p-3 text-left transition hover:border-brand-400 hover:shadow-sm disabled:opacity-60">
                    <div className="flex items-start justify-between gap-2">
                      <ShoppingBag className="h-4 w-4 text-brand-600" />
                      {trackStock && <Badge tone={out ? 'red' : p.onHand <= 3 ? 'amber' : 'gray'}>{out ? 'Out of stock' : `${num(p.onHand)} in stock`}</Badge>}
                    </div>
                    <p className="mt-2 text-sm font-medium text-slate-900">{p.name}</p>
                    <p className="text-xs text-slate-500">{p.category?.name ?? 'Product'} · {p.sku}</p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{money(p.sellingPrice)}</p>
                  </button>
                );
              })}
            {tab === 'products' && !filteredProducts.length && <p className="col-span-full py-10 text-center text-sm text-slate-500">No products match.</p>}
            {tab === 'packages' &&
              (packages ?? [])
                .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
                .map((p) => (
                  <button key={p.id} disabled={busy} onClick={() => (cart?.customerId ? addItem({ itemType: 'PACKAGE', itemId: p.id, quantity: 1 }) : toast.info('Select the customer first'))} className="rounded-xl border border-slate-200 p-3 text-left transition hover:border-brand-400 hover:shadow-sm disabled:opacity-60">
                    <Package className="h-4 w-4 text-brand-600" />
                    <p className="mt-2 text-sm font-medium text-slate-900">{p.name}</p>
                    <p className="text-xs text-slate-500">{p.items.map((i) => `${i.quantity}× ${i.service.name}`).join(', ')}</p>
                    <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
                      {money(p.price)} {p.savings > 0 && <Badge tone="green">Save {money(p.savings, undefined, true)}</Badge>}
                    </p>
                    <p className="text-[11px] text-slate-400">Valid {p.validityDays} days</p>
                  </button>
                ))}
            {tab === 'memberships' &&
              (plans ?? [])
                .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
                .map((p) => (
                  <button key={p.id} disabled={busy} onClick={() => (cart?.customerId ? addItem({ itemType: 'MEMBERSHIP', itemId: p.id, quantity: 1 }) : toast.info('Select the customer first'))} className="rounded-xl border border-slate-200 p-3 text-left transition hover:border-brand-400 hover:shadow-sm disabled:opacity-60">
                    <Crown className="h-4 w-4 text-amber-500" />
                    <p className="mt-2 text-sm font-medium text-slate-900">{p.name}</p>
                    <p className="text-xs text-slate-500">{titleCase(p.billingInterval)} · {p.durationDays} days</p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{money(p.price)}</p>
                  </button>
                ))}
            {tab === 'services' && !filteredServices.length && <p className="col-span-full py-10 text-center text-sm text-slate-500">No services match.</p>}
          </div>
        </Card>

        <CartPanel
          cart={cart ?? null}
          loading={!!cartId && cartLoading}
          busy={busy}
          canDiscount={canDiscount}
          therapists={therapists ?? []}
          eligible={eligible ?? []}
          memberships={memberships ?? []}
          run={run}
          onSelectCustomer={selectCustomer}
          onNewCustomer={setNewCustomer}
          onCheckedOut={(inv) => {
            setReceipt(inv);
            qc.invalidateQueries({ queryKey: ['carts-open'] });
            qc.invalidateQueries({ queryKey: ['invoices'] });
          }}
        />
      </div>

      {newCustomer && (
        <CustomerFormModal
          open
          seed={newCustomer}
          onClose={() => setNewCustomer(null)}
          onSaved={(c) => {
            setNewCustomer(null);
            selectCustomer({ id: c.id, name: c.name, phone: c.phone, customerCode: c.customerCode });
          }}
        />
      )}

      {showHeld && (
        <Modal open onClose={() => setShowHeld(false)} title="Held bills" description="Open bills at this branch that have not been checked out yet">
          {!held?.length ? (
            <EmptyState title="No held bills" />
          ) : (
            <div className="divide-y divide-slate-100">
              {held.map((h) => (
                <button
                  key={h.id}
                  className="flex w-full items-center justify-between px-1 py-3 text-left hover:bg-slate-50"
                  onClick={() => {
                    setShowHeld(false);
                    router.replace(`/pos?cart=${h.id}`);
                  }}
                >
                  <span>
                    <span className="block text-sm font-medium text-slate-900">{h.customerName ?? 'Walk-in'}</span>
                    <span className="block text-xs text-slate-500">{h.items.join(', ')}</span>
                  </span>
                  <span className="text-sm font-semibold tabular-nums">{money(h.estimate)}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}

      {receipt && <ReceiptModal invoice={receipt} onUpdate={setReceipt} onNewSale={newSale} onOpen={() => router.push(`/invoices/${receipt.id}`)} />}
    </div>
  );
}

function CartPanel({
  cart,
  loading,
  busy,
  canDiscount,
  therapists,
  eligible,
  memberships,
  run,
  onSelectCustomer,
  onNewCustomer,
  onCheckedOut,
}: {
  cart: Cart | null;
  loading: boolean;
  busy: boolean;
  canDiscount: boolean;
  therapists: { id: string; name: string }[];
  eligible: EligiblePackage[];
  memberships: ActiveMembership[];
  run: (fn: () => Promise<Cart | void>) => Promise<void>;
  onSelectCustomer: (c: CustomerHit | null) => void;
  onNewCustomer: (seed: { name?: string; phone?: string }) => void;
  onCheckedOut: (inv: InvoiceDetail) => void;
}) {
  const [coupon, setCoupon] = useState('');
  const [payments, setPayments] = useState<{ method: string; amount: string; reference: string }[]>([{ method: 'CASH', amount: '', reference: '' }]);
  const [checkingOut, setCheckingOut] = useState(false);
  const total = cart?.quote.total ?? 0;

  useEffect(() => {
    setPayments((p) => (p.length === 1 ? [{ ...p[0], amount: total ? String(total) : '' }] : p));
  }, [total]);

  if (loading) return <Card><LoadingBlock /></Card>;
  const quote = cart?.quote;
  const lineFor = (item: CartItem) => quote?.lines.find((l) => l.key === item.id);
  const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const remaining = Math.round((total - paid) * 100) / 100;

  const checkout = async (withPayments: boolean) => {
    if (!cart) return;
    setCheckingOut(true);
    try {
      const inv = await api.post<InvoiceDetail>(`/carts/${cart.id}/checkout`, {
        payments: withPayments ? payments.filter((p) => Number(p.amount) > 0).map((p) => ({ method: p.method, amount: Number(p.amount), reference: p.reference || undefined })) : [],
      });
      setPayments([{ method: 'CASH', amount: '', reference: '' }]);
      setCoupon('');
      onCheckedOut(inv);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCheckingOut(false);
    }
  };

  return (
    <Card className="flex flex-col">
      <div className="border-b border-slate-100 p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Customer</p>
        <CustomerPicker
          value={cart?.customer ? { id: cart.customer.id, name: cart.customer.name, phone: cart.customer.phone, customerCode: cart.customer.customerCode, metrics: cart.customer.metrics ? { ...cart.customer.metrics, lastVisitAt: null } : null } : null}
          onChange={(c) => {
            if (c || !cart?.customer) onSelectCustomer(c);
            else toast.info('Start a new sale to bill a different customer.');
          }}
          allowNew
          onNew={onNewCustomer}
        />
        {!cart?.customer && <p className="mt-1.5 text-xs text-slate-400">Optional for walk-in retail; required for packages, memberships and loyalty.</p>}
      </div>

      <div className="flex-1 divide-y divide-slate-100 overflow-y-auto">
        {!cart?.items.length ? (
          <EmptyState icon={<ShoppingCart className="h-6 w-6" />} title="Bill is empty" description="Pick services, packages or memberships from the catalogue." />
        ) : (
          cart.items.map((item) => (
            <CartLine
              key={item.id}
              cart={cart}
              item={item}
              line={lineFor(item)}
              busy={busy}
              canDiscount={canDiscount}
              therapists={therapists}
              eligible={eligible}
              memberships={memberships}
              run={run}
            />
          ))
        )}
      </div>

      {cart && cart.items.length > 0 && quote && (
        <div className="space-y-3 border-t border-slate-100 p-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Tag className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input className="pl-9 uppercase" placeholder={cart.couponCode ?? 'Coupon code'} value={coupon} onChange={(e) => setCoupon(e.target.value)} disabled={!!cart.couponCode} />
            </div>
            {cart.couponCode ? (
              <Button variant="outline" onClick={() => run(() => api.patch<Cart>(`/carts/${cart.id}`, { couponCode: null }))}>
                <X className="h-4 w-4" /> {cart.couponCode}
              </Button>
            ) : (
              <Button variant="outline" disabled={!coupon.trim() || busy} onClick={() => run(async () => { const c = await api.patch<Cart>(`/carts/${cart.id}`, { couponCode: coupon.trim() }); setCoupon(''); return c; })}>
                Apply
              </Button>
            )}
          </div>
          {quote.couponError && <p className="text-xs text-rose-600">{quote.couponError}</p>}

          <dl className="space-y-1 text-sm">
            <Row label="Subtotal" value={money(quote.subtotal)} />
            {quote.breakdown.covered > 0 && <Row label="Prepaid (package / membership)" value={`-${money(quote.breakdown.covered)}`} tone="text-emerald-700" />}
            {quote.breakdown.membership > 0 && <Row label="Member discount" value={`-${money(quote.breakdown.membership)}`} tone="text-emerald-700" />}
            {quote.appliedOffers.map((o) => <Row key={o.offerId} label={`Offer: ${o.name}`} value={`-${money(o.amount)}`} tone="text-emerald-700" />)}
            {quote.coupon && <Row label={`Coupon ${quote.coupon.code}`} value={`-${money(quote.coupon.amount)}`} tone="text-emerald-700" />}
            {quote.breakdown.manual > 0 && <Row label="Manual discount" value={`-${money(quote.breakdown.manual)}`} tone="text-emerald-700" />}
            <Row label={quote.taxMode === 'INCLUSIVE' ? 'Tax (included)' : 'Tax'} value={money(quote.tax)} />
            {quote.rounding !== 0 && <Row label="Rounding" value={money(quote.rounding)} />}
            <div className="flex items-center justify-between border-t border-dashed border-slate-200 pt-2 text-base font-semibold text-slate-900">
              <span>Total</span>
              <span className="tabular-nums">{money(quote.total)}</span>
            </div>
          </dl>

          {total > 0 && (
            <div className="space-y-2 rounded-lg bg-slate-50 p-3">
              {payments.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <Select className="w-32" value={p.method} onChange={(e) => setPayments((ps) => ps.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))}>
                    {DESK_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
                  </Select>
                  <Input type="number" min={0} step="0.01" value={p.amount} onChange={(e) => setPayments((ps) => ps.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                  {p.method !== 'CASH' && <Input placeholder="Ref" className="w-24" value={p.reference} onChange={(e) => setPayments((ps) => ps.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} />}
                  {payments.length > 1 && (
                    <Button variant="ghost" size="icon" onClick={() => setPayments((ps) => ps.filter((_, j) => j !== i))} aria-label="Remove payment">
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
              <div className="flex items-center justify-between text-xs">
                <button className="font-medium text-brand-700 hover:underline" onClick={() => setPayments((ps) => [...ps, { method: 'UPI', amount: remaining > 0 ? String(remaining) : '', reference: '' }])}>
                  + Split payment
                </button>
                <span className={cn('tabular-nums', remaining < 0 ? 'text-rose-600' : 'text-slate-500')}>{remaining > 0 ? `${money(remaining)} will stay due` : remaining < 0 ? `${money(-remaining)} over the total` : 'Fully paid'}</span>
              </div>
            </div>
          )}

          {quote.warnings.length > 0 && <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">{quote.warnings.map((w) => <p key={w}>{w}</p>)}</div>}

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => checkout(false)} loading={checkingOut} disabled={busy}>
              <FileText className="h-4 w-4" /> Bill, pay later
            </Button>
            <Button onClick={() => checkout(true)} loading={checkingOut} disabled={busy || remaining < 0}>
              <Receipt className="h-4 w-4" /> {total > 0 ? `Charge ${money(paid || total)}` : 'Complete'}
            </Button>
          </div>
          <button className="w-full text-center text-xs text-slate-400 hover:text-rose-600" onClick={() => run(async () => { await api.post(`/carts/${cart.id}/abandon`); window.location.assign('/pos'); })}>
            Discard this bill
          </button>
        </div>
      )}
      {busy && <div className="pointer-events-none absolute right-6 top-6"><Spinner className="h-4 w-4 text-brand-600" /></div>}
    </Card>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={cn('flex items-center justify-between text-slate-600', tone)}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function CartLine({
  cart,
  item,
  line,
  busy,
  canDiscount,
  therapists,
  eligible,
  memberships,
  run,
}: {
  cart: Cart;
  item: CartItem;
  line?: QuoteLine;
  busy: boolean;
  canDiscount: boolean;
  therapists: { id: string; name: string }[];
  eligible: EligiblePackage[];
  memberships: ActiveMembership[];
  run: (fn: () => Promise<Cart | void>) => Promise<void>;
}) {
  const [discount, setDiscount] = useState<string | null>(null);
  const patch = (body: Record<string, unknown>) => run(() => api.patch<Cart>(`/carts/${cart.id}/items/${item.id}`, body));
  const fixedQty = item.itemType === 'PACKAGE' || item.itemType === 'MEMBERSHIP' || !!item.sessionId;
  const packageOptions = item.itemType === 'SERVICE' ? eligible.filter((p) => p.items.some((i) => i.serviceId === item.itemId && i.totalQuantity > i.usedQuantity) || p.id === item.customerPackageId) : [];
  const membershipOptions = item.itemType === 'SERVICE' ? memberships.filter((m) => m.benefits.some((b) => b.type === 'INCLUDED_SESSIONS' && (!b.serviceId || b.serviceId === item.itemId) && ((b.remaining ?? 0) > 0 || m.id === item.customerMembershipId))) : [];
  const coverValue = item.customerPackageId ? `pkg:${item.customerPackageId}` : item.customerMembershipId ? `mem:${item.customerMembershipId}` : '';
  const discounts = line ? line.membershipDiscount + line.offerDiscount + line.couponDiscount + line.manualDiscountAmount : 0;

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-900">
            {item.name} {item.itemType !== 'SERVICE' && <Badge tone={item.itemType === 'MEMBERSHIP' ? 'amber' : 'brand'} className="ml-1">{titleCase(item.itemType)}</Badge>}
            {item.sessionId && <Badge tone="blue" className="ml-1">Session</Badge>}
          </p>
          <p className="text-xs text-slate-500">
            {money(item.unitPrice)} each{line && line.taxRate ? ` · GST ${line.taxRate}%` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold tabular-nums text-slate-900">{money(line?.total ?? item.unitPrice * item.quantity)}</p>
          {line && line.total < line.gross && <p className="text-[11px] text-slate-400 line-through tabular-nums">{money(line.gross)}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!fixedQty && (
          <div className="flex items-center rounded-lg border border-slate-200">
            <button className="p-1.5 text-slate-500 hover:text-slate-900 disabled:opacity-40" disabled={busy || item.quantity <= 1} onClick={() => patch({ quantity: item.quantity - 1 })} aria-label="Decrease">
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-7 text-center text-sm tabular-nums">{item.quantity}</span>
            <button className="p-1.5 text-slate-500 hover:text-slate-900 disabled:opacity-40" disabled={busy} onClick={() => patch({ quantity: item.quantity + 1 })} aria-label="Increase">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {item.itemType === 'SERVICE' && (
          <Select className="h-8 w-36 text-xs" value={item.therapistId ?? ''} onChange={(e) => patch({ therapistId: e.target.value || null })} disabled={busy}>
            <option value="">No therapist</option>
            {therapists.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        )}
        {(packageOptions.length > 0 || membershipOptions.length > 0 || coverValue) && (
          <Select
            className="h-8 w-44 text-xs"
            value={coverValue}
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              patch({ customerPackageId: v.startsWith('pkg:') ? v.slice(4) : null, customerMembershipId: v.startsWith('mem:') ? v.slice(4) : null });
            }}
          >
            <option value="">Pay normally</option>
            {packageOptions.map((p) => <option key={p.id} value={`pkg:${p.id}`}>Use {p.package.name}</option>)}
            {membershipOptions.map((m) => <option key={m.id} value={`mem:${m.id}`}>Use {m.plan.name}</option>)}
          </Select>
        )}
        {canDiscount && !line?.coverage && (discount === null ? (
          <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setDiscount(String(item.manualDiscount || ''))}>
            {item.manualDiscount ? `Discount ${money(item.manualDiscount)}` : 'Discount'}
          </button>
        ) : (
          <span className="flex items-center gap-1">
            <Input className="h-8 w-24 text-xs" type="number" min={0} autoFocus value={discount} onChange={(e) => setDiscount(e.target.value)} />
            <Button size="sm" variant="outline" onClick={() => { patch({ manualDiscount: Number(discount) || 0 }); setDiscount(null); }}>OK</Button>
          </span>
        ))}
        {!item.sessionId && (
          <button className="ml-auto rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" disabled={busy} onClick={() => run(() => api.delete<Cart>(`/carts/${cart.id}/items/${item.id}`))} aria-label="Remove">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      {line?.coverage && <p className="text-xs font-medium text-emerald-700">Covered by {line.coverage.label}</p>}
      {discounts > 0 && (
        <p className="text-xs text-emerald-700">
          {[line!.membershipDiscount && `member -${money(line!.membershipDiscount)}`, line!.offerDiscount && `offer -${money(line!.offerDiscount)}`, line!.couponDiscount && `coupon -${money(line!.couponDiscount)}`, line!.manualDiscountAmount && `manual -${money(line!.manualDiscountAmount)}`].filter(Boolean).join(' · ')}
        </p>
      )}
      {line?.warning && <p className="text-xs text-amber-700">{line.warning}</p>}
    </div>
  );
}

function ReceiptModal({ invoice, onUpdate, onNewSale, onOpen }: { invoice: InvoiceDetail; onUpdate: (inv: InvoiceDetail) => void; onNewSale: () => void; onOpen: () => void }) {
  return (
    <Modal
      open
      onClose={onNewSale}
      title={`Invoice ${invoice.invoiceNumber}`}
      description={invoice.customer?.name ?? 'Walk-in customer'}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onOpen}>View invoice</Button>
          <Button onClick={onNewSale}><Plus className="h-4 w-4" /> New sale</Button>
        </>
      }
    >
      <div className="space-y-4 text-center">
        <div>
          <p className="text-3xl font-semibold tabular-nums text-slate-900">{money(invoice.total)}</p>
          <Badge tone={invoice.status === 'PAID' ? 'green' : 'amber'} className="mt-2">{invoice.status === 'PAID' ? 'Paid in full' : `${money(invoice.balanceDue)} due`}</Badge>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={() => openInvoicePdf(invoice.id).catch((e) => toast.error(errorMessage(e)))}>
            <Printer className="h-4 w-4" /> Print / PDF
          </Button>
          {invoice.balanceDue > 0 && <CollectOnlineButton invoice={invoice} onDone={onUpdate} />}
        </div>
      </div>
    </Modal>
  );
}
