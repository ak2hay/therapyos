'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { Button, Field, Input } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { applySession, type SessionUser } from '@/lib/auth-store';

function AcceptInvite() {
  const params = useSearchParams();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password !== confirm) return toast.error('Passwords do not match');
    setBusy(true);
    try {
      const session = await api.post<{ tokens: { accessToken: string; refreshToken: string; expiresIn: number }; user: SessionUser }>(
        '/auth/accept-invite',
        { token: params.get('token'), password },
      );
      applySession(session);
      router.replace('/dashboard');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-semibold text-slate-900">Join your team</h2>
      <p className="mt-1 text-sm text-slate-500">Set a password to activate your account.</p>
      <div className="mt-6 space-y-4">
        <Field label="Password" hint="At least 8 characters with a letter and a number">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button className="w-full" onClick={submit} loading={busy} disabled={!password}>
          Activate account
        </Button>
      </div>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptInvite />
    </Suspense>
  );
}
