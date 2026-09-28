'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LoadingBlock } from '@therapyos/ui';
import { PERMISSIONS } from '@therapyos/types';
import { AppShell } from '@/components/app-shell';
import { SuspendedScreen } from '@/components/suspended-screen';
import { useAuth } from '@/lib/auth-store';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (status === 'authenticated' && user?.isPlatformAdmin) router.replace('/admin');
    if (
      status === 'authenticated' &&
      user &&
      !user.isPlatformAdmin &&
      !user.onboardingCompleted &&
      user.permissions.includes(PERMISSIONS.TENANT_UPDATE)
    ) {
      router.replace('/onboarding');
    }
  }, [status, user, router, pathname]);

  if (status !== 'authenticated' || !user || user.isPlatformAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingBlock label="Loading your workspace..." />
      </div>
    );
  }
  if (user.tenantStatus === 'SUSPENDED' || user.tenantStatus === 'CANCELLED') return <SuspendedScreen />;
  return <AppShell>{children}</AppShell>;
}
