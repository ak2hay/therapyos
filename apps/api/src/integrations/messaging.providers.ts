import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';

export interface SendResult {
  provider: string;
  messageId?: string;
  status: 'SENT' | 'FAILED';
  error?: string;
}

export abstract class SmsProvider {
  abstract readonly name: string;
  abstract send(to: string, body: string): Promise<SendResult>;
}

export abstract class EmailProvider {
  abstract readonly name: string;
  abstract send(to: string, subject: string, html: string, opts?: { fromName?: string; fromAddress?: string }): Promise<SendResult>;
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

@Injectable()
export class Msg91SmsProvider extends SmsProvider {
  readonly name = 'msg91';
  async send(to: string, body: string): Promise<SendResult> {
    try {
      const res = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: { authkey: env().SMS_API_KEY ?? '', 'content-type': 'application/json' },
        body: JSON.stringify({ sender: env().SMS_SENDER_ID, mobiles: to.replace(/^\+/, ''), message: body }),
      });
      if (!res.ok) return { provider: this.name, status: 'FAILED', error: `HTTP ${res.status}` };
      const json = (await res.json()) as { request_id?: string };
      return { provider: this.name, status: 'SENT', messageId: json.request_id };
    } catch (e) {
      return { provider: this.name, status: 'FAILED', error: (e as Error).message };
    }
  }
}

@Injectable()
export class SmtpEmailProvider extends EmailProvider {
  readonly name = 'smtp';
  private transporter: Transporter;
  constructor() {
    super();
    const e = env();
    this.transporter = nodemailer.createTransport({
      host: e.SMTP_HOST,
      port: e.SMTP_PORT ?? 587,
      secure: e.SMTP_PORT === 465,
      auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
    });
  }
  async send(to: string, subject: string, html: string, opts?: { fromName?: string; fromAddress?: string }) {
    try {
      const from = opts?.fromAddress ? `${opts.fromName ?? 'TherapyOS'} <${opts.fromAddress}>` : env().EMAIL_FROM;
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

/** WhatsApp Business Cloud API (Meta Graph). Uses approved templates when provided, text otherwise. */
@Injectable()
export class CloudWhatsAppProvider extends WhatsAppProvider {
  readonly name = 'whatsapp-cloud';
  async send(msg: WhatsAppMessage): Promise<SendResult> {
    const e = env();
    const payload = msg.templateName
      ? {
          messaging_product: 'whatsapp',
          to: msg.to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: msg.templateName,
            language: { code: msg.language ?? 'en' },
            components: msg.templateParams?.length
              ? [{ type: 'body', parameters: msg.templateParams.map((text) => ({ type: 'text', text })) }]
              : undefined,
          },
        }
      : { messaging_product: 'whatsapp', to: msg.to.replace(/^\+/, ''), type: 'text', text: { body: msg.body } };
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${e.WHATSAPP_ACCESS_TOKEN}`, 'content-type': 'application/json' },
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
