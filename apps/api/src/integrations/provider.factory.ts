import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type { IntegrationProviderKey, IntegrationSource } from '@therapyos/types';
import { IntegrationsConfigService, IntegrationValues } from './integrations-config.service';
import { LlmProvider, MockLlmProvider, OpenAiLlmProvider } from './llm.provider';
import {
  CloudWhatsAppProvider,
  EmailProvider,
  GRAPH_URL,
  MockEmailProvider,
  MockSmsProvider,
  MockWhatsAppProvider,
  Msg91SmsProvider,
  SmsProvider,
  SmtpEmailProvider,
  WhatsAppProvider,
} from './messaging.providers';
import { MockPaymentProvider, PaymentProvider, RazorpayPaymentProvider } from './payment.provider';

const MAX_CACHED = 200;
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

export interface IntegrationTestResult {
  ok: boolean;
  message: string;
}

/** Builds provider instances from resolved credentials, reusing one instance per credential set. */
@Injectable()
export class ProviderFactory {
  private readonly instances = new Map<string, unknown>();
  readonly mockSms = new MockSmsProvider();
  readonly mockEmail = new MockEmailProvider();
  readonly mockWhatsApp = new MockWhatsAppProvider();
  readonly mockPayments = new MockPaymentProvider();
  readonly mockLlm = new MockLlmProvider();

  constructor(private readonly config: IntegrationsConfigService) {}

  private cached<T>(provider: IntegrationProviderKey, values: IntegrationValues, build: () => T): T {
    const key = createHash('sha256').update(provider).update(JSON.stringify(values)).digest('hex');
    const hit = this.instances.get(key);
    if (hit) return hit as T;
    if (this.instances.size >= MAX_CACHED) this.instances.clear();
    const inst = build();
    this.instances.set(key, inst);
    return inst;
  }

  build(provider: 'RAZORPAY', values: IntegrationValues): RazorpayPaymentProvider;
  build(provider: 'MSG91', values: IntegrationValues): Msg91SmsProvider;
  build(provider: 'WHATSAPP_CLOUD', values: IntegrationValues): CloudWhatsAppProvider;
  build(provider: 'SMTP', values: IntegrationValues): SmtpEmailProvider;
  build(provider: 'OPENAI', values: IntegrationValues): OpenAiLlmProvider;
  build(provider: IntegrationProviderKey, values: IntegrationValues): unknown;
  build(provider: IntegrationProviderKey, v: IntegrationValues): unknown {
    return this.cached(provider, v, () => {
      switch (provider) {
        case 'RAZORPAY':
          return new RazorpayPaymentProvider({ keyId: String(v.keyId), keySecret: String(v.keySecret), webhookSecret: str(v.webhookSecret) });
        case 'MSG91':
          return new Msg91SmsProvider({ authKey: String(v.authKey), senderId: str(v.senderId), otpTemplateId: str(v.otpTemplateId), defaultTemplateId: str(v.defaultTemplateId) });
        case 'WHATSAPP_CLOUD':
          return new CloudWhatsAppProvider({ phoneNumberId: String(v.phoneNumberId), accessToken: String(v.accessToken), defaultLanguage: str(v.defaultLanguage) });
        case 'SMTP':
          return new SmtpEmailProvider({ host: String(v.host), port: Number(v.port ?? 587), user: str(v.user), pass: str(v.pass), fromAddress: String(v.fromAddress), fromName: str(v.fromName) });
        case 'OPENAI':
          return new OpenAiLlmProvider({ apiKey: String(v.apiKey), model: str(v.model) ?? 'gpt-4o-mini' });
      }
    });
  }

  async sms(tenantId: string | null | undefined): Promise<SmsProvider> {
    const r = await this.config.resolve('MSG91', tenantId);
    return r ? this.build('MSG91', r.values) : this.mockSms;
  }

  async whatsapp(tenantId: string | null | undefined): Promise<WhatsAppProvider> {
    const r = await this.config.resolve('WHATSAPP_CLOUD', tenantId);
    return r ? this.build('WHATSAPP_CLOUD', r.values) : this.mockWhatsApp;
  }

  async email(tenantId: string | null | undefined): Promise<EmailProvider> {
    const r = await this.config.resolve('SMTP', tenantId);
    return r ? this.build('SMTP', r.values) : this.mockEmail;
  }

