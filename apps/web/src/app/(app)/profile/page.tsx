'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardContent, CardHeader, Field, Input, PageHeader } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { applySession, useAuth, type SessionUser } from '@/lib/auth-store';

export default function ProfilePage() {
  const user = useAuth((s) => s.user)!;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const change = async () => {
    setBusy(true);
    try {
      const session = await api.post<{ tokens: { accessToken: string; refreshToken: string; expiresIn: number }; user: SessionUser }>(
        '/auth/change-password',
        { currentPassword: current, newPassword: next },
      );
      applySession(session);
      setCurrent('');
      setNext('');
      toast.success('Password updated. Other sessions were signed out.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title="My profile" />
      <Card className="mb-6">
        <CardHeader title={user.name} description={user.email ?? user.phone ?? ''} />
        <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs text-slate-500">Business</p>
            <p className="font-medium">{user.tenantName}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Roles</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {user.roleNames?.map((r) => <Badge key={r} tone="brand">{r}</Badge>)}
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-500">Branch access</p>
            <p className="font-medium">{user.allBranches ? 'All branches' : user.branches?.map((b) => b.name).join(', ')}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Permissions</p>
            <p className="font-medium">{user.permissions.length} granted</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Change password" />
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Current password">
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 8 characters with a letter and a number">
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button onClick={change} loading={busy} disabled={!current || !next}>
              Update password
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
