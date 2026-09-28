import { resolve } from 'path';
import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const standalone = process.env.NEXT_OUTPUT === 'standalone';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@therapyos/ui', '@therapyos/api-client'],
  poweredByHeader: false,
  output: standalone ? 'standalone' : undefined,
  outputFileTracingRoot: standalone ? resolve(process.cwd(), '../..') : undefined,
  async rewrites() {
    // Same-origin proxy so the httpOnly refresh cookie stays first-party.
    return [{ source: '/api/v1/:path*', destination: `${API_URL}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
