'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Field, Input, LoadingBlock } from '@therapyos/ui';
import { registerSchema } from '@therapyos/validation';
import { api, ApiError, errorMessage } from '@/lib/api';
import { applySession, type SessionUser } from '@/lib/auth-store';
import { useZodForm } from '@/lib/forms';

interface PublicPlatform {
  platformName: string;
  supportEmail: string;
  supportPhone: string;
  allowSelfSignup: boolean;
  trialDays: number;
}

function SignupClosed({ platform }: { platform?: PublicPlatform }) {
  return (
    <div data-testid="signup-closed">
      <h2 className="text-2xl font-semibold text-slate-900">Get started with {platform?.platformName ?? 'TherapyOS'}</h2>
      <p className="mt-2 text-sm text-slate-600">We set up every new business personally. Contact us and we will create your account and share your sign-in details.</p>
      <div className="mt-6 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
        {platform?.supportEmail && <p>Email: <a className="font-medium text-brand-700 hover:underline" href={`mailto:${platform.supportEmail}`}>{platform.supportEmail}</a></p>}
        {platform?.supportPhone && <p>Phone / WhatsApp: <a className="font-medium text-brand-700 hover:underline" href={`tel:${platform.supportPhone.replace(/\s/g, '')}`}>{platform.supportPhone}</a></p>}
        {!platform?.supportEmail && !platform?.supportPhone && <p>Please reach out to your Rkyves contact.</p>}
      </div>
      <p className="mt-6 text-center text-sm text-slate-500">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link>
      </p>
    </div>
  );
}

export default function RegisterPage() {
  const router = useRouter();
  const platform = useQuery({ queryKey: ['public-platform'], queryFn: () => api.get<PublicPlatform>('/public/platform'), staleTime: 60_000 });
  const [closed, setClosed] = useState(false);
  const form = useZodForm(registerSchema, { businessName: '', ownerName: '', email: '', phone: '', password: '' });
  const { errors, isSubmitting } = form.formState;
  const trialDays = platform.data?.trialDays ?? 14;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const session = await api.post<{ tokens: { accessToken: string; refreshToken: string; expiresIn: number }; user: SessionUser }>(
        '/auth/register',
        values,
      );
      applySession(session);
      toast.success(`Your ${trialDays}-day trial has started`);
      router.replace('/onboarding');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SIGNUP_DISABLED') setClosed(true);
      else toast.error(errorMessage(err));
    }
  });

  if (platform.isLoading) return <LoadingBlock />;
  if (closed || platform.data?.allowSelfSignup === false) return <SignupClosed platform={platform.data} />;

  return (
    <div>
      <h2 className="text-2xl font-semibold text-slate-900">Create your business</h2>
      <p className="mt-1 text-sm text-slate-500">{trialDays > 0 ? `Start a free ${trialDays}-day trial. No card required.` : 'Set up your business in a few minutes.'}</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <Field label="Business name" error={errors.businessName?.message as string}>
          <Input placeholder="Serenity Wellness" {...form.register('businessName')} />
        </Field>
        <Field label="Your name" error={errors.ownerName?.message as string}>
          <Input {...form.register('ownerName')} />
        </Field>
        <Field label="Email" error={errors.email?.message as string}>
          <Input type="email" {...form.register('email')} />
        </Field>
        <Field label="Phone" error={errors.phone?.message as string}>
          <Input placeholder="+91..." {...form.register('phone')} />
        </Field>
        <Field label="Password" error={errors.password?.message as string} hint="At least 8 characters with a letter and a number">
          <Input type="password" autoComplete="new-password" {...form.register('password')} />
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand-700 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
