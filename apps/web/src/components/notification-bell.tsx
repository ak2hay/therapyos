'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Bell, CalendarClock, Package, Star, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';

interface InApp {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

const ICONS: Record<string, typeof Bell> = {
  STOCK_LOW: Package,
  LOW_RATING: Star,
  DAILY_SUMMARY: TrendingUp,
  REMINDER: CalendarClock,
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['in-app-notifications'],
    queryFn: () => api.get<{ items: InApp[]; unread: number }>('/notifications/in-app'),
    refetchInterval: 120_000,
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['in-app-notifications'] });
  useRealtime(['notification'], (_evt, payload) => {
    const n = payload as Partial<InApp>;
    if (n?.title) toast(n.title, { description: n.body });
    void refresh();
  });
  const markAll = useMutation({ mutationFn: () => api.post('/notifications/in-app/read-all'), onSuccess: refresh });
  const markOne = (n: InApp) => {
    setOpen(false);
    if (!n.readAt) void api.post(`/notifications/in-app/${n.id}/read`).then(refresh, () => undefined);
  };
  const unread = data?.unread ?? 0;

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Notifications">
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span data-testid="unread-count" className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-96 rounded-lg border border-slate-200 bg-white shadow-lg" onMouseLeave={() => setOpen(false)}>
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-semibold">Alerts</span>
            {unread > 0 && (
              <button className="text-xs text-brand-700 hover:underline" onClick={() => markAll.mutate()}>
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[28rem] overflow-y-auto">
            {!data?.items.length && <p className="px-3 py-6 text-center text-sm text-slate-500">You&apos;re all caught up.</p>}
            {data?.items.map((n) => {
              const Icon = ICONS[n.type] ?? AlertTriangle;
              return (
                <Link
                  key={n.id}
                  href={n.link ?? '#'}
                  onClick={() => markOne(n)}
                  className={`flex gap-2.5 border-b border-slate-50 px-3 py-2.5 hover:bg-slate-50 ${n.readAt ? '' : 'bg-brand-50/40'}`}
                >
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${n.type === 'LOW_RATING' ? 'text-rose-500' : n.type === 'STOCK_LOW' ? 'text-amber-500' : 'text-brand-600'}`} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{n.title}</p>
                    <p className="text-xs text-slate-600">{n.body}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">{ago(n.createdAt)}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
