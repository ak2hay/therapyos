'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button, Field, Input, Select, Tabs } from '@therapyos/ui';
import { loginSchema } from '@therapyos/validation';
import { api, ApiError, errorMessage } from '@/lib/api';
import { applySession, useAuth, type SessionUser } from '@/lib/auth-store';
import { useZodForm } from '@/lib/forms';

type Session = { tokens: { accessToken: string; refreshToken: string; expiresIn: number }; user: SessionUser };
type TenantChoice = { slug: string; name: string };

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { status, user } = useAuth();
  const [mode, setMode] = useState<'password' | 'otp'>('password');
  const [tenants, setTenants] = useState<TenantChoice[] | null>(null);
  const [tenantSlug, setTenantSlug] = useState('');
  const [phone, setPhone] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useZodForm(loginSchema, { identifier: '', password: '' });

  useEffect(() => {
    if (status === 'authenticated' && user) router.replace(user.isPlatformAdmin ? '/admin' : params.get('next') || '/dashboard');
  }, [status, user, router, params]);

  const handle = async (fn: () => Promise<Session>) => {
    setBusy(true);
    try {
      const session = await fn();
      applySession(session);
      toast.success(`Welcome back, ${session.user.name.split(' ')[0]}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TENANT_REQUIRED') {
        const list = (err.details as { tenants: TenantChoice[] }).tenants;
        setTenants(list);
        setTenantSlug(list[0]?.slug ?? '');
        toast.info(err.message);
      } else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onPassword = form.handleSubmit((values) =>
    handle(() => api.post<Session>('/auth/login', { ...values, tenantSlug: tenantSlug || undefined })),
  );

  const sendOtp = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ sent: boolean; devCode?: string }>('/auth/send-otp', { phone, tenantSlug: tenantSlug || undefined });
      setOtpSent(true);
      toast.success(res.devCode ? `Code sent (dev code: ${res.devCode})` : 'Code sent to your phone');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-semibold text-slate-900">Sign in</h2>
      <p className="mt-1 text-sm text-slate-500">Access your TherapyOS workspace.</p>

      <Tabs
        className="mt-6"
        value={mode}
        onChange={setMode}
        tabs={[
          { value: 'password', label: 'Email / password' },
          { value: 'otp', label: 'Phone OTP' },
        ]}
      />

      {tenants && (
        <Field label="Business" className="mt-4">
          <Select value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value)}>
            {tenants.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {mode === 'password' ? (
        <form onSubmit={onPassword} className="mt-4 space-y-4">
          <Field label="Email or phone" error={form.formState.errors.identifier?.message as string}>
            <Input autoComplete="username" placeholder="you@business.com" {...form.register('identifier')} />
          </Field>
          <Field label="Password" error={form.formState.errors.password?.message as string}>
            <Input type="password" autoComplete="current-password" {...form.register('password')} />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Sign in
          </Button>
        </form>
      ) : (
        <div className="mt-4 space-y-4">
          <Field label="Phone number">
            <Input placeholder="+919800000001" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={otpSent} />
          </Field>
          {otpSent && (
            <Field label="6 digit code">
              <Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
          )}
          {otpSent ? (
            <Button
              className="w-full"
              loading={busy}
              onClick={() => handle(() => api.post<Session>('/auth/verify-otp', { phone, code, tenantSlug: tenantSlug || undefined }))}
            >
              Verify & sign in
            </Button>
          ) : (
            <Button className="w-full" loading={busy} onClick={sendOtp} disabled={phone.length < 8}>
              Send code
            </Button>
          )}
        </div>
      )}

      <p className="mt-6 text-center text-sm text-slate-500">
        New to TherapyOS?{' '}
        <Link href="/register" className="font-medium text-brand-700 hover:underline">
          Create your business
        </Link>
      </p>
      <p className="mt-2 text-center text-xs text-slate-400">
        <Link href="/admin/login" className="hover:underline">
          Rkyves admin
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
