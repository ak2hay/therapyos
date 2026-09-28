'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import { Card, EmptyState, Input, LoadingBlock, PageHeader, Pagination, Select, StatCard, StatusBadge, Table, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { api } from '@/lib/api';
import { useBranch } from '@/lib/branch-store';
import { PAYMENT_METHOD_LABEL, PaymentRow } from '@/lib/billing';
import { fmtDateTime, money } from '@/lib/format';

interface PaymentListRow extends PaymentRow {
  invoice: { id: string; invoiceNumber: string; customer: { id: string; name: string; phone: string } | null };
  branch: { id: string; name: string };
}
interface MethodSummary {
  method: string;
  collected: number;
  refunded: number;
  net: number;
}

const METHODS = ['CASH', 'UPI', 'CARD', 'RAZORPAY', 'BANK_TRANSFER', 'OTHER'];
const STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

export default function PaymentsPage() {
  const branchId = useBranch((s) => s.branchId);
  const [filters, setFilters] = useState({ method: '', status: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['payments', filters, page, branchId],
    queryFn: () =>
      api.page<PaymentListRow>('/payments', {
        method: filters.method || undefined,
        status: filters.status || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        branchId: branchId ?? undefined,
        page: String(page),
        pageSize: '25',
      }),
    placeholderData: keepPreviousData,
  });
  const summary = ((data?.meta as { summary?: MethodSummary[] } | undefined)?.summary ?? []).slice().sort((a, b) => b.net - a.net);
  const net = summary.reduce((s, m) => s + m.net, 0);
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Payments" description="Money received and refunded, by payment method" />
      {summary.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Net collected" value={money(net)} hint={`${data?.meta.total ?? 0} payments`} />
          {summary.slice(0, 3).map((m) => (
            <StatCard key={m.method} label={PAYMENT_METHOD_LABEL[m.method] ?? m.method} value={money(m.net)} hint={m.refunded ? `${money(m.refunded)} refunded` : undefined} />
          ))}
        </div>
      )}
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <Select value={filters.method} onChange={set('method')}>
            <option value="">All methods</option>
            {METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m] ?? m}</option>)}
          </Select>
          <Select value={filters.status} onChange={set('status')}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</option>)}
          </Select>
          <Input type="date" value={filters.from} onChange={set('from')} aria-label="From date" />
          <Input type="date" value={filters.to} onChange={set('to')} aria-label="To date" />
        </div>
      </Card>
      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.items.length ? (
          <EmptyState icon={<CreditCard className="h-6 w-6" />} title="No payments found" description="Payments recorded at checkout or against invoices show up here." />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Invoice</TH>
                  <TH>Customer</TH>
                  <TH>Method</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Amount</TH>
                  <TH className="text-right">Refunded</TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((p) => (
                  <TR key={p.id}>
                    <TD className="text-slate-600">{fmtDateTime(p.paidAt ?? p.createdAt)}</TD>
                    <TD>
                      <Link href={`/invoices/${p.invoice.id}`} className="font-medium text-brand-700 hover:underline">{p.invoice.invoiceNumber}</Link>
                      <p className="text-xs text-slate-500">{p.branch.name}</p>
                    </TD>
                    <TD>{p.invoice.customer?.name ?? <span className="text-slate-400">Walk-in</span>}</TD>
                    <TD>
                      {PAYMENT_METHOD_LABEL[p.method] ?? p.method}
                      {(p.reference || p.providerTransactionId) && <p className="text-xs text-slate-500">{p.reference ?? p.providerTransactionId}</p>}
                    </TD>
                    <TD><StatusBadge status={p.status} /></TD>
                    <TD className="text-right tabular-nums font-medium">{money(p.amount)}</TD>
                    <TD className="text-right tabular-nums text-rose-600">{p.refundedAmount ? money(p.refundedAmount) : '-'}</TD>
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
