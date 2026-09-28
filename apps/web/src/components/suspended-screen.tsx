'use client';
import { LogOut, PauseCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@therapyos/types';
import { Button, Card, CardContent, CardHeader, Textarea } from '@therapyos/ui';
import { SubscriptionTab } from '@/app/(app)/settings/extra-tabs';
import { api, errorMessage } from '@/lib/api';
import { hasPermission, logout, useAuth } from '@/lib/auth-store';

/** Shown instead of the app while the business account is suspended or cancelled. */
export function SuspendedScreen() {
  const user = useAuth((s) => s.user);
  const canPay = hasPermission(user, PERMISSIONS.SUBSCRIPTION_MANAGE);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const lapsed = user?.suspendedReason === 'Subscription lapsed';
  const contact = async () => {
    setBusy(true);
    try {
      await api.post('/support/tickets', { subject: `Account ${user?.tenantStatus === 'CANCELLED' ? 'cancelled' : 'suspended'}: ${user?.tenantName}`, description: message, priority: 'HIGH' });
      setSent(true);
      toast.success('Message sent. Our team will get back to you shortly.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-slate-900">{user?.tenantName}</p>
          <Button variant="ghost" size="sm" onClick={() => void logout()}><LogOut className="h-4 w-4" /> Sign out</Button>
        </div>
        <Card data-testid="suspended-screen">
          <CardContent className="flex items-start gap-4">
            <PauseCircle className="h-10 w-10 shrink-0 text-amber-500" />
            <div>
              <h1 className="text-lg font-semibold text-slate-900">This account is paused</h1>
              <p className="mt-1 text-sm text-slate-600">
                {lapsed
                  ? 'Your TherapyOS subscription has ended. Your data is safe; choose a plan to pick up exactly where you left off.'
                  : `Access has been suspended${user?.suspendedReason ? `: ${user.suspendedReason}` : ''}. Your data is safe.`}
                {!canPay && ' Ask the account owner to renew the subscription.'}
              </p>
            </div>
          </CardContent>
        </Card>
        {canPay && <SubscriptionTab />}
        <Card>
          <CardHeader title="Talk to us" description="Questions about billing or the suspension? Send us a message and we will reply by email and in the app." />
          <CardContent className="space-y-2">
            {sent ? <p className="text-sm text-emerald-700">Thanks, we have your message.</p> : (
              <>
                <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="How can we help?" />
                <Button onClick={contact} loading={busy} disabled={message.trim().length < 3}>Send message</Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
