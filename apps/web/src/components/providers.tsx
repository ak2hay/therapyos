'use client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { refreshSession, useAuth } from '@/lib/auth-store';
import { ApiError } from '@/lib/api';

function SessionBootstrap() {
  const status = useAuth((s) => s.status);
  useEffect(() => {
    if (status === 'loading') void refreshSession();
  }, [status]);
  return null;
}

/** A tenant suspended mid-session: reload the session so the app layout switches to the suspended screen. */
function onSuspended(err: unknown) {
  if (err instanceof ApiError && err.code === 'TENANT_SUSPENDED' && useAuth.getState().user?.tenantStatus === 'ACTIVE') void refreshSession();
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: onSuspended }),
        mutationCache: new MutationCache({ onError: onSuspended }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <SessionBootstrap />
      {children}
      <Toaster richColors position="top-right" closeButton />
    </QueryClientProvider>
  );
}
