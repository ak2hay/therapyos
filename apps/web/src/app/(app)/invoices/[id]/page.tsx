'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Ban, Download, Printer, Wallet } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Field, LoadingBlock, Modal, PageHeader, StatusBadge, Table, TBody, TD, TH, THead, TR, Textarea } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { InvoiceDetail, openInvoicePdf, PAYMENT_METHOD_LABEL, PaymentRow } from '@/lib/billing';
import { fmtDateTime, money, titleCase } from '@/lib/format';
import { CollectOnlineButton, RecordPaymentModal, RefundModal } from '@/components/billing-actions';

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const { data: inv, isLoading } = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<InvoiceDetail>(`/invoices/${id}`) });
  const [paying, setPaying] = useState(false);
  const [refunding, setRefunding] = useState<PaymentRow | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  if (isLoading || !inv) return <LoadingBlock />;
  const update = (next: InvoiceDetail) => {
    qc.setQueryData(['invoice', id], next);
    qc.invalidateQueries({ queryKey: ['invoices'] });
    setPaying(false);
    setRefunding(null);
  };
  const payable = inv.status === 'ISSUED' || inv.status === 'PARTIALLY_PAID';
  const canPay = hasPermission(user, PERMISSIONS.PAYMENT_CREATE) && payable;
  const canRefund = hasPermission(user, PERMISSIONS.PAYMENT_REFUND);
  const canVoid = hasPermission(user, PERMISSIONS.INVOICE_VOID) && inv.status !== 'CANCELLED' && inv.amountPaid - inv.amountRefunded <= 0;

  const doVoid = async () => {
    setBusy(true);
    try {
      update(await api.post<InvoiceDetail>(`/invoices/${id}/void`, { reason }));
      setVoiding(false);
      toast.success('Invoice voided');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Link href="/invoices" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Invoices
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {inv.invoiceNumber} <StatusBadge status={inv.status} />
          </span>
        }
        description={`${inv.branch.name} · issued ${fmtDateTime(inv.issuedAt ?? inv.createdAt)}${inv.paidAt ? ` · paid ${fmtDateTime(inv.paidAt)}` : ''}`}
        actions={
          <>
            <Button variant="outline" onClick={() => openInvoicePdf(inv.id).catch((e) => toast.error(errorMessage(e)))}>
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button variant="outline" onClick={() => downloadFile(`/invoices/${inv.id}/pdf`, { download: '1' }).catch((e) => toast.error(errorMessage(e)))}>
              <Download className="h-4 w-4" /> PDF
            </Button>
            {canPay && <CollectOnlineButton invoice={inv} onDone={update} />}
            {canPay && (
              <Button onClick={() => setPaying(true)}>
                <Wallet className="h-4 w-4" /> Record payment
              </Button>
            )}
            {canVoid && (
              <Button variant="danger" onClick={() => setVoiding(true)}>
                <Ban className="h-4 w-4" /> Void
              </Button>
            )}
          </>
        }
      />

      {inv.status === 'CANCELLED' && inv.cancelReason && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">Voided: {inv.cancelReason}</div>}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Items" description={inv.customer ? `Billed to ${inv.customer.name} (${inv.customer.customerCode})` : 'Walk-in customer'} actions={inv.customer && <Link href={`/customers/${inv.customer.id}`} className="text-xs font-medium text-brand-700 hover:underline">Customer profile</Link>} />
          <Table>
            <THead>
              <TR>
                <TH>Item</TH>
                <TH className="text-right">Qty</TH>
                <TH className="text-right">Rate</TH>
                <TH className="text-right">Discount</TH>
                <TH className="text-right">Tax</TH>
                <TH className="text-right">Amount</TH>
              </TR>
            </THead>
            <TBody>
              {inv.items.map((i) => (
                <TR key={i.id}>
                  <TD>
                    <p className="font-medium text-slate-900">{i.description}</p>
                    <p className="text-xs text-slate-500">
                      {titleCase(i.itemType)}
                      {i.meta?.coverageLabel && <span className="ml-1 text-emerald-700">· covered by {i.meta.coverageLabel}</span>}
                    </p>
                  </TD>
                  <TD className="text-right tabular-nums">{i.quantity}</TD>
                  <TD className="text-right tabular-nums">{money(i.unitPrice)}</TD>
                  <TD className="text-right tabular-nums text-emerald-700">{i.discount ? `-${money(i.discount)}` : '-'}</TD>
                  <TD className="text-right tabular-nums text-slate-500">{money(i.tax)} <span className="text-[11px]">({i.taxRate}%)</span></TD>
                  <TD className="text-right tabular-nums font-medium">{money(i.total)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {inv.notes && <p className="border-t border-slate-100 px-5 py-3 text-sm text-slate-600">{inv.notes}</p>}
        </Card>

        <Card>
          <CardHeader title="Summary" />
          <dl className="space-y-1.5 p-5 text-sm">
            <Line label="Subtotal" value={money(inv.subtotal)} />
            {inv.appliedOffers.map((o) => <Line key={o.offerId} label={`Offer: ${o.name}`} value={`-${money(o.amount)}`} />)}
            {inv.couponCode && <Line label={`Coupon ${inv.couponCode}`} value="applied" />}
            <Line label="Total discounts" value={`-${money(inv.discount)}`} />
            <Line label="Tax" value={money(inv.tax)} />
            {inv.rounding !== 0 && <Line label="Rounding" value={money(inv.rounding)} />}
            <div className="flex justify-between border-t border-dashed border-slate-200 pt-2 text-base font-semibold text-slate-900">
              <span>Total</span>
              <span className="tabular-nums">{money(inv.total)}</span>
            </div>
            <Line label="Paid" value={money(inv.amountPaid)} />
            {inv.amountRefunded > 0 && <Line label="Refunded" value={`-${money(inv.amountRefunded)}`} />}
            <div className="flex justify-between font-medium text-amber-700">
              <span>Balance due</span>
              <span className="tabular-nums">{money(inv.balanceDue)}</span>
            </div>
          </dl>
        </Card>
      </div>

      <Card>
        <CardHeader title="Payments" description={inv.payments.length ? undefined : 'No payments recorded yet'} />
        {inv.payments.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Method</TH>
                <TH>Reference</TH>
                <TH>Status</TH>
                <TH className="text-right">Amount</TH>
                <TH className="text-right">Refunded</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {inv.payments.map((p) => (
                <TR key={p.id}>
                  <TD className="text-slate-600">{fmtDateTime(p.paidAt ?? p.createdAt)}</TD>
                  <TD>{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</TD>
                  <TD className="text-xs text-slate-500">{p.reference ?? p.providerTransactionId ?? p.providerOrderId ?? '-'}</TD>
                  <TD><StatusBadge status={p.status} /></TD>
                  <TD className="text-right tabular-nums">{money(p.amount)}</TD>
                  <TD className="text-right tabular-nums text-rose-600">{p.refundedAmount ? money(p.refundedAmount) : '-'}</TD>
                  <TD className="text-right">
                    {canRefund && ['SUCCESS', 'PARTIALLY_REFUNDED'].includes(p.status) && p.amount > p.refundedAmount && (
                      <Button size="sm" variant="outline" onClick={() => setRefunding(p)}>Refund</Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {inv.refunds.length > 0 && (
          <div className="border-t border-slate-100 px-5 py-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Refunds</p>
            {inv.refunds.map((r) => (
              <p key={r.id} className="text-sm text-slate-600">
                {fmtDateTime(r.createdAt)} · <span className="font-medium text-rose-600">{money(r.amount)}</span> · {r.reason} <Badge className="ml-1">{titleCase(r.status)}</Badge>
              </p>
            ))}
          </div>
        )}
      </Card>

      {paying && <RecordPaymentModal invoice={inv} onClose={() => setPaying(false)} onDone={update} />}
      {refunding && <RefundModal invoice={inv} payment={refunding} onClose={() => setRefunding(null)} onDone={update} />}
      {voiding && (
        <Modal
          open
          onClose={() => setVoiding(false)}
          title={`Void ${inv.invoiceNumber}?`}
          description="Voiding cancels the bill, releases any coupon use and restores package sessions it consumed."
          size="sm"
          footer={
            <>
              <Button variant="outline" onClick={() => setVoiding(false)}>Keep invoice</Button>
              <Button variant="danger" onClick={doVoid} loading={busy} disabled={reason.trim().length < 3}>Void invoice</Button>
            </>
          }
        >
          <Field label="Reason">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Duplicate bill" />
          </Field>
        </Modal>
      )}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-slate-600">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
