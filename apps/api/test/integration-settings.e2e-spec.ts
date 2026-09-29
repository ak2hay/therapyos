import { INestApplication } from '@nestjs/common';
import { AuthService } from '../src/modules/auth/auth.service';
import { client, createTestApp } from './fixtures';

describe('integration settings, platform settings and manual onboarding', () => {
  let app: INestApplication;
  let api: ReturnType<typeof client>;
  const stamp = Date.now().toString().slice(-8);

  beforeAll(async () => {
    app = await createTestApp();
    api = client(app);
  });
  afterAll(async () => {
    // Leave no real-looking gateway credentials behind for the other suites.
    await api.put('/integrations/RAZORPAY', { enabled: false, config: { keyId: null }, clear: ['keySecret', 'webhookSecret'] }, 'owner');
    await api.put('/admin/integrations/SMTP', { enabled: false, config: { host: null, fromAddress: null }, clear: ['pass'] }, 'admin');
    await api.put('/admin/platform-settings', { allowSelfSignup: true }, 'admin');
    await app.close();
  });

  describe('business integrations', () => {
    it('saves own keys without ever returning the secret', async () => {
      const res = await api.put('/integrations/RAZORPAY', { enabled: true, config: { keyId: 'rzp_test_tenantkey' }, secrets: { keySecret: 'tenant-secret-value-1234', webhookSecret: 'whsec-9876' } }, 'owner').expect(200);
      expect(JSON.stringify(res.body)).not.toContain('tenant-secret-value-1234');
      expect(JSON.stringify(res.body)).not.toContain('whsec-9876');
      expect(res.body.data).toMatchObject({ provider: 'RAZORPAY', enabled: true, configured: true, effectiveSource: 'tenant', config: { keyId: 'rzp_test_tenantkey' }, secrets: { keySecret: { set: true, hint: '****1234' } } });

      const list = await api.get('/integrations', 'owner').expect(200);
      expect(JSON.stringify(list.body)).not.toContain('tenant-secret-value-1234');
      expect(list.body.data.items.map((i: { provider: string }) => i.provider)).toEqual(['RAZORPAY', 'MSG91', 'WHATSAPP_CLOUD', 'SMTP']);
      expect(list.body.data.webhookUrls.payments).toMatch(/\/api\/v1\/webhooks\/razorpay$/);
    });

    it('keeps a stored secret when the field is left blank', async () => {
      const res = await api.put('/integrations/RAZORPAY', { enabled: true, config: { keyId: 'rzp_test_tenantkey' }, secrets: { keySecret: '' } }, 'owner').expect(200);
      expect(res.body.data.secrets.keySecret).toEqual({ set: true, hint: '****1234' });
    });

    it("isolates one business's keys from another", async () => {
      const other = await api.get('/integrations', 'otherOwner').expect(200);
      const razorpay = other.body.data.items.find((i: { provider: string }) => i.provider === 'RAZORPAY');
      expect(razorpay.effectiveSource).not.toBe('tenant');
      expect(razorpay.config.keyId).toBeNull();
      expect(razorpay.secrets.keySecret.set).toBe(false);
    });

    it('requires every mandatory field before enabling', async () => {
      const res = await api.put('/integrations/MSG91', { enabled: true, config: { senderId: 'RKYVES' } }, 'owner').expect(400);
      expect(res.body.error.message).toMatch(/Auth key/);
    });

    it('keeps platform-only providers out of reach', async () => {
      await api.put('/integrations/OPENAI', { enabled: true, secrets: { apiKey: 'sk-test' } }, 'owner').expect(403);
    });

    it('denies staff without the settings permission', async () => {
      await api.get('/integrations', 'reception').expect(403);
      await api.put('/integrations/RAZORPAY', { enabled: false }, 'reception').expect(403);
    });

    it('audits changes without secret values', async () => {
      const res = await api.get('/audit-logs?entityType=IntegrationConfig&pageSize=5', 'owner').expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.body.data)).not.toContain('tenant-secret-value-1234');
    });
  });

  describe('platform integrations and settings', () => {
    it('is only available to platform admins', async () => {
      await api.get('/admin/integrations', 'owner').expect(403);
      await api.get('/admin/platform-settings', 'owner').expect(403);
      await api.post('/admin/tenants', {}, 'owner').expect(403);
    });

    it('lists every provider and masks secrets', async () => {
      await api.put('/admin/integrations/SMTP', { enabled: true, config: { host: 'smtp.example.com', port: 587, fromAddress: 'no-reply@example.com' }, secrets: { pass: 'platform-smtp-pass' } }, 'admin').expect(200);
      const res = await api.get('/admin/integrations', 'admin').expect(200);
      expect(res.body.data.items.map((i: { provider: string }) => i.provider)).toEqual(['RAZORPAY', 'MSG91', 'WHATSAPP_CLOUD', 'SMTP', 'OPENAI']);
      expect(JSON.stringify(res.body)).not.toContain('platform-smtp-pass');
      expect(res.body.data.items.find((i: { provider: string }) => i.provider === 'SMTP').effectiveSource).toBe('platform');
      await api.put('/admin/integrations/SMTP', { enabled: false }, 'admin').expect(200);
    });

    it('closes self sign-up when disabled', async () => {
      await api.put('/admin/platform-settings', { allowSelfSignup: false }, 'admin').expect(200);
      expect((await api.get('/public/platform').expect(200)).body.data.allowSelfSignup).toBe(false);
      await expect(
        app.get(AuthService).register({ businessName: 'Closed Co', ownerName: 'Closed Owner', email: `closed${stamp}@example.com`, phone: `+9190${stamp}`, password: 'Closed@12345' }),
      ).rejects.toMatchObject({ code: 'SIGNUP_DISABLED' });
      await api.put('/admin/platform-settings', { allowSelfSignup: true }, 'admin').expect(200);
    });

    it('rejects an unknown trial plan', async () => {
      await api.put('/admin/platform-settings', { trialPlanCode: 'NOPE' }, 'admin').expect(400);
    });
  });

  describe('manual onboarding', () => {
    it('creates a business with an invitation the owner can accept', async () => {
      const res = await api
        .post('/admin/tenants', { businessName: `Invited Spa ${stamp}`, ownerName: 'Invited Owner', email: `invited${stamp}@example.com`, phone: `+9191${stamp}`, planCode: 'BUSINESS', subscription: 'TRIAL', trialDays: 30, access: 'INVITE' }, 'admin')
        .expect(201);
      const created = res.body.data;
      expect(created).toMatchObject({ tenantId: expect.any(String), loginEmail: `invited${stamp}@example.com`, temporaryPassword: null });
      expect(created.inviteLink).toMatch(/\/accept-invite\?token=/);

      const detail = await api.get(`/admin/tenants/${created.tenantId}`, 'admin').expect(200);
      expect(detail.body.data.subscription).toMatchObject({ status: 'TRIALING' });
      expect(detail.body.data.owners[0]).toMatchObject({ status: 'INVITED' });
      const trialDays = Math.round((new Date(detail.body.data.subscription.trialEndDate).getTime() - Date.now()) / 86_400_000);
      expect(trialDays).toBe(30);

      const token = new URL(created.inviteLink).searchParams.get('token')!;
      const accepted = await api.post('/auth/accept-invite', { token, password: 'Owner@12345' }).expect(200);
      expect(accepted.body.data.tokens.accessToken).toBeDefined();
    });

    it('creates a paid business with a temporary password and resets it', async () => {
      const email = `paid${stamp}@example.com`;
      const res = await api
        .post('/admin/tenants', { businessName: `Paid Clinic ${stamp}`, ownerName: 'Paid Owner', email, phone: `+9192${stamp}`, planCode: 'BUSINESS', billingCycle: 'ANNUAL', subscription: 'ACTIVE', access: 'PASSWORD' }, 'admin')
        .expect(201);
      const { tenantId, temporaryPassword } = res.body.data;
      expect(temporaryPassword).toMatch(/^Rk-/);
      await api.post('/auth/login', { identifier: email, password: temporaryPassword }).expect(200);

      const detail = await api.get(`/admin/tenants/${tenantId}`, 'admin').expect(200);
      expect(detail.body.data.subscription).toMatchObject({ status: 'ACTIVE', billingCycle: 'ANNUAL', provider: 'manual' });

      const reset = await api.post(`/admin/tenants/${tenantId}/owner/reset-password`, {}, 'admin').expect(200);
      expect(reset.body.data.temporaryPassword).not.toBe(temporaryPassword);
      await api.post('/auth/login', { identifier: email, password: temporaryPassword }).expect(401);
      await api.post('/auth/login', { identifier: email, password: reset.body.data.temporaryPassword }).expect(200);
      await api.post(`/admin/tenants/${tenantId}/owner/invite`, {}, 'admin').expect(422);
    });

    it('refuses duplicate owners and unknown plans', async () => {
      await api.post('/admin/tenants', { businessName: 'Dup', ownerName: 'Dup Owner', email: `paid${stamp}@example.com`, phone: `+9193${stamp}`, planCode: 'BUSINESS' }, 'admin').expect(409);
      await api.post('/admin/tenants', { businessName: 'No Plan', ownerName: 'No Plan', email: `noplan${stamp}@example.com`, phone: `+9194${stamp}`, planCode: 'NOPE' }, 'admin').expect(404);
    });
  });
});
