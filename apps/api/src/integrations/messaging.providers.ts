import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

export interface SendResult {
  provider: string;
  messageId?: string;
  status: 'SENT' | 'FAILED';
  error?: string;
}

export interface SmsOptions {
  /** Provider template (MSG91 flow / DLT) id; falls back to the provider default. */
  templateId?: string | null;
  /** Positional variables in placeholder order. */
  params?: string[];
  /** Set for login codes so the provider can use its OTP template. */
  otp?: string;
}

export abstract class SmsProvider {
  abstract readonly name: string;
  abstract send(to: string, body: string, opts?: SmsOptions): Promise<SendResult>;
}

export interface EmailOptions {
  fromName?: string;
  fromAddress?: string;
}

export abstract class EmailProvider {
  abstract readonly name: string;
  abstract send(to: string, subject: string, html: string, opts?: EmailOptions): Promise<SendResult>;
}

export interface WhatsAppMessage {
  to: string;
  body: string;
  templateName?: string;
  templateParams?: string[];
  language?: string;
}

export abstract class WhatsAppProvider {
  abstract readonly name: string;
  abstract send(msg: WhatsAppMessage): Promise<SendResult>;
}

export abstract class PushProvider {
  abstract readonly name: string;
  abstract send(userOrDeviceId: string, title: string, body: string): Promise<SendResult>;
}

/** In-memory outbox of mock messages, exposed in development for easy manual testing. */
export const MOCK_OUTBOX: Array<{ channel: string; to: string; body: string; at: string }> = [];
function recordMock(channel: string, to: string, body: string) {
  MOCK_OUTBOX.unshift({ channel, to, body, at: new Date().toISOString() });
  MOCK_OUTBOX.splice(200);
}

@Injectable()
export class MockSmsProvider extends SmsProvider {
  readonly name = 'mock-sms';
  private readonly logger = new Logger('MockSMS');
  async send(to: string, body: string): Promise<SendResult> {
    this.logger.log(`-> ${to}: ${body}`);
    recordMock('SMS', to, body);
    return { provider: this.name, messageId: `mock_${Date.now()}`, status: 'SENT' };
  }
}

export interface Msg91Credentials {
  authKey: string;
  senderId?: string;
  otpTemplateId?: string;
  defaultTemplateId?: string;
}

