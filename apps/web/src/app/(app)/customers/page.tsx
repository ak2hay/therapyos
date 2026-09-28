'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Plus, Search, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Input, LoadingBlock, PageHeader, Pagination, Select, StatusBadge, Table, TBody, TD, TH, THead, TR } from '@therapyos/ui';
import { CUSTOMER_SOURCES, PERMISSIONS } from '@therapyos/types';
import { api } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { ago, money, titleCase } from '@/lib/format';
import { CustomerFormModal } from '@/components/customer-form';
import { SEGMENT_TONE } from '@/components/customer-picker';

interface CustomerRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  customerCode: string;
  source: string;
  status: string;
  tags: string[];
  createdAt: string;
  metrics: { segment: string; visitCount: number; lastVisitAt: string | null; totalSpend: number; noShowCount: number } | null;
}

const SEGMENTS = ['NEW', 'ACTIVE', 'LOYAL', 'VIP', 'AT_RISK', 'INACTIVE', 'CHURNED'];

export default function CustomersPage() {
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const branchId = useBranch((s) => s.branchId);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState({ segment: '', source: '', status: '', sort: 'createdAt', order: 'desc' });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ['customers', debounced, filters, page, branchId],
    queryFn: () =>
      api.page<CustomerRow>('/customers', {
        search: debounced || undefined,
        segment: filters.segment || undefined,
        source: filters.source || undefined,
        status: filters.status || undefined,
        sort: filters.sort,
        order: filters.order,
        branchId: branchId ?? undefined,
        page: String(page),
        pageSize: '25',
      }),
    placeholderData: keepPreviousData,
  });

  const setFilter = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Customers"
        description={data ? `${data.meta.total} customers${branchId ? ' at this branch' : ''}` : 'Your client base'}
        actions={hasPermission(user, PERMISSIONS.CUSTOMER_CREATE) && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add customer</Button>}
      />

      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-6">
          <div className="relative md:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input className="pl-9" placeholder="Name, phone, email or code" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select value={filters.segment} onChange={setFilter('segment')}>
            <option value="">All segments</option>
            {SEGMENTS.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
          <Select value={filters.source} onChange={setFilter('source')}>
            <option value="">All sources</option>
            {CUSTOMER_SOURCES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
          <Select value={filters.status} onChange={setFilter('status')}>
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="BLOCKED">Blocked</option>
          </Select>
          <Select
            value={`${filters.sort}:${filters.order}`}
            onChange={(e) => {
              const [sort, order] = e.target.value.split(':');
              setFilters((f) => ({ ...f, sort, order }));
            }}
          >
            <option value="createdAt:desc">Newest first</option>
            <option value="name:asc">Name A-Z</option>
            <option value="lastVisit:desc">Recently visited</option>
            <option value="lastVisit:asc">Longest since visit</option>
            <option value="spend:desc">Top spenders</option>
          </Select>
        </div>
      </Card>

      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.items.length ? (
          <EmptyState icon={<Users className="h-6 w-6" />} title="No customers found" description={debounced ? 'Try a different search.' : 'Customers appear here once they visit or book.'} />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Customer</TH>
                  <TH>Phone</TH>
                  <TH>Segment</TH>
                  <TH className="text-right">Visits</TH>
                  <TH>Last visit</TH>
                  <TH className="text-right">Total spend</TH>
                  <TH>Source</TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((c) => (
                  <TR key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => router.push(`/customers/${c.id}`)}>
                    <TD>
                      <p className="font-medium text-slate-900">{c.name}</p>
                      <p className="text-xs text-slate-500">
                        {c.customerCode}
                        {c.status !== 'ACTIVE' && <StatusBadge status={c.status} className="ml-2" />}
                        {c.tags.slice(0, 2).map((t) => <Badge key={t} className="ml-1">{t}</Badge>)}
                      </p>
                    </TD>
                    <TD className="text-slate-600">{c.phone}</TD>
                    <TD>{c.metrics && <Badge tone={SEGMENT_TONE[c.metrics.segment] ?? 'gray'}>{titleCase(c.metrics.segment)}</Badge>}</TD>
                    <TD className="text-right tabular-nums">{c.metrics?.visitCount ?? 0}</TD>
                    <TD className="text-slate-600">{c.metrics?.lastVisitAt ? ago(c.metrics.lastVisitAt) : 'Never'}</TD>
                    <TD className="text-right tabular-nums">{money(c.metrics?.totalSpend ?? 0)}</TD>
                    <TD className="text-slate-600">{titleCase(c.source)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
          </>
        )}
      </Card>

      {creating && <CustomerFormModal open onClose={() => setCreating(false)} onSaved={(c) => router.push(`/customers/${c.id}`)} />}
    </div>
  );
}
