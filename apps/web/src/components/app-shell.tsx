'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, LogOut, Menu, UserCircle2, X } from 'lucide-react';
import { cn, Select } from '@therapyos/ui';
import { hasFeature, hasPermission, logout, useAuth } from '@/lib/auth-store';
import { useBranch } from '@/lib/branch-store';
import { NAV, type NavItem } from '@/lib/nav';
import { NotificationBell } from './notification-bell';
import { BrandTheme } from './brand-theme';

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
        active ? 'bg-brand-600/10 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function BranchSelector() {
  const user = useAuth((s) => s.user);
  const { branchId, setBranch } = useBranch();
  const branches = useMemo(() => user?.branches ?? [], [user]);

  useEffect(() => {
    if (!user) return;
    const valid = branchId && branches.some((b) => b.id === branchId);
    if (!valid && (!user.allBranches || branches.length === 1)) setBranch(branches[0]?.id ?? null);
    if (branchId && !valid && user.allBranches && branches.length > 1) setBranch(null);
  }, [user, branchId, branches, setBranch]);

  if (branches.length <= 1) {
    return branches[0] ? <span className="text-sm font-medium text-slate-700">{branches[0].name}</span> : null;
  }
  return (
    <Select value={branchId ?? ''} onChange={(e) => setBranch(e.target.value || null)} className="h-8 w-52 text-xs" aria-label="Working branch">
      {user?.allBranches && <option value="">All branches</option>}
      {branches.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </Select>
  );
}

function UserMenu() {
  const user = useAuth((s) => s.user);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-slate-100">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
          {user?.name?.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block text-xs font-medium text-slate-900">{user?.name}</span>
          <span className="block text-[11px] text-slate-500">{user?.roleNames?.join(', ')}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          <Link href="/profile" className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setOpen(false)}>
            <UserCircle2 className="h-4 w-4" /> My profile
          </Link>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-rose-600 hover:bg-rose-50"
            onClick={async () => {
              await logout();
              router.replace('/login');
            }}
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  const [mobileOpen, setMobileOpen] = useState(false);

  const sections = useMemo(
    () =>
      NAV.map((s) => ({
        ...s,
        items: s.items.filter((i) => hasPermission(user, i.perm) && hasFeature(user, i.feature)),
      })).filter((s) => s.items.length),
    [user],
  );

  const sidebar = (
    <nav className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">T</div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{user?.tenantName ?? 'TherapyOS'}</p>
          <p className="text-[11px] text-slate-500">TherapyOS by Rkyves</p>
        </div>
      </div>
      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {sections.map((s, i) => (
          <div key={s.title ?? i}>
            {s.title && <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{s.title}</p>}
            <div className="space-y-0.5">
              {s.items.map((item) => (
                <NavLink key={item.href} item={item} onNavigate={() => setMobileOpen(false)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <BrandTheme />
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-slate-200 bg-white lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">
            <button className="absolute right-2 top-3 p-2" onClick={() => setMobileOpen(false)} aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <button className="rounded p-1.5 hover:bg-slate-100 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </button>
            <BranchSelector />
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
