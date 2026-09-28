'use client';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Lock, Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, LoadingBlock, Modal, PageHeader, Pagination, Select, StatCard, Table, TBody, TD, Textarea, TH, THead, TR } from '@therapyos/ui';
import { EXPENSE_CATEGORIES, PERMISSIONS } from '@therapyos/types';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { fmtDate, money, titleCase, todayIso } from '@/lib/format';
import { useBranches, useWorkingBranch } from '@/lib/queries';

interface Expense {
  id: string;
  branchId: string;
  branch: { id: string; name: string };
  category: string;
  amount: number;
  description: string | null;
  expenseDate: string;
  paymentMethod: string;
  vendor: string | null;
  receiptUrl: string | null;
  fromPurchase: boolean;
}
interface Summary {
  total: number;
  byCategory: { category: string; amount: number; count: number }[];
}

const METHODS: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK_TRANSFER: 'Bank transfer', OTHER: 'Other' };
const monthStart = () => todayIso().slice(0, 8) + '01';

export default function ExpensesPage() {
  const user = useAuth((s) => s.user);
  const canManage = hasPermission(user, PERMISSIONS.EXPENSE_MANAGE);
  const branchId = useBranch((s) => s.branchId);
  const qc = useQueryClient();
  const [filters, setFilters] = useState({ category: '', from: monthStart(), to: todayIso(), search: '' });
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['expenses', filters, page, branchId],
    queryFn: () =>
      api.page<Expense>('/expenses', {
        category: filters.category || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        search: filters.search || undefined,
        branchId: branchId ?? undefined,
        page: String(page),
        pageSize: '25',
      }),
    placeholderData: keepPreviousData,
  });
  const summary = (data?.meta as { summary?: Summary } | undefined)?.summary;
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await api.delete(`/expenses/${deleting.id}`);
      toast.success('Expense deleted');
      qc.invalidateQueries({ queryKey: ['expenses'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Expenses"
        description="Running costs by branch and category. Every expense is posted to the books."
        actions={canManage && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Add expense</Button>}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total in period" value={money(summary?.total ?? 0)} hint={`${data?.meta.total ?? 0} entries`} icon={<Wallet className="h-4 w-4" />} />
        {(summary?.byCategory ?? []).slice(0, 3).map((c) => (
          <StatCard key={c.category} label={titleCase(c.category)} value={money(c.amount)} hint={summary?.total ? `${Math.round((c.amount / summary.total) * 100)}% of spend` : undefined} />
        ))}
      </div>
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <Input placeholder="Search vendor or description" value={filters.search} onChange={set('search')} />
          <Select value={filters.category} onChange={set('category')}>
            <option value="">All categories</option>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </Select>
          <Input type="date" value={filters.from} onChange={set('from')} aria-label="From date" />
          <Input type="date" value={filters.to} onChange={set('to')} aria-label="To date" />
        </div>
      </Card>
      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.items.length ? (
          <EmptyState icon={<Wallet className="h-6 w-6" />} title="No expenses in this period" description="Rent, salaries, utilities and other costs appear here." />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Category</TH>
                  <TH>Details</TH>
                  <TH>Branch</TH>
                  <TH>Paid by</TH>
                  <TH className="text-right">Amount</TH>
                  {canManage && <TH />}
                </TR>
              </THead>
              <TBody>
                {data.items.map((e) => (
                  <TR key={e.id}>
                    <TD className="text-slate-600">{fmtDate(e.expenseDate)}</TD>
                    <TD><Badge tone={e.category === 'INVENTORY' ? 'purple' : 'gray'}>{titleCase(e.category)}</Badge></TD>
                    <TD>
                      <p className="text-slate-900">{e.description ?? '-'}</p>
                      {e.vendor && <p className="text-xs text-slate-500">{e.vendor}</p>}
                    </TD>
                    <TD>{e.branch.name}</TD>
                    <TD className="text-slate-600">{METHODS[e.paymentMethod] ?? e.paymentMethod}</TD>
                    <TD className="text-right tabular-nums font-medium">{money(e.amount)}</TD>
                    {canManage && (
                      <TD className="text-right whitespace-nowrap">
                        {e.fromPurchase ? (
                          <span className="inline-flex items-center gap-1 text-xs text-slate-400" title="Created by a stock purchase; manage it from Inventory."><Lock className="h-3 w-3" /> Purchase</span>
                        ) : (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(e)} aria-label="Edit expense"><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button size="sm" variant="ghost" onClick={() => setDeleting(e)} aria-label="Delete expense"><Trash2 className="h-3.5 w-3.5 text-rose-600" /></Button>
                          </>
                        )}
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
      {editing && <ExpenseForm existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="Delete expense?"
        message={deleting ? `${titleCase(deleting.category)} of ${money(deleting.amount)} on ${fmtDate(deleting.expenseDate)} will be removed and its ledger entry reversed.` : ''}
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

function ExpenseForm({ existing, onClose }: { existing?: Expense; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: branches } = useBranches();
  const working = useWorkingBranch(branches);
  const [form, setForm] = useState({
    branchId: existing?.branchId ?? working ?? '',
    category: existing?.category ?? 'RENT',
    amount: existing ? String(existing.amount) : '',
    expenseDate: existing?.expenseDate.slice(0, 10) ?? todayIso(),
    paymentMethod: existing?.paymentMethod ?? 'BANK_TRANSFER',
    vendor: existing?.vendor ?? '',
    description: existing?.description ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const body = { ...form, branchId: form.branchId || working, amount: Number(form.amount) };
      if (existing) await api.patch(`/expenses/${existing.id}`, body);
      else await api.post('/expenses', body);
      toast.success(existing ? 'Expense updated' : 'Expense recorded');
      qc.invalidateQueries({ queryKey: ['expenses'] });
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? 'Edit expense' : 'Add expense'}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={!(Number(form.amount) > 0)}>Save</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Branch" error={errors.branchId}>
          <Select value={form.branchId} onChange={set('branchId')}>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="Category" error={errors.category}>
          <Select value={form.category} onChange={set('category')}>
            {EXPENSE_CATEGORIES.filter((c) => c !== 'INVENTORY').map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </Select>
        </Field>
        <Field label="Amount" error={errors.amount}><Input type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} autoFocus /></Field>
        <Field label="Date" error={errors.expenseDate}><Input type="date" value={form.expenseDate} max={todayIso()} onChange={set('expenseDate')} /></Field>
        <Field label="Paid by">
          <Select value={form.paymentMethod} onChange={set('paymentMethod')}>
            {Object.entries(METHODS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Vendor"><Input value={form.vendor} onChange={set('vendor')} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={form.description} onChange={set('description')} /></Field>
      </div>
    </Modal>
  );
}
