'use client';
import { PageHeader } from '@therapyos/ui';
import { IntegrationsPanel } from '@/components/integrations-panel';

export default function AdminIntegrationsPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Integrations"
        description="Platform keys for payments, SMS, WhatsApp, email and AI. Every business uses these unless it adds its own account in Settings > Integrations. Secrets are encrypted and never shown again."
      />
      <IntegrationsPanel scope="platform" />
    </div>
  );
}