  async llm(): Promise<LlmProvider> {
    const r = await this.config.resolve('OPENAI', null);
    return r ? this.build('OPENAI', r.values) : this.mockLlm;
  }

  /** Gateway for new orders: the business's own Razorpay account, else the platform account, else mock. */
  async payments(tenantId: string | null | undefined): Promise<PaymentProvider> {
    const r = await this.config.resolve('RAZORPAY', tenantId);
    return r ? this.build('RAZORPAY', r.values) : this.mockPayments;
  }

  /**
   * Gateway that created an existing order, found by its stored key id so verification, webhooks
   * and refunds keep working after a business switches accounts.
   */
  async paymentsForKey(tenantId: string | null | undefined, keyId: string | null | undefined, providerName?: string | null): Promise<PaymentProvider> {
    if (providerName === 'mock' || keyId === this.mockPayments.keyId) return this.mockPayments;
    const all = await this.config.candidates('RAZORPAY', tenantId);
    const match = keyId ? all.find((c) => c.values.keyId === keyId) : undefined;
    const chosen = match ?? all[0];
    return chosen ? this.build('RAZORPAY', chosen.values) : this.mockPayments;
  }

  async sources(tenantId: string | null): Promise<Record<string, IntegrationSource>> {
    const keys: IntegrationProviderKey[] = ['RAZORPAY', 'MSG91', 'WHATSAPP_CLOUD', 'SMTP', 'OPENAI'];
    const entries = await Promise.all(keys.map(async (k) => [k, await this.config.source(k, tenantId)] as const));
    return Object.fromEntries(entries);
  }

  /** Checks the credentials that are currently effective for `tenantId` (or the platform). */
  async test(provider: IntegrationProviderKey, tenantId: string | null, to?: string): Promise<IntegrationTestResult> {
    const r = await this.config.resolve(provider, tenantId);
    if (!r) return { ok: false, message: 'Not configured: messages use the mock provider.' };
    const via = r.source === 'tenant' ? 'your own account' : r.source === 'platform' ? 'the platform account' : 'server environment keys';
    try {
      switch (provider) {
        case 'RAZORPAY':
          await this.build('RAZORPAY', r.values).ping();
          return { ok: true, message: `Razorpay keys are valid (${via}).${r.values.webhookSecret ? '' : ' Add the webhook secret so payments confirm even if the customer closes the app.'}` };
        case 'OPENAI':
          await this.build('OPENAI', r.values).ping();
          return { ok: true, message: `OpenAI key is valid (${via}).` };
        case 'SMTP': {
          const smtp = this.build('SMTP', r.values);
          await smtp.transporter.verify();
          if (to) {
            const res = await smtp.send(to, 'TherapyOS test email', '<p>Your email settings work.</p>');
            if (res.status !== 'SENT') return { ok: false, message: `Connected, but sending failed: ${res.error}` };
            return { ok: true, message: `Connected and sent a test email to ${to} (${via}).` };
          }
          return { ok: true, message: `Connected to ${r.values.host} (${via}).` };
        }
        case 'WHATSAPP_CLOUD': {
          const res = await fetch(`${GRAPH_URL}/${r.values.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, {
            headers: { authorization: `Bearer ${r.values.accessToken}` },
          });
          const json = (await res.json()) as { display_phone_number?: string; verified_name?: string; error?: { message: string } };
          if (!res.ok) return { ok: false, message: json.error?.message ?? `Meta API HTTP ${res.status}` };
          if (to) {
            const sent = await this.build('WHATSAPP_CLOUD', r.values).send({ to, body: '', templateName: 'hello_world', language: 'en_US' });
            if (sent.status !== 'SENT') return { ok: false, message: `Number verified, but the test message failed: ${sent.error}` };
          }
          return { ok: true, message: `Connected to ${json.verified_name ?? 'WhatsApp'} ${json.display_phone_number ?? ''} (${via}).${to ? ` Sent the hello_world template to ${to}.` : ''}` };
        }
        case 'MSG91': {
          if (!to) return { ok: true, message: `MSG91 is configured (${via}). Enter a phone number to send a test OTP.` };
          const res = await this.build('MSG91', r.values).send(to, '', { otp: '123456' });
          return res.status === 'SENT' ? { ok: true, message: `Sent a test OTP (123456) to ${to} (${via}).` } : { ok: false, message: res.error ?? 'Sending failed' };
        }
      }
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
