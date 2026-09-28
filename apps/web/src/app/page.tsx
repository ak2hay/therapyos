'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LoadingBlock } from '@therapyos/ui';
import { useAuth } from '@/lib/auth-store';

export default function Home() {
  const { status, user } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
    if (status === 'authenticated') router.replace(user?.isPlatformAdmin ? '/admin' : '/dashboard');
  }, [status, user, router]);
  return (
    <div className="flex min-h-screen items-center justify-center">
      <LoadingBlock />
    </div>
  );
}
