import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: { default: 'TherapyOS by Rkyves', template: '%s | TherapyOS' },
  description: 'Run your entire therapy and wellness business from one platform.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1a7e64' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
