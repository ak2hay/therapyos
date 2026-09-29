import { createHmac, randomBytes } from 'crypto';
import { open, openJson, seal, sealJson, secretHint } from '../common/utils/secret-box';
import { IntegrationsConfigService } from './integrations-config.service';
import { Msg91SmsProvider } from './messaging.providers';
import { RazorpayPaymentProvider } from './payment.provider';

process.env.DATABASE_URL ??= 'postgresql://unit:unit@localhost:5432/unit';
process.env.JWT_ACCESS_SECRET ??= 'unit-test-secret-unit-test-secret';

describe('secret box', () => {
  const key = randomBytes(32);

  it('round-trips values and never stores plaintext', () => {
    const sealed = seal('rzp_secret_123', key);
    expect(sealed).not.toContain('rzp_secret_123');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(open(sealed, key)).toBe('rzp_secret_123');
    expect(openJson(sealJson({ a: '1', b: '2' }, key), key)).toEqual({ a: '1', b: '2' });
  });

  it('uses a fresh IV per value', () => {
    expect(seal('same', key)).not.toBe(seal('same', key));
  });

  it('rejects tampered data and the wrong key', () => {
    const sealed = seal('secret', key);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => open(parts.join('.'), key)).toThrow();
    expect(() => open(sealed, randomBytes(32))).toThrow();
  });

  it('shows only the last four characters', () => {
    expect(secretHint('abcdef123456')).toBe('****3456');
    expect(secretHint(undefined)).toBeNull();
  });
});

describe('MSG91 flow payload', () => {
  const creds = { authKey: 'k', senderId: 'RKYVES', otpTemplateId: 'otp_tpl', defaultTemplateId: 'default_tpl' };

  it('sends OTPs through the OTP template', () => {
    expect(Msg91SmsProvider.payload(creds, '+919845010036', { otp: '482913' })).toMatchObject({
      template_id: 'otp_tpl',
      recipients: [{ mobiles: '919845010036', otp: '482913', var1: '482913' }],
    });
  });

  it('maps template variables to var1..n in order', () => {
    expect(Msg91SmsProvider.payload(creds, '9845010036', { templateId: 'appt_tpl', params: ['Aarav', '10:30'] })).toMatchObject({
      template_id: 'appt_tpl',
      recipients: [{ mobiles: '919845010036', var1: 'Aarav', var2: '10:30' }],
    });
  });

  it('falls back to the default template and refuses free text without one', () => {
    expect(Msg91SmsProvider.payload(creds, '9845010036', {})?.template_id).toBe('default_tpl');
    expect(Msg91SmsProvider.payload({ authKey: 'k' }, '9845010036', {})).toBeNull();
  });
});

describe('Razorpay webhook verification', () => {
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
  const sign = (secret: string) => createHmac('sha256', secret).update(body).digest('hex');
  const tenantGateway = new RazorpayPaymentProvider({ keyId: 'rzp_live_tenant', keySecret: 'ks', webhookSecret: 'tenant-webhook-secret' });

  it("accepts events signed with the business's own webhook secret", () => {
    expect(tenantGateway.verifyWebhookSignature(body, sign('tenant-webhook-secret'))).toBe(true);
  });

  it('rejects the platform secret, forged and missing signatures', () => {
    expect(tenantGateway.verifyWebhookSignature(body, sign('platform-webhook-secret'))).toBe(false);
    expect(tenantGateway.verifyWebhookSignature(body, 'deadbeef')).toBe(false);
    expect(tenantGateway.verifyWebhookSignature(body, undefined)).toBe(false);
  });
});

describe('integration credential resolution', () => {
  const row = (tenantId: string | null, values: Record<string, string>, enabled = true) => ({
    id: `${tenantId ?? 'platform'}`,
    tenantId,
    provider: 'RAZORPAY',
    enabled,
    config: { keyId: values.keyId },
    secrets: sealJson({ keySecret: values.keySecret }),
    updatedAt: new Date(),
  });
  const service = (rows: ReturnType<typeof row>[]) => {
    const db = { integrationConfig: { findFirst: async ({ where }: { where: { tenantId: string | null } }) => rows.find((r) => r.tenantId === where.tenantId) ?? null } };
    const redis = { get: async () => '1', incr: async () => 2 };
    return new IntegrationsConfigService(db as never, redis as never);
  };

  it('prefers the business account, then the platform account', async () => {
    const s = service([row('t1', { keyId: 'rzp_tenant', keySecret: 's1' }), row(null, { keyId: 'rzp_platform', keySecret: 's2' })]);
    expect(await s.resolve('RAZORPAY', 't1')).toMatchObject({ source: 'tenant', values: { keyId: 'rzp_tenant', keySecret: 's1' } });
    expect(await s.resolve('RAZORPAY', 't2')).toMatchObject({ source: 'platform', values: { keyId: 'rzp_platform' } });
    expect(await s.resolve('RAZORPAY', null)).toMatchObject({ source: 'platform' });
  });

  it('ignores disabled or incomplete business accounts', async () => {
    const s = service([row('t1', { keyId: 'rzp_tenant', keySecret: 's1' }, false), row('t2', { keyId: 'rzp_t2', keySecret: '' }), row(null, { keyId: 'rzp_platform', keySecret: 's2' })]);
    expect((await s.resolve('RAZORPAY', 't1'))?.source).toBe('platform');
    expect((await s.resolve('RAZORPAY', 't2'))?.source).toBe('platform');
  });

  it('falls back to mock when nothing is configured', async () => {
    expect(await service([]).source('RAZORPAY', 't1')).toBe('mock');
  });

  it('never exposes secret values in the settings view', async () => {
    const view = await service([row('t1', { keyId: 'rzp_tenant', keySecret: 'super-secret-value' })]).view('RAZORPAY', 't1');
    expect(JSON.stringify(view)).not.toContain('super-secret-value');
    expect(view.secrets.keySecret).toEqual({ set: true, hint: '****alue' });
    expect(view.effectiveSource).toBe('tenant');
  });
});
