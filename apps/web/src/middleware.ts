import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const CACHE_MS = 5 * 60_000;

/** Hosts that serve the TherapyOS app itself; anything else is treated as a tenant's custom domain. */
const platformHosts = new Set(
  [
    'localhost',
    '127.0.0.1',
    process.env.APP_URL ? new URL(process.env.APP_URL).hostname : '',
    ...(process.env.PLATFORM_HOSTS ?? '').split(','),
  ]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

const domainCache = new Map<string, { slug: string | null; at: number }>();

async function resolveDomain(host: string): Promise<string | null> {
  const hit = domainCache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.slug;
  let slug: string | null = null;
  try {
    const res = await fetch(`${API_URL}/api/v1/public/branding?domain=${encodeURIComponent(host)}`, { cache: 'no-store' });
    if (res.ok) slug = ((await res.json()) as { data?: { slug?: string } }).data?.slug ?? null;
  } catch {
    return null;
  }
  domainCache.set(host, { slug, at: Date.now() });
  return slug;
}

/**
 * White-label custom domains: `book.example.com/` renders that tenant's public booking page.
 * Other paths (feedback links, sign-in) keep working on the custom domain unchanged.
 */
export async function middleware(req: NextRequest) {
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
  if (!host || platformHosts.has(host) || host.endsWith('.localhost')) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (pathname !== '/' && pathname !== '/book') return NextResponse.next();
  const slug = await resolveDomain(host);
  if (!slug) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = `/book/${slug}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ['/', '/book'],
};
