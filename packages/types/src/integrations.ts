export const INTEGRATION_PROVIDERS = ['RAZORPAY', 'MSG91', 'WHATSAPP_CLOUD', 'SMTP', 'OPENAI'] as const;
export type IntegrationProviderKey = (typeof INTEGRATION_PROVIDERS)[number];

/** Providers a business may override with its own account; the rest are platform-only. */
export const TENANT_INTEGRATIONS: IntegrationProviderKey[] = ['RAZORPAY', 'MSG91', 'WHATSAPP_CLOUD', 'SMTP'];

export type IntegrationSource = 'tenant' | 'platform' | 'env' | 'mock';

export interface IntegrationField {
  key: string;
  label: string;
  /** Stored encrypted and never returned by the API. */
  secret?: boolean;
  required?: boolean;
  type?: 'text' | 'number' | 'boolean';
  placeholder?: string;
  help?: string;
  defaultValue?: string | number | boolean;
}

export interface IntegrationDefinition {
  provider: IntegrationProviderKey;
  name: string;
  description: string;
  fields: IntegrationField[];
  docsUrl?: string;
}

export const INTEGRATIONS: Record<IntegrationProviderKey, IntegrationDefinition> = {
  RAZORPAY: {
    provider: 'RAZORPAY',
    name: 'Razorpay',
    description: 'Online payments for invoices, the customer app and (platform only) SaaS subscriptions.',
    docsUrl: 'https://dashboard.razorpay.com/app/website-app-settings/api-keys',
    fields: [
      { key: 'keyId', label: 'Key ID', required: true, placeholder: 'rzp_live_...' },
      { key: 'keySecret', label: 'Key secret', secret: true, required: true },
      { key: 'webhookSecret', label: 'Webhook secret', secret: true, help: 'The secret you set when adding the webhook in Razorpay (Settings > Webhooks).' },
    ],
  },
  MSG91: {
    provider: 'MSG91',
    name: 'MSG91 SMS',
    description: 'Transactional SMS and login OTPs. Every message needs a DLT-approved MSG91 flow template.',
    docsUrl: 'https://control.msg91.com/app/',
    fields: [
      { key: 'authKey', label: 'Auth key', secret: true, required: true },
      { key: 'senderId', label: 'Sender ID', required: true, placeholder: 'RKYVES', help: '6-letter DLT header approved for your templates.' },
      { key: 'otpTemplateId', label: 'OTP flow template ID', help: 'Flow for login codes. The code is sent as ##otp## and ##var1##.' },
      { key: 'defaultTemplateId', label: 'Fallback flow template ID', help: 'Used when a notification template has no MSG91 template ID. Variables are sent as ##var1##, ##var2##... in placeholder order.' },
    ],
  },
  WHATSAPP_CLOUD: {
    provider: 'WHATSAPP_CLOUD',
    name: 'WhatsApp Cloud API',
    description: 'WhatsApp Business messages via Meta. Reminders and alerts use approved templates.',
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
    fields: [
      { key: 'phoneNumberId', label: 'Phone number ID', required: true },
      { key: 'businessAccountId', label: 'WhatsApp Business account ID' },
      { key: 'accessToken', label: 'Permanent access token', secret: true, required: true },
      { key: 'displayNumber', label: 'Display phone number', placeholder: '+91 98xxxxxxxx' },
      { key: 'defaultLanguage', label: 'Template language', placeholder: 'en', defaultValue: 'en' },
    ],
  },
  SMTP: {
    provider: 'SMTP',
    name: 'Email (SMTP)',
    description: 'Invoices, invites and notification emails through your SMTP server (SES, Postmark, Zoho, Gmail...).',
    fields: [
      { key: 'host', label: 'SMTP host', required: true, placeholder: 'smtp.zeptomail.in' },
      { key: 'port', label: 'Port', type: 'number', required: true, defaultValue: 587 },
      { key: 'user', label: 'Username' },
      { key: 'pass', label: 'Password', secret: true },
      { key: 'fromAddress', label: 'From address', required: true, placeholder: 'no-reply@yourdomain.com' },
      { key: 'fromName', label: 'From name', placeholder: 'TherapyOS' },
    ],
  },
  OPENAI: {
    provider: 'OPENAI',
    name: 'OpenAI',
    description: 'Language model for the AI business assistant. Answers stay grounded in computed figures.',
    docsUrl: 'https://platform.openai.com/api-keys',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true, placeholder: 'sk-...' },
      { key: 'model', label: 'Model', placeholder: 'gpt-4o-mini', defaultValue: 'gpt-4o-mini' },
    ],
  },
};

export interface IntegrationFieldState {
  set: boolean;
  hint: string | null;
}

export interface IntegrationView {
  provider: IntegrationProviderKey;
  enabled: boolean;
  configured: boolean;
  config: Record<string, string | number | boolean | null>;
  secrets: Record<string, IntegrationFieldState>;
  /** Where credentials currently come from for this scope. */
  effectiveSource: IntegrationSource;
  updatedAt: string | null;
}

export interface PlatformSettings {
  platformName: string;
  supportEmail: string;
  supportPhone: string;
  allowSelfSignup: boolean;
  trialPlanCode: string;
  trialDays: number;
  subscriptionGraceDays: number;
  defaultTimezone: string;
  defaultCurrency: string;
  defaultCountry: string;
}
