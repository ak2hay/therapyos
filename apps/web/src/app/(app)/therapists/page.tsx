'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  Tabs,
} from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { fmtDate, titleCase, todayIso } from '@/lib/format';
import { useBranches, useServices } from '@/lib/queries';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Therapist {
  id: string;
  name: string;
  phone: string | null;
  employeeCode: string;
  specialization: string | null;
  joiningDate: string | null;
  primaryBranchId: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  commissionType: 'PERCENTAGE' | 'FIXED_PER_SESSION' | 'TIERED' | 'NONE';
  commissionValue: number;
  commissionTiers: { minSessions: number; value: number }[] | null;
  color: string | null;
  services: { serviceId: string; service: { id: string; name: string } }[];
  schedules: { id: string; branchId: string; dayOfWeek: number; startTime: string; endTime: string }[];
  user: { id: string; email: string | null; status: string } | null;
  exceptions?: Exception[];
}
interface Exception {
  id: string;
  date: string;
  type: 'LEAVE' | 'HOLIDAY' | 'SPECIAL_SHIFT' | 'UNAVAILABLE';
  reason: string | null;
  startTime: string | null;
  endTime: string | null;
  branchId: string | null;
}

function ProfileTab({ therapist, onSaved }: { therapist?: Therapist; onSaved: (id: string) => void }) {
  const { data: branches } = useBranches();
  const { data: services } = useServices({ activeOnly: true });
  const [form, setForm] = useState({
    name: therapist?.name ?? '',
    phone: therapist?.phone ?? '',
    employeeCode: therapist?.employeeCode ?? '',
    specialization: therapist?.specialization ?? '',
    joiningDate: therapist?.joiningDate?.slice(0, 10) ?? '',
    primaryBranchId: therapist?.primaryBranchId ?? '',
    status: therapist?.status ?? 'ACTIVE',
    color: therapist?.color ?? '#7c3aed',
  });
  const [serviceIds, setServiceIds] = useState<Set<string>>(new Set(therapist?.services.map((s) => s.serviceId) ?? []));
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, serviceIds: [...serviceIds] };
      const res = therapist ? await api.patch<Therapist>(`/therapists/${therapist.id}`, body) : await api.post<Therapist>('/therapists', body);
      toast.success('Therapist saved');
      onSaved(res.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name"><Input value={form.name} onChange={set('name')} /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Employee code" hint={therapist ? undefined : 'Leave blank to auto-generate'}><Input value={form.employeeCode} onChange={set('employeeCode')} /></Field>
        <Field label="Specialisation"><Input value={form.specialization} onChange={set('specialization')} /></Field>
        <Field label="Primary branch">
          <Select value={form.primaryBranchId} onChange={set('primaryBranchId')}>
            <option value="">Select</option>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="Joining date"><Input type="date" value={form.joiningDate} onChange={set('joiningDate')} /></Field>
        <Field label="Status">
          <Select value={form.status} onChange={set('status')}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </Field>
        <Field label="Calendar colour"><Input type="color" className="h-9 p-1" value={form.color} onChange={set('color')} /></Field>
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-slate-600">Services this therapist can perform</p>
          <button className="text-xs text-brand-700 hover:underline" onClick={() => setServiceIds(new Set(services?.map((s) => s.id)))}>Select all</button>
        </div>
        <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-3 sm:grid-cols-2">
          {services?.map((s) => (
            <Checkbox key={s.id} label={s.name} checked={serviceIds.has(s.id)} onChange={(e) => setServiceIds((prev) => {
              const next = new Set(prev);
              if (e.target.checked) next.add(s.id);
              else next.delete(s.id);
              return next;
            })} />
          ))}
        </div>
      </div>
      <div className="flex justify-end"><Button onClick={save} loading={busy} disabled={!form.name}>Save profile</Button></div>
    </div>
  );
}

