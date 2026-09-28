'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Globe } from 'lucide-react';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea } from '@therapyos/ui';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { collectOnline, DESK_METHODS, InvoiceDetail, PAYMENT_METHOD_LABEL, PaymentRow } from '@/lib/billing';
import { money } from '@/lib/format';
import { useBranches, useWorkingBranch } from '@/lib/queries';
import { CustomerHit, CustomerPicker } from './customer-picker';

/**
 * Sells a package or membership straight to a customer: the API issues an unpaid invoice and the
 * user is taken to it to collect payment (the product only activates once the invoice is paid).
 */
export function SellModal({
  kind,
  options,
  defaultItemId,
  customer: initialCustomer,
  onClose,
}: {
  kind: 'PACKAGE' | 'MEMBERSHIP';
  options: { id: string; name: string; price: number }[];
  defaultItemId?: string;
  customer?: CustomerHit | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { data: branches } = useBranches();
  const working = useWorkingBranch(branches);
  const [branchId, setBranchId] = useState<string>('');
  const [customer, setCustomer] = useState<CustomerHit | null>(initialCustomer ?? null);
  const [itemId, setItemId] = useState(defaultItemId ?? options[0]?.id ?? '');
  const [autoRenew, setAutoRenew] = useState(false);
  const [busy, setBusy] = useState(false);
  const branch = branchId || working || '';

  const submit = async () => {
    setBusy(true);
    try {
      const inv =
        kind === 'PACKAGE'
          ? await api.post<InvoiceDetail>('/customer-packages/sell', { customerId: customer!.id, packageId: itemId, branchId: branch })
          : await api.post<InvoiceDetail>('/memberships/sell', { customerId: customer!.id, membershipPlanId: itemId, branchId: branch, autoRenew });
      toast.success(`Invoice ${inv.invoiceNumber} created. Collect payment to activate.`);
      router.push(`/invoices/${inv.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'PACKAGE' ? 'Sell package' : 'Sell membership'}
      description="An invoice is raised for the customer. It activates as soon as the invoice is fully paid."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!customer || !itemId || !branch}>Create invoice</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Customer">
          <CustomerPicker value={customer} onChange={setCustomer} autoFocus={!customer} />
        </Field>
        <Field label={kind === 'PACKAGE' ? 'Package' : 'Plan'}>
          <Select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · {money(o.price)}
              </option>
            ))}
          </Select>
        </Field>
        {(branches?.length ?? 0) > 1 && (
          <Field label="Branch">
            <Select value={branch} onChange={(e) => setBranchId(e.target.value)}>
              {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        )}
        {kind === 'MEMBERSHIP' && <Checkbox label="Renew automatically when it expires" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />}
      </div>
    </Modal>
  );
}

export function RecordPaymentModal({ invoice, onClose, onDone }: { invoice: InvoiceDetail; onClose: () => void; onDone: (inv: InvoiceDetail) => void }) {
  const [method, setMethod] = useState<string>('CASH');
  const [amount, setAmount] = useState(String(invoice.balanceDue));
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    setSaving(true);
    setErrors({});
    try {
      const inv = await api.post<InvoiceDetail>(`/invoices/${invoice.id}/payments`, { method, amount: Number(amount), reference: reference || undefined });
      toast.success(`${money(Number(amount))} received`);
      onDone(inv);
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Record payment"
      description={`${invoice.invoiceNumber} · balance due ${money(invoice.balanceDue)}`}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={saving} disabled={!Number(amount)}>Record {Number(amount) ? money(Number(amount)) : ''}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          {DESK_METHODS.slice(0, 3).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className={`rounded-lg border px-3 py-2 text-sm font-medium ${method === m ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            >
              {PAYMENT_METHOD_LABEL[m]}
            </button>
          ))}
        </div>
        <Field label="Other method">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {DESK_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
          </Select>
        </Field>
        <Field label="Amount" error={errors.amount}>
          <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {method !== 'CASH' && (
          <Field label="Reference" hint="UPI transaction id, card slip number, etc.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** "Collect online" button: opens the gateway (or the mock confirmation in development). */
export function CollectOnlineButton({ invoice, onDone, size = 'md' }: { invoice: InvoiceDetail; onDone: (inv: InvoiceDetail) => void; size?: 'sm' | 'md' }) {
  const [busy, setBusy] = useState(false);
  const [mock, setMock] = useState<{ amount: number; resolve: (ok: boolean) => void } | null>(null);

  const start = async () => {
    setBusy(true);
    try {
      const inv = await collectOnline(invoice.id, undefined, (order) => new Promise<boolean>((resolve) => setMock({ amount: order.amount, resolve })));
      if (inv) {
        toast.success('Online payment received');
        onDone(inv);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      setMock(null);
    }
  };

  return (
    <>
      <Button variant="outline" size={size} onClick={start} loading={busy && !mock}>
        <Globe className="h-4 w-4" /> Collect online
      </Button>
      {mock && (
        <Modal
          open
          onClose={() => mock.resolve(false)}
          title="Test payment gateway"
          description="The mock gateway is active (no real money moves). Simulate the customer completing payment."
          size="sm"
          footer={
            <>
              <Button variant="outline" onClick={() => mock.resolve(false)}>Customer cancelled</Button>
              <Button variant="success" onClick={() => mock.resolve(true)}>Simulate successful payment</Button>
            </>
          }
        >
          <p className="text-sm text-slate-600">
            Amount: <span className="font-semibold text-slate-900">{money(mock.amount)}</span> for {invoice.invoiceNumber}
          </p>
        </Modal>
      )}
    </>
  );
}

export function RefundModal({ invoice, payment, onClose, onDone }: { invoice: InvoiceDetail; payment: PaymentRow; onClose: () => void; onDone: (inv: InvoiceDetail) => void }) {
  const refundable = Math.max(0, payment.amount - payment.refundedAmount);
  const [amount, setAmount] = useState(String(refundable));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    setSaving(true);
    setErrors({});
    try {
      const inv = await api.post<InvoiceDetail>('/payments/refunds', { paymentId: payment.id, amount: Number(amount), reason });
      toast.success(`Refunded ${money(Number(amount))}`);
      onDone(inv);
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Refund payment"
      description={`${PAYMENT_METHOD_LABEL[payment.method] ?? payment.method} payment of ${money(payment.amount)} on ${invoice.invoiceNumber}`}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={submit} loading={saving} disabled={!Number(amount) || reason.trim().length < 3}>Refund {Number(amount) ? money(Number(amount)) : ''}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Amount" hint={`Up to ${money(refundable)} can be refunded`} error={errors.amount}>
          <Input type="number" min={0} max={refundable} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason" error={errors.reason}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being refunded?" />
        </Field>
        {payment.method === 'RAZORPAY' ? (
          <p className="text-xs text-slate-500">The refund is sent back to the customer&apos;s original payment method through the gateway.</p>
        ) : (
          <p className="text-xs text-slate-500">Hand the amount back to the customer by {PAYMENT_METHOD_LABEL[payment.method] ?? payment.method}; it is recorded in the books as a sales return.</p>
        )}
      </div>
    </Modal>
  );
}
