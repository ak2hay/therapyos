'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Search, UserPlus, X } from 'lucide-react';
import { Badge, Button, Input } from '@therapyos/ui';
import { api } from '@/lib/api';
import { titleCase } from '@/lib/format';

export interface CustomerHit {
  id: string;
  name: string;
  phone: string;
  email?: string | null;
  customerCode: string;
  metrics?: { segment: string; lastVisitAt: string | null; visitCount: number } | null;
}

export const SEGMENT_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'gray' | 'purple'> = {
  NEW: 'blue',
  ACTIVE: 'green',
  LOYAL: 'purple',
  VIP: 'purple',
  AT_RISK: 'amber',
  INACTIVE: 'gray',
  CHURNED: 'red',
};

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Phone/name search with an inline "new customer" option. When `allowNew` is set and nothing
 * matches, the caller receives the typed name/phone so it can register the customer.
 */
export function CustomerPicker({
  value,
  onChange,
  allowNew,
  onNew,
  autoFocus,
}: {
  value: CustomerHit | null;
  onChange: (c: CustomerHit | null) => void;
  allowNew?: boolean;
  onNew?: (seed: { name: string; phone: string }) => void;
  autoFocus?: boolean;
}) {
  const [term, setTerm] = useState('');
  const q = useDebounced(term.trim());
  const { data, isFetching } = useQuery({
    queryKey: ['customer-lookup', q],
    queryFn: () => api.get<CustomerHit[]>('/customers/lookup', { q }),
    enabled: q.length >= 2 && !value,
  });

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
        <div>
          <p className="text-sm font-medium text-slate-900">
            {value.name} <span className="text-xs text-slate-500">{value.customerCode}</span>
          </p>
          <p className="text-xs text-slate-500">
            {value.phone}
            {value.metrics && ` · ${value.metrics.visitCount} visits`}
          </p>
        </div>
        <button type="button" className="rounded p-1 text-slate-500 hover:bg-white" onClick={() => onChange(null)} aria-label="Change customer">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  const digits = term.replace(/\D/g, '');
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
      <Input autoFocus={autoFocus} className="pl-9" placeholder="Search by phone, name or customer code" value={term} onChange={(e) => setTerm(e.target.value)} />
      {q.length >= 2 && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {isFetching && !data && <p className="px-3 py-2 text-xs text-slate-500">Searching...</p>}
          {data?.map((c) => (
            <button
              type="button"
              key={c.id}
              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50"
              onClick={() => {
                onChange(c);
                setTerm('');
              }}
            >
              <span>
                <span className="block text-sm font-medium text-slate-900">{c.name}</span>
                <span className="block text-xs text-slate-500">
                  {c.phone} · {c.customerCode}
                </span>
              </span>
              {c.metrics && <Badge tone={SEGMENT_TONE[c.metrics.segment] ?? 'gray'}>{titleCase(c.metrics.segment)}</Badge>}
            </button>
          ))}
          {data && data.length === 0 && <p className="px-3 py-2 text-xs text-slate-500">No matching customers.</p>}
          {allowNew && onNew && (
            <div className="border-t border-slate-100 p-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full justify-start"
                onClick={() => onNew(digits.length >= 10 ? { name: '', phone: term.trim() } : { name: term.trim(), phone: '' })}
              >
                <UserPlus className="h-4 w-4" /> New customer &quot;{term.trim()}&quot;
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
