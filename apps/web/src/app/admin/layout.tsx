'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LoadingBlock } from '@therapyos/ui';
import { AdminShell } from '@/components/admin-shell';
import { useAuth } from '@/lib/auth-store';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === 'anonymous') router.replace('/admin/login');
    if (status === 'authenticated' && !user?.isPlatformAdmin) router.replace('/dashboard');
  }, [status, user, router]);
  if (status !== 'authenticated' || !user?.isPlatformAdmin) {
    return <div className="flex min-h-screen items-center justify-center"><LoadingBlock /></div>;
  }
  return <AdminShell>{children}</AdminShell>;
}
