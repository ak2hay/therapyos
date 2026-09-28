'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useBranch } from './branch-store';

export interface BranchLite {
  id: string;
  name: string;
  code: string;
  status: string;
  openingTime: string;
  closingTime: string;
}
export interface RoleLite {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  isSystem: boolean;
  userCount: number;
  permissions: string[];
}
export interface ServiceLite {
  id: string;
  name: string;
  durationMinutes: number;
  basePrice: number;
  taxRate: number;
  status: string;
  categoryId: string | null;
  category?: { id: string; name: string } | null;
  color?: string | null;
  description?: string | null;
  branchServices?: { branchId: string; price: number | null; durationMinutes: number | null; isActive: boolean }[];
}
export interface TherapistLite {
  id: string;
  name: string;
  employeeCode: string;
  status: string;
  primaryBranchId: string | null;
  color: string | null;
  specialization: string | null;
  phone?: string | null;
  commissionType?: string;
  commissionValue?: number;
  userId?: string | null;
  services?: { serviceId: string }[];
  schedules?: { branchId: string; dayOfWeek: number; startTime: string; endTime: string }[];
}

export const useBranches = () =>
  useQuery({ queryKey: ['branches'], queryFn: () => api.get<BranchLite[]>('/branches'), staleTime: 60_000 });

export const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleLite[]>('/roles') });

export const useServices = (opts: { branchId?: string | null; activeOnly?: boolean } = {}) =>
  useQuery({
    queryKey: ['services', opts],
    queryFn: () => api.get<ServiceLite[]>('/services', { branchId: opts.branchId ?? undefined, active: opts.activeOnly ? 'true' : undefined }),
    staleTime: 60_000,
  });

export const useTherapists = (opts: { branchId?: string | null; activeOnly?: boolean } = {}) =>
  useQuery({
    queryKey: ['therapists', opts],
    queryFn: () => api.get<TherapistLite[]>('/therapists', { branchId: opts.branchId ?? undefined, active: opts.activeOnly ? 'true' : undefined }),
    staleTime: 60_000,
  });

/** The branch selected in the top bar, or the first accessible branch when an operation needs a concrete branch. */
export function useWorkingBranch(branches?: BranchLite[]) {
  const branchId = useBranch((s) => s.branchId);
  return branchId ?? branches?.[0]?.id ?? null;
}
