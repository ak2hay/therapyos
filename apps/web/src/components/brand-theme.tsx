'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { hasFeature, useAuth } from '@/lib/auth-store';

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(hex: string, target: number[], weight: number) {
  const rgb = hexToRgb(hex);
  const out = rgb.map((c, i) => Math.round(c + (target[i] - c) * weight));
  return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Applies tenant white-label colours by overriding the brand CSS variables. */
export function applyBrandColor(primary: string | null | undefined) {
  const root = document.documentElement;
  const keys = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
  if (!primary) {
    keys.forEach((k) => root.style.removeProperty(`--brand-${k}`));
    return;
  }
  const white = [255, 255, 255];
  const black = [0, 0, 0];
  const scale: Record<string, string> = {
    '50': mix(primary, white, 0.92),
    '100': mix(primary, white, 0.84),
    '200': mix(primary, white, 0.68),
    '300': mix(primary, white, 0.5),
    '400': mix(primary, white, 0.25),
    '500': mix(primary, white, 0.1),
    '600': primary,
    '700': mix(primary, black, 0.15),
    '800': mix(primary, black, 0.3),
    '900': mix(primary, black, 0.45),
  };
  keys.forEach((k) => root.style.setProperty(`--brand-${k}`, scale[k]));
}

export function BrandTheme() {
  const user = useAuth((s) => s.user);
  const enabled = hasFeature(user, 'WHITE_LABEL');
  const { data } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<{ primaryColor: string | null; appName: string | null } | null>('/branding'),
    enabled,
    retry: false,
  });
  useEffect(() => {
    applyBrandColor(enabled ? data?.primaryColor : null);
    if (enabled && data?.appName) document.title = data.appName;
  }, [data, enabled]);
  return null;
}
