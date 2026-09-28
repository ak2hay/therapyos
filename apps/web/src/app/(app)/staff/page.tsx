'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Table,
  Tabs,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { ago } from '@/lib/format';
import { useBranches, useRoles, type RoleLite } from '@/lib/queries';

interface StaffUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  lastLoginAt: string | null;
  userRoles: { role: { id: string; name: string; key: string | null }; branch: { id: string; name: string } | null }[];
  therapist: { id: string; employeeCode: string } | null;
}

function StaffForm({ staff, onDone }: { staff?: StaffUser; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: roles } = useRoles();
  const { data: branches } = useBranches();
  const [name, setName] = useState(staff?.name ?? '');
  const [email, setEmail] = useState(staff?.email ?? '');
  const [phone, setPhone] = useState(staff?.phone ?? '');
  const [password, setPassword] = useState('');
  const [isTherapist, setIsTherapist] = useState(!!staff?.therapist);
  const [assignments, setAssignments] = useState<{ roleId: string; branchId: string | null }[]>(
    staff?.userRoles.map((ur) => ({ roleId: ur.role.id, branchId: ur.branch?.id ?? null })) ?? [{ roleId: '', branchId: null }],
  );
  const [status, setStatus] = useState(staff?.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name,
        email: email || undefined,
        phone: phone || undefined,
        password: password || undefined,
        isTherapist,
        roles: assignments.filter((a) => a.roleId),
        sendInvite: !password,
        ...(staff ? { status } : {}),
      };
      const res = staff ? await api.patch<StaffUser>(`/users/${staff.id}`, body) : await api.post<StaffUser & { inviteLink?: string }>('/users', body);
      const link = (res as { inviteLink?: string }).inviteLink;
      toast.success(staff ? 'Staff updated' : link ? 'Invitation sent' : 'Staff member added', link ? { description: link, duration: 15000 } : undefined);
      await qc.invalidateQueries({ queryKey: ['users'] });
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91..." /></Field>
        <Field label={staff ? 'Reset password (optional)' : 'Password (optional)'} hint={staff ? undefined : 'Leave empty to email an invitation'}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium text-slate-600">Roles & branch access</p>
        <div className="space-y-2">
          {assignments.map((a, i) => (
            <div key={i} className="flex gap-2">
              <Select value={a.roleId} onChange={(e) => setAssignments((prev) => prev.map((p, j) => (j === i ? { ...p, roleId: e.target.value } : p)))}>
                <option value="">Select role</option>
                {roles?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
              <Select
                value={a.branchId ?? ''}
                onChange={(e) => setAssignments((prev) => prev.map((p, j) => (j === i ? { ...p, branchId: e.target.value || null } : p)))}
              >
                <option value="">All branches</option>
                {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
              <Button variant="ghost" size="icon" onClick={() => setAssignments((prev) => prev.filter((_, j) => j !== i))} disabled={assignments.length === 1}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setAssignments((p) => [...p, { roleId: '', branchId: null }])}>
            <Plus className="h-3.5 w-3.5" /> Add role
          </Button>
        </div>
      </div>
      <Checkbox label="This person delivers therapy sessions (create therapist profile)" checked={isTherapist} onChange={(e) => setIsTherapist(e.target.checked)} disabled={!!staff?.therapist} />
      {staff && (
        <Field label="Account status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="DISABLED">Disabled</option>
          </Select>
        </Field>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button onClick={save} loading={busy} disabled={!name}>Save</Button>
      </div>
    </div>
  );
}

function RoleForm({ role, onDone }: { role?: RoleLite; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: permissions } = useQuery({
    queryKey: ['permissions'],
    queryFn: () => api.get<{ code: string; module: string }[]>('/permissions'),
  });
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const grouped = useMemo(() => {
    const map = new Map<string, string[]>();
    permissions?.forEach((p) => map.set(p.module, [...(map.get(p.module) ?? []), p.code]));
    return [...map.entries()];
  }, [permissions]);

  const toggle = (code: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  const save = async () => {
    setBusy(true);
    try {
      const body = { name, description, permissions: [...selected] };
      if (role) await api.patch(`/roles/${role.id}`, body);
      else await api.post('/roles', body);
      toast.success('Role saved');
      await qc.invalidateQueries({ queryKey: ['roles'] });
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Role name"><Input value={name} onChange={(e) => setName(e.target.value)} disabled={role?.key === 'OWNER'} /></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {grouped.map(([module, codes]) => (
          <div key={module} className="rounded-lg border border-slate-200 p-3">
            <p className="mb-2 text-xs font-semibold uppercase text-slate-500">{module}</p>
            <div className="space-y-1">
              {codes.map((c) => (
                <Checkbox key={c} label={<span className="font-mono text-xs">{c}</span>} checked={selected.has(c)} onChange={() => toggle(c)} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button onClick={save} loading={busy} disabled={!name || !selected.size || role?.key === 'OWNER'}>Save role</Button>
      </div>
    </div>
  );
}

export default function StaffPage() {
  const user = useAuth((s) => s.user);
  const canManage = hasPermission(user, PERMISSIONS.USER_MANAGE);
  const canManageRoles = hasPermission(user, PERMISSIONS.ROLE_MANAGE);
  const [tab, setTab] = useState<'staff' | 'roles'>('staff');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<StaffUser | null | undefined>(undefined);
  const [editingRole, setEditingRole] = useState<RoleLite | null | undefined>(undefined);
  const [deleteRole, setDeleteRole] = useState<RoleLite | null>(null);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['users', page, search],
    queryFn: () => api.page<StaffUser>('/users', { page, search, pageSize: 25 }),
  });
  const { data: roles } = useRoles();

  return (
    <div>
      <PageHeader
        title="Staff & Roles"
        description="Manage team members, their roles and which branches they can access."
        actions={
          tab === 'staff'
            ? canManage && <Button onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> Add staff</Button>
            : canManageRoles && <Button onClick={() => setEditingRole(null)}><Plus className="h-4 w-4" /> New role</Button>
        }
      />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'staff', label: 'Staff' }, { value: 'roles', label: 'Roles & permissions' }]} />
      {tab === 'staff' ? (
        <Card>
          <div className="border-b border-slate-100 p-3">
            <Input placeholder="Search by name, email or phone" className="max-w-sm" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          {isLoading ? (
            <LoadingBlock />
          ) : (
            <>
              <Table>
                <THead><TR><TH>Name</TH><TH>Roles</TH><TH>Status</TH><TH>Last login</TH><TH /></TR></THead>
                <TBody>
                  {data?.items.map((u) => (
                    <TR key={u.id}>
                      <TD>
                        <p className="font-medium text-slate-900">{u.name} {u.therapist && <Badge tone="purple" className="ml-1">Therapist {u.therapist.employeeCode}</Badge>}</p>
                        <p className="text-xs text-slate-500">{u.email ?? u.phone}</p>
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          {u.userRoles.map((ur, i) => (
                            <Badge key={i} tone="brand">{ur.role.name}{ur.branch ? ` · ${ur.branch.name}` : ''}</Badge>
                          ))}
                        </div>
                      </TD>
                      <TD><StatusBadge status={u.status} /></TD>
                      <TD className="text-xs text-slate-500">{u.lastLoginAt ? ago(u.lastLoginAt) : 'Never'}</TD>
                      <TD className="text-right">
                        {canManage && (
                          <>
                            {u.status === 'INVITED' && (
                              <Button size="sm" variant="ghost" onClick={async () => {
                                try { await api.post(`/users/${u.id}/resend-invite`); toast.success('Invitation re-sent'); } catch (e) { toast.error(errorMessage(e)); }
                              }}>Resend invite</Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setEditing(u)}><Pencil className="h-4 w-4" /></Button>
                          </>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <Pagination page={page} totalPages={data?.meta.totalPages ?? 1} onChange={setPage} />
            </>
          )}
        </Card>
      ) : (
        <Card>
          <Table>
            <THead><TR><TH>Role</TH><TH>Permissions</TH><TH>Staff</TH><TH /></TR></THead>
            <TBody>
              {roles?.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <p className="font-medium text-slate-900">{r.name} {r.isSystem && <Badge className="ml-1">System</Badge>}</p>
                    <p className="text-xs text-slate-500">{r.description}</p>
                  </TD>
                  <TD className="text-xs">{r.permissions.length} permissions</TD>
                  <TD>{r.userCount}</TD>
                  <TD className="text-right">
                    {canManageRoles && r.key !== 'OWNER' && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditingRole(r)}><Pencil className="h-4 w-4" /></Button>
                        {!r.isSystem && <Button size="sm" variant="ghost" onClick={() => setDeleteRole(r)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>}
                      </>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? `Edit ${editing.name}` : 'Add staff member'} size="lg">
        <StaffForm staff={editing ?? undefined} onDone={() => setEditing(undefined)} />
      </Modal>
      <Modal open={editingRole !== undefined} onClose={() => setEditingRole(undefined)} title={editingRole ? `Edit role: ${editingRole.name}` : 'New role'} size="xl">
        <RoleForm role={editingRole ?? undefined} onDone={() => setEditingRole(undefined)} />
      </Modal>
      <ConfirmDialog
        open={!!deleteRole}
        onClose={() => setDeleteRole(null)}
        title="Delete role"
        message={`Delete the "${deleteRole?.name}" role?`}
        danger
        confirmLabel="Delete"
        onConfirm={async () => {
          try {
            await api.delete(`/roles/${deleteRole!.id}`);
            await qc.invalidateQueries({ queryKey: ['roles'] });
            setDeleteRole(null);
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      />
    </div>
  );
}