function CommissionTab({ therapist, onSaved }: { therapist: Therapist; onSaved: () => void }) {
  const [type, setType] = useState(therapist.commissionType);
  const [value, setValue] = useState(String(therapist.commissionValue ?? 0));
  const [tiers, setTiers] = useState(therapist.commissionTiers?.map((t) => ({ minSessions: String(t.minSessions), value: String(t.value) })) ?? [{ minSessions: '0', value: '10' }]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/therapists/${therapist.id}`, {
        commissionType: type,
        commissionValue: Number(value),
        commissionTiers: type === 'TIERED' ? tiers.map((t) => ({ minSessions: Number(t.minSessions), value: Number(t.value) })) : undefined,
      });
      toast.success('Commission updated');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Commission type">
          <Select value={type} onChange={(e) => setType(e.target.value as Therapist['commissionType'])}>
            <option value="NONE">No commission</option>
            <option value="PERCENTAGE">Percentage of service value</option>
            <option value="FIXED_PER_SESSION">Fixed amount per session</option>
            <option value="TIERED">Tiered by monthly sessions (%)</option>
          </Select>
        </Field>
        {(type === 'PERCENTAGE' || type === 'FIXED_PER_SESSION') && (
          <Field label={type === 'PERCENTAGE' ? 'Percentage (%)' : 'Amount per session'}>
            <Input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}
      </div>
      {type === 'TIERED' && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">The rate applies once the therapist reaches the minimum number of completed sessions in the month.</p>
          {tiers.map((t, i) => (
            <div key={i} className="flex items-end gap-2">
              <Field label="From session #"><Input type="number" value={t.minSessions} onChange={(e) => setTiers((p) => p.map((x, j) => (j === i ? { ...x, minSessions: e.target.value } : x)))} /></Field>
              <Field label="Rate (%)"><Input type="number" value={t.value} onChange={(e) => setTiers((p) => p.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} /></Field>
              <Button variant="ghost" size="icon" onClick={() => setTiers((p) => p.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setTiers((p) => [...p, { minSessions: '', value: '' }])}><Plus className="h-3.5 w-3.5" /> Add tier</Button>
        </div>
      )}
      <div className="flex justify-end"><Button onClick={save} loading={busy}>Save commission</Button></div>
    </div>
  );
}

function ScheduleTab({ therapist, onSaved }: { therapist: Therapist; onSaved: () => void }) {
  const { data: branches } = useBranches();
  const [shifts, setShifts] = useState(therapist.schedules.map((s) => ({ branchId: s.branchId, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime })));
  const [busy, setBusy] = useState(false);
  const defaultBranch = therapist.primaryBranchId ?? branches?.[0]?.id ?? '';
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/therapists/${therapist.id}/schedule`, { schedules: shifts });
      toast.success('Schedule saved');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const copyMondayToWeekdays = () => {
    const monday = shifts.filter((s) => s.dayOfWeek === 1);
    if (!monday.length) return toast.error('Add a Monday shift first');
    setShifts([...shifts.filter((s) => s.dayOfWeek === 0 || s.dayOfWeek === 1), ...[2, 3, 4, 5, 6].flatMap((d) => monday.map((m) => ({ ...m, dayOfWeek: d })))]);
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button size="sm" variant="outline" onClick={copyMondayToWeekdays}>Copy Monday to Tue-Sat</Button></div>
      {DAYS.map((day, dow) => {
        const dayShifts = shifts.map((s, i) => ({ ...s, i })).filter((s) => s.dayOfWeek === dow);
        return (
          <div key={day} className="flex flex-wrap items-start gap-3 border-b border-slate-100 pb-3">
            <p className="w-24 pt-2 text-sm font-medium text-slate-700">{day}</p>
            <div className="flex-1 space-y-2">
              {!dayShifts.length && <p className="pt-2 text-sm text-slate-400">Off</p>}
              {dayShifts.map((s) => (
                <div key={s.i} className="flex flex-wrap gap-2">
                  <Select className="w-44" value={s.branchId} onChange={(e) => setShifts((p) => p.map((x, j) => (j === s.i ? { ...x, branchId: e.target.value } : x)))}>
                    {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </Select>
                  <Input type="time" className="w-32" value={s.startTime} onChange={(e) => setShifts((p) => p.map((x, j) => (j === s.i ? { ...x, startTime: e.target.value } : x)))} />
                  <Input type="time" className="w-32" value={s.endTime} onChange={(e) => setShifts((p) => p.map((x, j) => (j === s.i ? { ...x, endTime: e.target.value } : x)))} />
                  <Button variant="ghost" size="icon" onClick={() => setShifts((p) => p.filter((_, j) => j !== s.i))}><Trash2 className="h-4 w-4" /></Button>
                </div>
              ))}
            </div>
            <Button size="sm" variant="ghost" onClick={() => setShifts((p) => [...p, { branchId: defaultBranch, dayOfWeek: dow, startTime: '10:00', endTime: '19:00' }])}>
              <Plus className="h-3.5 w-3.5" /> Shift
            </Button>
          </div>
        );
      })}
      <div className="flex justify-end"><Button onClick={save} loading={busy}>Save schedule</Button></div>
    </div>
  );
}

function ExceptionsTab({ therapist }: { therapist: Therapist }) {
  const qc = useQueryClient();
  const { data: branches } = useBranches();
  const { data, isLoading } = useQuery({
    queryKey: ['therapist-exceptions', therapist.id],
    queryFn: () => api.get<Exception[]>(`/therapists/${therapist.id}/exceptions`, { from: todayIso() }),
  });
  const [form, setForm] = useState({ date: todayIso(), type: 'LEAVE', reason: '', startTime: '', endTime: '', branchId: '' });
  const add = async () => {
    try {
      await api.post(`/therapists/${therapist.id}/exceptions`, form);
      await qc.invalidateQueries({ queryKey: ['therapist-exceptions', therapist.id] });
      setForm((f) => ({ ...f, reason: '', startTime: '', endTime: '' }));
      toast.success('Added');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const remove = async (id: string) => {
    await api.delete(`/therapists/${therapist.id}/exceptions/${id}`);
    await qc.invalidateQueries({ queryKey: ['therapist-exceptions', therapist.id] });
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-3">
        <Field label="Date"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        <Field label="Type">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="LEAVE">Leave</option>
            <option value="HOLIDAY">Holiday</option>
            <option value="UNAVAILABLE">Unavailable (partial)</option>
            <option value="SPECIAL_SHIFT">Special shift</option>
          </Select>
        </Field>
        <Field label="Branch" hint={form.type === 'SPECIAL_SHIFT' ? 'Required for special shifts' : 'Optional'}>
          <Select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
            <option value="">All branches</option>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="From (optional)"><Input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} /></Field>
        <Field label="To (optional)"><Input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} /></Field>
        <Field label="Reason"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
        <div className="sm:col-span-3"><Button size="sm" onClick={add}><Plus className="h-3.5 w-3.5" /> Add</Button></div>
      </div>
      {isLoading ? <LoadingBlock /> : !data?.length ? (
        <EmptyState icon={<CalendarOff className="h-8 w-8" />} title="No upcoming leave or exceptions" />
      ) : (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {data.map((e) => (
            <div key={e.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{fmtDate(e.date)}</span>
                <Badge className="ml-2" tone={e.type === 'SPECIAL_SHIFT' ? 'green' : 'amber'}>{titleCase(e.type)}</Badge>
                <span className="ml-2 text-slate-500">{e.startTime ? `${e.startTime} - ${e.endTime}` : 'Full day'}</span>
                {e.reason && <span className="ml-2 text-slate-400">· {e.reason}</span>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => remove(e.id)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TherapistEditor({ therapistId, onClose }: { therapistId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [id, setId] = useState(therapistId);
  const [tab, setTab] = useState<'profile' | 'commission' | 'schedule' | 'exceptions'>('profile');
  const { data, isLoading } = useQuery({ queryKey: ['therapist', id], queryFn: () => api.get<Therapist>(`/therapists/${id}`), enabled: !!id });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['therapists'] });
    await qc.invalidateQueries({ queryKey: ['therapist', id] });
  };
  if (id && isLoading) return <LoadingBlock />;
  return (
    <div>
      {id && (
        <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[
          { value: 'profile', label: 'Profile & skills' },
          { value: 'schedule', label: 'Weekly schedule' },
          { value: 'exceptions', label: 'Leave & exceptions' },
          { value: 'commission', label: 'Commission' },
        ]} />
      )}
      {tab === 'profile' && <ProfileTab key={data?.id ?? 'new'} therapist={data} onSaved={async (newId) => { setId(newId); await refresh(); if (!id) setTab('schedule'); }} />}
      {tab === 'schedule' && data && <ScheduleTab key={data.id} therapist={data} onSaved={refresh} />}
      {tab === 'exceptions' && data && <ExceptionsTab therapist={data} />}
      {tab === 'commission' && data && <CommissionTab key={data.id} therapist={data} onSaved={refresh} />}
      {!id && <p className="mt-3 text-xs text-slate-500">Save the profile to configure schedule, leave and commission.</p>}
      <div className="mt-4 flex justify-end border-t border-slate-100 pt-3"><Button variant="outline" onClick={onClose}>Close</Button></div>
    </div>
  );
}

export default function TherapistsPage() {
  const user = useAuth((s) => s.user);
  const canManage = hasPermission(user, PERMISSIONS.THERAPIST_MANAGE);
  const branchId = useBranch((s) => s.branchId);
  const { data: branches } = useBranches();
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [showInactive, setShowInactive] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['therapists', { branchId, all: true }],
    queryFn: () => api.get<Therapist[]>('/therapists', { branchId: branchId ?? undefined }),
  });
  const branchName = (id: string | null) => branches?.find((b) => b.id === id)?.name ?? '-';
  const list = (data ?? []).filter((t) => showInactive || t.status === 'ACTIVE');

  return (
    <div>
      <PageHeader
        title="Therapists"
        description="Skills, working hours, leave and commission for each therapist."
        actions={canManage && <Button onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> Add therapist</Button>}
      />
      <div className="mb-4"><Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /></div>
      {isLoading ? <LoadingBlock /> : !list.length ? (
        <Card><EmptyState title="No therapists yet" action={canManage && <Button onClick={() => setEditing(null)}>Add therapist</Button>} /></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((t) => {
            const days = [...new Set(t.schedules.map((s) => s.dayOfWeek))].sort();
            return (
              <Card key={t.id} className="cursor-pointer transition-shadow hover:shadow-md" onClick={() => canManage && setEditing(t.id)}>
                <CardContent>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: t.color ?? '#7c3aed' }}>
                        {t.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
                      </span>
                      <div>
                        <p className="font-medium text-slate-900">{t.name}</p>
                        <p className="text-xs text-slate-500">{t.employeeCode} · {t.specialization ?? 'Therapist'}</p>
                      </div>
                    </div>
                    <StatusBadge status={t.status} />
                  </div>
                  <div className="mt-4 space-y-1.5 text-xs text-slate-600">
                    <p><span className="text-slate-400">Branch:</span> {branchName(t.primaryBranchId)}</p>
                    <p><span className="text-slate-400">Works:</span> {days.length ? days.map((d) => DAYS[d].slice(0, 3)).join(', ') : 'No schedule'}</p>
                    <p><span className="text-slate-400">Commission:</span> {t.commissionType === 'NONE' ? 'None' : t.commissionType === 'PERCENTAGE' ? `${t.commissionValue}%` : t.commissionType === 'FIXED_PER_SESSION' ? `₹${t.commissionValue}/session` : 'Tiered'}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {t.services.slice(0, 4).map((s) => <Badge key={s.serviceId}>{s.service.name}</Badge>)}
                    {t.services.length > 4 && <Badge>+{t.services.length - 4}</Badge>}
                  </div>
                  {t.user && <p className="mt-3 text-[11px] text-slate-400">Login: {t.user.email}</p>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? 'Therapist' : 'New therapist'} size="xl">
        {editing !== undefined && <TherapistEditor therapistId={editing} onClose={() => setEditing(undefined)} />}
      </Modal>
    </div>
  );
}
