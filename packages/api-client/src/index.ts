import type { ApiResponse, PageMeta } from '@therapyos/types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken: () => string | null | undefined;
  /** Called when the access token is rejected; should refresh and return the new token (or null). */
  refresh?: () => Promise<string | null>;
  onUnauthorized?: () => void;
}

export type Query = Record<string, string | number | boolean | undefined | null | string[]>;

export interface Paged<T> {
  items: T[];
  meta: PageMeta;
}

const RETRYABLE_AUTH_CODES = new Set(['TOKEN_EXPIRED', 'PERMISSIONS_CHANGED', 'UNAUTHENTICATED']);

export function toQueryString(query?: Query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => params.append(k, item));
    else params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export class ApiClient {
  private refreshing: Promise<string | null> | null = null;

  constructor(private readonly opts: ApiClientOptions) {}

  private async raw(method: string, path: string, body?: unknown, query?: Query, retry = true): Promise<Response> {
    const token = this.opts.getAccessToken();
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const res = await fetch(`${this.opts.baseUrl}${path}${toQueryString(query)}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });

    if (res.status === 401 && retry && this.opts.refresh && token) {
      const clone = res.clone();
      const payload = (await clone.json().catch(() => null)) as { error?: { code?: string } } | null;
      if (RETRYABLE_AUTH_CODES.has(payload?.error?.code ?? '')) {
        this.refreshing ??= this.opts.refresh().finally(() => (this.refreshing = null));
        const next = await this.refreshing;
        if (next) return this.raw(method, path, body, query, false);
        this.opts.onUnauthorized?.();
      }
    }
    return res;
  }

  private async parse<T>(res: Response): Promise<{ data: T; meta?: PageMeta }> {
    const json = (await res.json().catch(() => null)) as (ApiResponse<T> & { meta?: PageMeta }) | null;
    if (!json) throw new ApiError(res.status, 'NETWORK_ERROR', `Unexpected response (${res.status})`);
    if (!json.success) {
      throw new ApiError(res.status, json.error.code, json.error.message, json.error.details, json.requestId);
    }
    return { data: json.data, meta: json.meta };
  }

  async request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const res = await this.raw(method, path, body, query);
    return (await this.parse<T>(res)).data;
  }

  get<T>(path: string, query?: Query) {
    return this.request<T>('GET', path, undefined, query);
  }
  post<T>(path: string, body?: unknown, query?: Query) {
    return this.request<T>('POST', path, body ?? {}, query);
  }
  patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body ?? {});
  }
  put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, body ?? {});
  }
  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }

  async page<T>(path: string, query?: Query): Promise<Paged<T>> {
    const res = await this.raw('GET', path, undefined, query);
    const { data, meta } = await this.parse<T[]>(res);
    return { items: data, meta: meta ?? { page: 1, pageSize: data.length, total: data.length, totalPages: 1 } };
  }

  /** Downloads a binary response (PDF, CSV, XLSX) as a Blob. */
  async download(path: string, query?: Query): Promise<{ blob: Blob; filename: string }> {
    const res = await this.raw('GET', path, undefined, query);
    if (!res.ok) await this.parse(res);
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'download';
    return { blob: await res.blob(), filename };
  }
}
