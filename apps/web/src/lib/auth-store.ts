'use client';
import { create } from 'zustand';
import type { AuthUser } from '@therapyos/types';

export interface SessionUser extends AuthUser {
  roleNames?: string[];
  branches?: { id: string; name: string; code: string; status: string }[];
  onboardingStep?: number;
  onboardingCompleted?: boolean;
  currency?: string;
  timezone?: string;
  logoUrl?: string | null;
  businessType?: string;
  suspendedReason?: string | null;
}

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  accessToken: string | null;
  user: SessionUser | null;
  status: Status;
  setSession: (token: string, user: SessionUser) => void;
  setUser: (user: SessionUser) => void;
  clear: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  status: 'loading',
  setSession: (accessToken, user) => set({ accessToken, user, status: 'authenticated' }),
  setUser: (user) => set({ user }),
  clear: () => set({ accessToken: null, user: null, status: 'anonymous' }),
}));

export const hasPermission = (user: SessionUser | null, perm?: string | string[]) => {
  if (!perm) return true;
  if (!user) return false;
  const list = Array.isArray(perm) ? perm : [perm];
  return list.some((p) => user.permissions.includes(p));
};

export const hasFeature = (user: SessionUser | null, feature?: string) => !feature || !!user?.features.includes(feature);

interface SessionPayload {
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
  user: SessionUser;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRefresh(expiresIn: number) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshSession(), Math.max(30, expiresIn - 60) * 1000);
}

export function applySession(payload: SessionPayload) {
  useAuth.getState().setSession(payload.tokens.accessToken, payload.user);
  scheduleRefresh(payload.tokens.expiresIn);
}

let inflight: Promise<string | null> | null = null;

/** Exchanges the httpOnly refresh cookie for a new access token (refresh-token rotation). */
export function refreshSession(): Promise<string | null> {
  inflight ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (!json.success) {
        useAuth.getState().clear();
        return null;
      }
      applySession(json.data);
      return json.data.tokens.accessToken as string;
    } catch {
      useAuth.getState().clear();
      return null;
    } finally {
      setTimeout(() => (inflight = null), 0);
    }
  })();
  return inflight;
}

export async function logout() {
  await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  if (refreshTimer) clearTimeout(refreshTimer);
  useAuth.getState().clear();
}
