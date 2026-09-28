'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Receipt, Search, ShoppingCart } from 'lucide-react';
import { Button, Card, EmptyState, Input, LoadingBlock, PageHeader, Pagination, Select, StatCard, StatusBadge, Table, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { fmtDateTime, money } from '@/lib/format';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  status: string;
  total: number;
  amountPaid: number;
  amountRefunded: number;
  balanceDue: number;
  createdAt: string;
  customer: { id: string; name: string; phone: string } | null;
  branch: { id: string; name: string };
  _count: { items: number };
}

const STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'REFUNDED', 'CANCELLED'];

export default function InvoicesPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <Invoices />
    </Suspense>
  );
}

function Invoices() {
  const router = useRouter();
  const params = useSearchParams();
  const user = useAuth((s) => s.user);
  const branchId = useBranch((s) => s.branchId);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState({ status: params.get('status') ?? '', from: '', to: '' });
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', debounced, filters, page, branchId],
    queryFn: () =>
      api.page<InvoiceRow>('/invoices', {
        search: debounced || undefined,
        status: filters.status === 'UNPAID' ? undefined : filters.status || undefined,
        unpaid: filters.status === 'UNPAID' ? 'true' : undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        branchId: branchId ?? undefined,
        page: String(page),
        pageSize: '25',
      }),
    placeholderData: keepPreviousData,
  });
  const summary = (data?.meta as { summary?: { total: number; paid: number; refunded: number } } | undefined)?.summary;
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Invoices"
        description="Every bill issued across your branches"
        actions={hasPermission(user, PERMISSIONS.POS_USE) && <Link href="/pos"><Button><ShoppingCart className="h-4 w-4" /> New sale</Button></Link>}
      />
      {summary && (
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label="Billed" value={money(summary.total)} hint={`${data?.meta.total ?? 0} invoices`} />
          <StatCard label="Collected" value={money(summary.paid)} />
          <StatCard label="Refunded" value={money(summary.refunded)} />
          <StatCard label="Outstanding" value={money(Math.max(0, summary.total - summary.paid))} />
        </div>
      )}
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-5">
          <div className="relative md:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input className="pl-9" placeholder="Invoice number, customer name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select value={filters.status} onChange={set('status')}>
            <option value="">All statuses</option>
            <option value="UNPAID">Unpaid / part-paid</option>
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
          <EmptyState icon={<Receipt className="h-6 w-6" />} title="No invoices found" description="Invoices appear here after checkout at the POS." />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Invoice</TH>
                  <TH>Customer</TH>
                  <TH>Date</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Total</TH>
                  <TH className="text-right">Paid</TH>
                  <TH className="text-right">Due</TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((i) => (
                  <TR key={i.id} className="cursor-pointer" onClick={() => router.push(`/invoices/${i.id}`)}>
                    <TD>
                      <p className="font-medium text-slate-900">{i.invoiceNumber}</p>
                      <p className="text-xs text-slate-500">{i.branch.name} · {i._count.items} item{i._count.items === 1 ? '' : 's'}</p>
                    </TD>
                    <TD>{i.customer ? <><p className="text-slate-900">{i.customer.name}</p><p className="text-xs text-slate-500">{i.customer.phone}</p></> : <span className="text-slate-400">Walk-in</span>}</TD>
                    <TD className="text-slate-600">{fmtDateTime(i.createdAt)}</TD>
                    <TD><StatusBadge status={i.status} /></TD>
                    <TD className="text-right tabular-nums font-medium">{money(i.total)}</TD>
                    <TD className="text-right tabular-nums">{money(i.amountPaid - i.amountRefunded)}</TD>
                    <TD className={`text-right tabular-nums ${i.balanceDue > 0 ? 'font-medium text-amber-700' : 'text-slate-400'}`}>{money(i.balanceDue)}</TD>
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
