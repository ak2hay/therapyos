'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button, Field, Input } from '@therapyos/ui';
import { registerSchema } from '@therapyos/validation';
import { api, errorMessage } from '@/lib/api';
import { applySession, type SessionUser } from '@/lib/auth-store';
import { useZodForm } from '@/lib/forms';

export default function RegisterPage() {
  const router = useRouter();
  const form = useZodForm(registerSchema, { businessName: '', ownerName: '', email: '', phone: '', password: '' });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const session = await api.post<{ tokens: { accessToken: string; refreshToken: string; expiresIn: number }; user: SessionUser }>(
        '/auth/register',
        values,
      );
      applySession(session);
      toast.success('Your 14-day trial has started');
      router.replace('/onboarding');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  });

  return (
    <div>
      <h2 className="text-2xl font-semibold text-slate-900">Create your business</h2>
      <p className="mt-1 text-sm text-slate-500">Start a free 14-day trial. No card required.</p>
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