/** MSG91 wants digits with the country code; bare 10-digit numbers are Indian. */
function msg91Mobile(to: string) {
  const digits = to.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

/** MSG91 Flow API: Indian SMS must use a DLT-approved template, so free text is never sent. */
export class Msg91SmsProvider extends SmsProvider {
  readonly name = 'msg91';
  constructor(private readonly creds: Msg91Credentials) {
    super();
  }

  static payload(creds: Msg91Credentials, to: string, opts: SmsOptions = {}) {
    const templateId = (opts.otp ? creds.otpTemplateId : opts.templateId) || creds.defaultTemplateId;
    if (!templateId) return null;
    const vars: Record<string, string> = {};
    const params = opts.otp ? [opts.otp] : (opts.params ?? []);
    params.forEach((v, i) => (vars[`var${i + 1}`] = v));
    if (opts.otp) vars.otp = opts.otp;
    return {
      template_id: templateId,
      ...(creds.senderId ? { sender: creds.senderId } : {}),
      short_url: '0',
      recipients: [{ mobiles: msg91Mobile(to), ...vars }],
    };
  }

  async send(to: string, _body: string, opts: SmsOptions = {}): Promise<SendResult> {
    const payload = Msg91SmsProvider.payload(this.creds, to, opts);
    if (!payload) return { provider: this.name, status: 'FAILED', error: 'No MSG91 flow template ID configured for this message' };
    try {
      const res = await fetch('https://control.msg91.com/api/v5/flow', {
        method: 'POST',
        headers: { authkey: this.creds.authKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as { type?: string; message?: string; request_id?: string };
      if (!res.ok || json.type === 'error') return { provider: this.name, status: 'FAILED', error: json.message ?? `HTTP ${res.status}` };
      return { provider: this.name, status: 'SENT', messageId: json.request_id ?? json.message };
    } catch (e) {
      return { provider: this.name, status: 'FAILED', error: (e as Error).message };
    }
  }
}

export interface SmtpCredentials {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  fromAddress: string;
  fromName?: string;
}

export class SmtpEmailProvider extends EmailProvider {
  readonly name = 'smtp';
  readonly transporter: Transporter;
  constructor(private readonly creds: SmtpCredentials) {
    super();
    this.transporter = nodemailer.createTransport({
      host: creds.host,
      port: creds.port,
      secure: creds.port === 465,
      auth: creds.user ? { user: creds.user, pass: creds.pass } : undefined,
    });
  }
  private defaultFrom() {
    return this.creds.fromName ? `${this.creds.fromName} <${this.creds.fromAddress}>` : this.creds.fromAddress;
  }
  async send(to: string, subject: string, html: string, opts?: EmailOptions) {
    try {
      const from = opts?.fromAddress ? `${opts.fromName ?? this.creds.fromName ?? 'TherapyOS'} <${opts.fromAddress}>` : this.defaultFrom();
      const info = await this.transporter.sendMail({ from, to, subject, html });
      return { provider: this.name, status: 'SENT' as const, messageId: info.messageId };
    } catch (e) {
      return { provider: this.name, status: 'FAILED' as const, error: (e as Error).message };
    }
  }
}

@Injectable()
export class MockEmailProvider extends EmailProvider {
  readonly name = 'mock-email';
  private readonly logger = new Logger('MockEmail');
  async send(to: string, subject: string, html: string) {
    this.logger.log(`-> ${to}: ${subject}`);
    recordMock('EMAIL', to, `${subject}\n${html}`);
    return { provider: this.name, status: 'SENT' as const, messageId: `mock_${Date.now()}` };
  }
}

@Injectable()
export class MockWhatsAppProvider extends WhatsAppProvider {
  readonly name = 'mock-whatsapp';
  private readonly logger = new Logger('MockWhatsApp');
  async send(msg: WhatsAppMessage): Promise<SendResult> {
    this.logger.log(`-> ${msg.to}: ${msg.body}`);
    recordMock('WHATSAPP', msg.to, msg.body);
    return { provider: this.name, status: 'SENT', messageId: `wamid.mock_${Date.now()}` };
  }
}

export interface WhatsAppCredentials {
  phoneNumberId: string;
  accessToken: string;
  defaultLanguage?: string;
}

export const GRAPH_URL = 'https://graph.facebook.com/v21.0';

/** WhatsApp Business Cloud API (Meta Graph). Uses approved templates when provided, text otherwise. */
export class CloudWhatsAppProvider extends WhatsAppProvider {
  readonly name = 'whatsapp-cloud';
  constructor(private readonly creds: WhatsAppCredentials) {
    super();
  }
  async send(msg: WhatsAppMessage): Promise<SendResult> {
    const payload = msg.templateName
      ? {
          messaging_product: 'whatsapp',
          to: msg.to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: msg.templateName,
            language: { code: msg.language ?? this.creds.defaultLanguage ?? 'en' },
            components: msg.templateParams?.length
              ? [{ type: 'body', parameters: msg.templateParams.map((text) => ({ type: 'text', text })) }]
              : undefined,
          },
        }
      : { messaging_product: 'whatsapp', to: msg.to.replace(/^\+/, ''), type: 'text', text: { body: msg.body } };
    try {
      const res = await fetch(`${GRAPH_URL}/${this.creds.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.creds.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as { messages?: { id: string }[]; error?: { message: string } };
      if (!res.ok) return { provider: this.name, status: 'FAILED', error: json.error?.message ?? `HTTP ${res.status}` };
      return { provider: this.name, status: 'SENT', messageId: json.messages?.[0]?.id };
    } catch (err) {
      return { provider: this.name, status: 'FAILED', error: (err as Error).message };
    }
  }
}

@Injectable()
export class MockPushProvider extends PushProvider {
  readonly name = 'mock-push';
  private readonly logger = new Logger('MockPush');
  async send(target: string, title: string, body: string): Promise<SendResult> {
    this.logger.log(`-> ${target}: ${title} - ${body}`);
    recordMock('PUSH', target, `${title}: ${body}`);
    return { provider: this.name, status: 'SENT' };
  }
}
