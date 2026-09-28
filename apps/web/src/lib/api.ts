'use client';
import { ApiClient, ApiError } from '@therapyos/api-client';
import { refreshSession, useAuth } from './auth-store';

export const api = new ApiClient({
  baseUrl: '/api/v1',
  getAccessToken: () => useAuth.getState().accessToken,
  refresh: refreshSession,
  onUnauthorized: () => useAuth.getState().clear(),
});

export { ApiError };

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

/** Maps a validation error's `details` (`[{ path, message }]`) to `{ field: message }`. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  const out: Record<string, string> = {};
  for (const d of err.details as { path?: string; message?: string }[]) {
    if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
  }
  return out;
}

export async function downloadFile(path: string, query?: Record<string, string | undefined>) {
  const { blob, filename } = await api.download(path, query);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
