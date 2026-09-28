'use client';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, subMonths } from 'date-fns';
import { Calculator, FileSignature, Handshake, IndianRupee, Network, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardContent, CardHeader, Checkbox, EmptyState, Field, Input, LoadingBlock, Modal, PageHeader, Pagination, Select, StatCard, Table, Tabs, TBody, TD, Textarea, TH, THead, TR } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { fmtDate, money, titleCase } from '@/lib/format';
import { useBranches } from '@/lib/queries';

interface Group { id: string; name: string; description: string | null; status: string; franchisees: number }
interface Contract { id: string; startDate: string; endDate: string | null; royaltyPercent: number; marketingFeePercent: number; fixedMonthlyFee: number; franchiseFee: number; terms: string | null; status: string }
interface Franchisee {
  id: string;
  name: string;
  ownerName: string;
  email: string | null;
  phone: string | null;
  status: string;
  franchiseGroupId: string;
  group: { id: string; name: string };
  branches: { id: string; name: string; code: string; city?: string | null }[];
  activeContract: Contract | null;
  outstanding: number;
}
interface FranchiseeDetail extends Omit<Franchisee, 'activeContract'> {
  contracts: Contract[];
  fees: Fee[];
  monthlyRevenue: { month: string; revenue: number }[];
}
interface Fee { id: string; type: string; periodStart: string; periodEnd: string; grossRevenue: number; amount: number; status: string; dueDate: string; paidAt: string | null; overdue?: boolean; franchisee?: { id: string; name: string } }
interface Overview { franchisees: number; branches: number; outstanding: number; collectedThisYear: number; franchiseRevenueMtd: number; lastClosedMonth: string }

const FEE_LABEL: Record<string, string> = { ROYALTY: 'Royalty', MARKETING: 'Marketing fee', FIXED: 'Fixed monthly fee', FRANCHISE_FEE: 'Franchise fee' };
const FEE_TONE: Record<string, 'amber' | 'green' | 'gray'> = { DUE: 'amber', PAID: 'green', WAIVED: 'gray' };

function GroupModal({ group, onClose }: { group: Partial<Group> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: group?.name ?? '', description: group?.description ?? '', status: group?.status ?? 'ACTIVE' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (group?.id) await api.patch(`/franchise/groups/${group.id}`, form);
      else await api.post('/franchise/groups', form);
      toast.success('Group saved');
      await qc.invalidateQueries({ queryKey: ['franchise'] });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={group?.id ? 'Edit group' : 'New franchise group'} size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={form.name.length < 2}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Description"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Status"><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select></Field>
      </div>
    </Modal>
  );
}

