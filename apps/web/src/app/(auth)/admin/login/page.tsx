'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button, Field, Input } from '@therapyos/ui';
import { api, errorMessage } from '@/lib/api';
import { applySession, useAuth, type SessionUser } from '@/lib/auth-store';

export default function AdminLoginPage() {
  const router = useRouter();
  const { status, user } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated' && user?.isPlatformAdmin) router.replace('/admin');
  }, [status, user, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const session = await api.post<{ tokens: { accessToken: string; refreshToken: string; expiresIn: number }; user: SessionUser }>(
        '/auth/admin/login',
        { email, password },
      );
      applySession(session);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-semibold text-slate-900">Rkyves platform admin</h2>
      <p className="mt-1 text-sm text-slate-500">Super admin console for the TherapyOS SaaS platform.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
        <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
      </form>
    </div>
  );
}
