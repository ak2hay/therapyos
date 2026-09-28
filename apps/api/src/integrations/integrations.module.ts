import { Global, Module } from '@nestjs/common';
import { env } from '../config/env';
import {
  CloudWhatsAppProvider,
  EmailProvider,
  MockEmailProvider,
  MockPushProvider,
  MockSmsProvider,
  MockWhatsAppProvider,
  Msg91SmsProvider,
  PushProvider,
  SmsProvider,
  SmtpEmailProvider,
  WhatsAppProvider,
} from './messaging.providers';
import { MockPaymentProvider, PaymentProvider, RazorpayPaymentProvider } from './payment.provider';
import { StorageService } from './storage.service';
import { LlmProvider, MockLlmProvider, OpenAiLlmProvider } from './llm.provider';

@Global()
@Module({
  providers: [
    StorageService,
    { provide: SmsProvider, useClass: env().SMS_PROVIDER === 'msg91' ? Msg91SmsProvider : MockSmsProvider },
    { provide: EmailProvider, useClass: env().EMAIL_PROVIDER === 'smtp' ? SmtpEmailProvider : MockEmailProvider },
    { provide: WhatsAppProvider, useClass: env().WHATSAPP_PROVIDER === 'cloud' ? CloudWhatsAppProvider : MockWhatsAppProvider },
    { provide: PushProvider, useClass: MockPushProvider },
    { provide: PaymentProvider, useClass: env().PAYMENT_PROVIDER === 'razorpay' ? RazorpayPaymentProvider : MockPaymentProvider },
    { provide: LlmProvider, useClass: env().LLM_PROVIDER === 'openai' ? OpenAiLlmProvider : MockLlmProvider },
  ],
  exports: [StorageService, SmsProvider, EmailProvider, WhatsAppProvider, PushProvider, PaymentProvider, LlmProvider],
})
export class IntegrationsModule {}
