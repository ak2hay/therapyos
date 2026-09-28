'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { cn } from '@therapyos/ui';
import { logout, useAuth } from '@/lib/auth-store';
import { ADMIN_NAV } from '@/lib/nav';

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuth((s) => s.user);
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col bg-slate-900 text-slate-300 lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-slate-800 px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">R</div>
          <div>
            <p className="text-sm font-semibold text-white">Rkyves Admin</p>
            <p className="text-[11px] text-slate-400">TherapyOS platform</p>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-3">
          {ADMIN_NAV.map((item) => {
            const active = item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn('flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm', active ? 'bg-slate-800 text-white' : 'hover:bg-slate-800/60 hover:text-white')}
              >
                <Icon className="h-4 w-4" /> {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-800 p-3 text-xs">
          <p className="truncate text-slate-400">{user?.email}</p>
          <button
            className="mt-2 flex items-center gap-2 text-rose-300 hover:text-rose-200"
            onClick={async () => {
              await logout();
              router.replace('/admin/login');
            }}
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:pl-62">{children}</main>
    </div>
  );
}