function FranchiseeModal({ franchisee, groups, onClose }: { franchisee: Franchisee | null; groups: Group[]; onClose: (id?: string) => void }) {
  const qc = useQueryClient();
  const { data: branches } = useBranches();
  const [form, setForm] = useState({
    franchiseGroupId: franchisee?.franchiseGroupId ?? groups[0]?.id ?? '',
    name: franchisee?.name ?? '',
    ownerName: franchisee?.ownerName ?? '',
    email: franchisee?.email ?? '',
    phone: franchisee?.phone ?? '',
    status: franchisee?.status ?? 'ACTIVE',
    branchIds: franchisee?.branches.map((b) => b.id) ?? [],
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const saved = franchisee ? await api.patch<{ id: string }>(`/franchise/franchisees/${franchisee.id}`, form) : await api.post<{ id: string }>('/franchise/franchisees', form);
      toast.success('Franchisee saved');
      await qc.invalidateQueries({ queryKey: ['franchise'] });
      onClose(saved.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const toggleBranch = (id: string) => setForm((f) => ({ ...f, branchIds: f.branchIds.includes(id) ? f.branchIds.filter((b) => b !== id) : [...f.branchIds, id] }));
  return (
    <Modal open onClose={() => onClose()} title={franchisee ? 'Edit franchisee' : 'Add franchisee'} size="md"
      footer={<><Button variant="outline" onClick={() => onClose()}>Cancel</Button><Button onClick={save} loading={busy} disabled={!form.name || !form.ownerName || !form.franchiseGroupId}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Group" className="sm:col-span-2">
          <Select value={form.franchiseGroupId} onChange={(e) => setForm({ ...form, franchiseGroupId: e.target.value })}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </Field>
        <Field label="Business name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Owner name"><Input value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Branches operated" className="sm:col-span-2" hint="Each branch can belong to one franchisee.">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {branches?.map((b) => <Checkbox key={b.id} label={`${b.name} (${b.code})`} checked={form.branchIds.includes(b.id)} onChange={() => toggleBranch(b.id)} />)}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function ContractModal({ franchiseeId, contract, onClose }: { franchiseeId: string; contract: Contract | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    startDate: contract?.startDate.slice(0, 10) ?? format(new Date(), 'yyyy-MM-dd'),
    endDate: contract?.endDate?.slice(0, 10) ?? '',
    royaltyPercent: String(contract?.royaltyPercent ?? 6),
    marketingFeePercent: String(contract?.marketingFeePercent ?? 2),
    fixedMonthlyFee: String(contract?.fixedMonthlyFee ?? 0),
    franchiseFee: String(contract?.franchiseFee ?? 0),
    terms: contract?.terms ?? '',
    status: contract?.status ?? 'ACTIVE',
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, royaltyPercent: Number(form.royaltyPercent), marketingFeePercent: Number(form.marketingFeePercent), fixedMonthlyFee: Number(form.fixedMonthlyFee), franchiseFee: Number(form.franchiseFee) };
      if (contract) {
        const { franchiseFee: _f, ...rest } = body;
        await api.patch(`/franchise/contracts/${contract.id}`, rest);
      } else await api.post('/franchise/contracts', { ...body, franchiseeId });
      toast.success('Contract saved');
      await qc.invalidateQueries({ queryKey: ['franchise'] });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={contract ? 'Edit contract' : 'New contract'} description={contract ? undefined : 'Activating a contract ends the franchisee’s current active contract.'} size="md"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>Save contract</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Start date"><Input type="date" value={form.startDate} onChange={set('startDate')} /></Field>
        <Field label="End date"><Input type="date" value={form.endDate} onChange={set('endDate')} /></Field>
        <Field label="Royalty (% of net sales)"><Input type="number" step="0.1" min={0} max={100} value={form.royaltyPercent} onChange={set('royaltyPercent')} /></Field>
        <Field label="Marketing fee (%)"><Input type="number" step="0.1" min={0} max={100} value={form.marketingFeePercent} onChange={set('marketingFeePercent')} /></Field>
        <Field label="Fixed monthly fee"><Input type="number" min={0} value={form.fixedMonthlyFee} onChange={set('fixedMonthlyFee')} /></Field>
        {!contract && <Field label="One-time franchise fee" hint="Billed once on the start date"><Input type="number" min={0} value={form.franchiseFee} onChange={set('franchiseFee')} /></Field>}
        <Field label="Status"><Select value={form.status} onChange={set('status')}>{['DRAFT', 'ACTIVE', 'TERMINATED', 'EXPIRED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field>
        <Field label="Terms" className="sm:col-span-2"><Textarea rows={3} value={form.terms} onChange={set('terms')} /></Field>
      </div>
    </Modal>
  );
}

function FeeActions({ fee, canManage }: { fee: Fee; canManage: boolean }) {
  const qc = useQueryClient();
  const set = async (status: string) => {
    try {
      await api.patch(`/franchise/fees/${fee.id}`, { status });
      toast.success(status === 'PAID' ? 'Marked as paid' : status === 'WAIVED' ? 'Fee waived' : 'Marked as due');
      await qc.invalidateQueries({ queryKey: ['franchise'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  if (!canManage) return null;
  return fee.status === 'DUE' ? (
    <div className="flex justify-end gap-1">
      <Button size="sm" variant="outline" onClick={() => set('PAID')}>Mark paid</Button>
      <Button size="sm" variant="ghost" onClick={() => set('WAIVED')}>Waive</Button>
    </div>
  ) : (
    <Button size="sm" variant="ghost" onClick={() => set('DUE')}>Reopen</Button>
  );
}

function FranchiseeDetailModal({ id, groups, canManage, onClose }: { id: string; groups: Group[]; canManage: boolean; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['franchise', 'franchisee', id], queryFn: () => api.get<FranchiseeDetail>(`/franchise/franchisees/${id}`) });
  const [contract, setContract] = useState<Contract | null | 'new'>(null);
  const [editing, setEditing] = useState(false);
  const active = data?.contracts.find((c) => c.status === 'ACTIVE');
  const maxRev = Math.max(1, ...(data?.monthlyRevenue.map((m) => m.revenue) ?? [1]));
  return (
    <Modal open onClose={onClose} size="xl" title={data?.name ?? 'Franchisee'} description={data ? `${data.ownerName} · ${data.group.name}${data.email ? ` · ${data.email}` : ''}${data.phone ? ` · ${data.phone}` : ''}` : undefined}
      footer={canManage && data && <><Button variant="outline" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Edit details</Button><Button onClick={() => setContract('new')}><FileSignature className="h-4 w-4" /> New contract</Button></>}>
      {!data ? <LoadingBlock /> : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            <StatCard label="Branches" value={data.branches.length} hint={data.branches.map((b) => b.code).join(', ') || 'None assigned'} />
            <StatCard label="Royalty" value={active ? `${active.royaltyPercent}%` : '—'} hint={active ? `+ ${active.marketingFeePercent}% marketing` : 'No active contract'} />
            <StatCard label="Fixed fee" value={active ? money(active.fixedMonthlyFee) : '—'} hint="per month" />
            <StatCard label="Outstanding" value={money(data.outstanding)} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-800">Net sales by month</p>
              <div className="space-y-1.5">
                {data.monthlyRevenue.map((m) => (
                  <div key={m.month} className="flex items-center gap-2 text-xs">
                    <span className="w-16 text-slate-500">{fmtDate(`${m.month}-01`, 'MMM yyyy')}</span>
                    <div className="h-2 flex-1 rounded bg-slate-100"><div className="h-2 rounded bg-brand-500" style={{ width: `${(m.revenue / maxRev) * 100}%` }} /></div>
                    <span className="w-24 text-right font-medium">{money(m.revenue)}</span>
                  </div>
                ))}
                {!data.monthlyRevenue.length && <p className="text-sm text-slate-500">No sales yet.</p>}
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-800">Contracts</p>
              <div className="space-y-2">
                {data.contracts.map((c) => (
                  <div key={c.id} className="flex items-start justify-between rounded-lg border border-slate-200 p-2.5 text-sm">
                    <div>
                      <p className="font-medium">{fmtDate(c.startDate)} – {c.endDate ? fmtDate(c.endDate) : 'open-ended'} <Badge tone={c.status === 'ACTIVE' ? 'green' : 'gray'}>{titleCase(c.status)}</Badge></p>
                      <p className="text-xs text-slate-500">{c.royaltyPercent}% royalty · {c.marketingFeePercent}% marketing · {money(c.fixedMonthlyFee)}/month{Number(c.franchiseFee) ? ` · ${money(c.franchiseFee)} joining fee` : ''}</p>
                    </div>
                    {canManage && <Button size="icon" variant="ghost" aria-label="Edit contract" onClick={() => setContract(c)}><Pencil className="h-4 w-4" /></Button>}
                  </div>
                ))}
                {!data.contracts.length && <p className="text-sm text-slate-500">No contracts yet.</p>}
              </div>
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold text-slate-800">Fees</p>
            <Table>
              <THead><TR><TH>Period</TH><TH>Type</TH><TH className="text-right">Net sales</TH><TH className="text-right">Amount</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {data.fees.map((f) => (
                  <TR key={f.id}>
                    <TD className="text-xs">{f.type === 'FRANCHISE_FEE' ? fmtDate(f.periodStart) : fmtDate(f.periodStart, 'MMM yyyy')}</TD>
                    <TD>{FEE_LABEL[f.type]}</TD>
                    <TD className="text-right text-slate-500">{f.type === 'FRANCHISE_FEE' || f.type === 'FIXED' ? '' : money(f.grossRevenue)}</TD>
                    <TD className="text-right font-medium">{money(f.amount)}</TD>
                    <TD><Badge tone={FEE_TONE[f.status]}>{titleCase(f.status)}</Badge></TD>
                    <TD><FeeActions fee={f} canManage={canManage} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </div>
      )}
      {contract && <ContractModal franchiseeId={id} contract={contract === 'new' ? null : contract} onClose={() => setContract(null)} />}
      {editing && data && <FranchiseeModal franchisee={{ ...data, activeContract: active ?? null }} groups={groups} onClose={() => setEditing(false)} />}
    </Modal>
  );
}

function FeesTab({ franchisees, canManage }: { franchisees: Franchisee[]; canManage: boolean }) {
  const qc = useQueryClient();
  const [filters, setFilters] = useState({ franchiseeId: '', status: '', type: '', period: '' });
  const [page, setPage] = useState(1);
  const [month, setMonth] = useState(format(subMonths(new Date(), 1), 'yyyy-MM'));
  const [running, setRunning] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['franchise', 'fees', filters, page],
    queryFn: () => api.page<Fee>('/franchise/fees', { ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), page: String(page), pageSize: '25' }),
    placeholderData: keepPreviousData,
  });
  const summary = (data?.meta as { summary?: { due: number; paid: number; waived: number; overdue: number; overdueCount: number } } | undefined)?.summary;
  const run = async () => {
    setRunning(true);
    try {
      const r = await api.post<{ contracts: number; created: number; updated: number; grossRevenue: number }>('/franchise/royalties/run', { month });
      toast.success(`Royalties for ${month} calculated`, { description: `${r.contracts} contracts · ${r.created} new fees · ${r.updated} updated · net sales ${money(r.grossRevenue)}` });
      await qc.invalidateQueries({ queryKey: ['franchise'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => { setFilters({ ...filters, [k]: e.target.value }); setPage(1); };
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Due" value={money(summary?.due ?? 0)} />
        <StatCard label="Overdue" value={money(summary?.overdue ?? 0)} hint={summary?.overdueCount ? `${summary.overdueCount} fees past due date` : 'Nothing overdue'} />
        <StatCard label="Collected" value={money(summary?.paid ?? 0)} />
        <StatCard label="Waived" value={money(summary?.waived ?? 0)} />
      </div>
      {canManage && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 py-3">
            <Field label="Calculate royalties for"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" /></Field>
            <Button onClick={run} loading={running}><Calculator className="h-4 w-4" /> Calculate</Button>
            <p className="max-w-md text-xs text-slate-500">Runs automatically on the 1st of each month for the month just closed. Recalculating only updates fees that are still due.</p>
          </CardContent>
        </Card>
      )}
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <Select className="w-52" value={filters.franchiseeId} onChange={set('franchiseeId')} aria-label="Franchisee"><option value="">All franchisees</option>{franchisees.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
          <Select className="w-36" value={filters.status} onChange={set('status')} aria-label="Status"><option value="">Any status</option>{Object.keys(FEE_TONE).map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>
          <Select className="w-44" value={filters.type} onChange={set('type')} aria-label="Type"><option value="">All fee types</option>{Object.entries(FEE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Input type="month" className="w-44" value={filters.period} onChange={set('period')} aria-label="Period" />
        </div>
        {isLoading ? <LoadingBlock /> : !data?.items.length ? <EmptyState title="No fees" description="Fees appear once royalties are calculated." /> : (
          <>
            <Table>
              <THead><TR><TH>Franchisee</TH><TH>Period</TH><TH>Type</TH><TH className="text-right">Net sales</TH><TH className="text-right">Amount</TH><TH>Due</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {data.items.map((f) => (
                  <TR key={f.id} data-testid="fee-row">
                    <TD className="font-medium">{f.franchisee?.name}</TD>
                    <TD className="text-xs">{f.type === 'FRANCHISE_FEE' ? fmtDate(f.periodStart) : fmtDate(f.periodStart, 'MMM yyyy')}</TD>
                    <TD>{FEE_LABEL[f.type]}</TD>
                    <TD className="text-right text-slate-500">{f.type === 'ROYALTY' || f.type === 'MARKETING' ? money(f.grossRevenue) : ''}</TD>
                    <TD className="text-right font-medium">{money(f.amount)}</TD>
                    <TD className={`text-xs ${f.overdue ? 'font-medium text-rose-600' : ''}`}>{fmtDate(f.dueDate)}{f.overdue ? ' · overdue' : ''}</TD>
                    <TD><Badge tone={FEE_TONE[f.status]}>{titleCase(f.status)}</Badge>{f.paidAt && <p className="text-[11px] text-slate-400">{fmtDate(f.paidAt)}</p>}</TD>
                    <TD><FeeActions fee={f} canManage={canManage} /></TD>
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

export default function FranchisePage() {
  const user = useAuth((s) => s.user);
  const canManage = hasPermission(user, PERMISSIONS.FRANCHISE_MANAGE);
  const [tab, setTab] = useState<'franchisees' | 'fees' | 'groups'>('franchisees');
  const [detail, setDetail] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [group, setGroup] = useState<Partial<Group> | null>(null);
  const overview = useQuery({ queryKey: ['franchise', 'overview'], queryFn: () => api.get<Overview>('/franchise/overview') });
  const groups = useQuery({ queryKey: ['franchise', 'groups'], queryFn: () => api.get<Group[]>('/franchise/groups') });
  const franchisees = useQuery({ queryKey: ['franchise', 'franchisees'], queryFn: () => api.get<Franchisee[]>('/franchise/franchisees') });
  const o = overview.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Franchise"
        description="Franchise partners, their branches and contracts, and the royalties they owe."
        actions={canManage && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setGroup({})}><Network className="h-4 w-4" /> New group</Button>
            <Button onClick={() => setAdding(true)} disabled={!groups.data?.length}><Plus className="h-4 w-4" /> Add franchisee</Button>
          </div>
        )}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Franchisees" value={o?.franchisees ?? '—'} hint={`${o?.branches ?? 0} franchised branches`} icon={<Handshake className="h-4 w-4" />} />
        <StatCard label="Franchise net sales (MTD)" value={money(o?.franchiseRevenueMtd ?? 0)} icon={<IndianRupee className="h-4 w-4" />} />
        <StatCard label="Outstanding fees" value={money(o?.outstanding ?? 0)} icon={<FileSignature className="h-4 w-4" />} />
        <StatCard label="Collected this year" value={money(o?.collectedThisYear ?? 0)} icon={<Calculator className="h-4 w-4" />} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'franchisees', label: 'Franchisees' }, { value: 'fees', label: 'Fees & royalties' }, { value: 'groups', label: 'Groups' }]} />
      {tab === 'franchisees' && (
        franchisees.isLoading ? <LoadingBlock /> : !franchisees.data?.length ? (
          <Card><EmptyState icon={<Handshake className="h-6 w-6" />} title="No franchisees yet" description={groups.data?.length ? 'Add your first franchise partner.' : 'Create a franchise group first, then add partners to it.'} /></Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {franchisees.data.map((f) => (
              <Card key={f.id} className="cursor-pointer transition hover:border-brand-300" onClick={() => setDetail(f.id)} data-testid="franchisee-card">
                <CardHeader title={f.name} description={`${f.ownerName} · ${f.group.name}`} actions={<Badge tone={f.status === 'ACTIVE' ? 'green' : 'gray'}>{titleCase(f.status)}</Badge>} />
                <CardContent className="space-y-2 text-sm">
                  <p className="text-slate-600">{f.branches.length ? f.branches.map((b) => b.name).join(', ') : 'No branches assigned'}</p>
                  <p className="text-xs text-slate-500">{f.activeContract ? `${f.activeContract.royaltyPercent}% royalty · ${f.activeContract.marketingFeePercent}% marketing · ${money(f.activeContract.fixedMonthlyFee)}/mo` : 'No active contract'}</p>
                  <p className={`text-sm font-medium ${f.outstanding ? 'text-amber-700' : 'text-emerald-700'}`}>{f.outstanding ? `${money(f.outstanding)} outstanding` : 'All fees settled'}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      )}
      {tab === 'fees' && <FeesTab franchisees={franchisees.data ?? []} canManage={canManage} />}
      {tab === 'groups' && (
        <Card>
          <Table>
            <THead><TR><TH>Group</TH><TH>Description</TH><TH className="text-right">Franchisees</TH><TH>Status</TH><TH /></TR></THead>
            <TBody>
              {groups.data?.map((g) => (
                <TR key={g.id}>
                  <TD className="font-medium">{g.name}</TD>
                  <TD className="text-slate-500">{g.description}</TD>
                  <TD className="text-right">{g.franchisees}</TD>
                  <TD><Badge tone={g.status === 'ACTIVE' ? 'green' : 'gray'}>{titleCase(g.status)}</Badge></TD>
                  <TD className="text-right">{canManage && <Button size="icon" variant="ghost" aria-label="Edit group" onClick={() => setGroup(g)}><Pencil className="h-4 w-4" /></Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {detail && <FranchiseeDetailModal id={detail} groups={groups.data ?? []} canManage={canManage} onClose={() => setDetail(null)} />}
      {adding && <FranchiseeModal franchisee={null} groups={groups.data ?? []} onClose={(id) => { setAdding(false); if (id) setDetail(id); }} />}
      {group && <GroupModal group={group} onClose={() => setGroup(null)} />}
    </div>
  );
}
