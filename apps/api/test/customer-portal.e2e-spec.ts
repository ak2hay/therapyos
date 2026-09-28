import { INestApplication } from '@nestjs/common';
import { client, createTestApp, fixtures } from './fixtures';

describe('customer app authentication', () => {
  let app: INestApplication;
  let api: ReturnType<typeof client>;
  const f = fixtures();
  const phone = `98${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  beforeAll(async () => {
    app = await createTestApp();
    api = client(app);
  });
  afterAll(() => app.close());

  let signupToken: string;
  let tokens: { accessToken: string; refreshToken: string };

  it('signs up a new number with OTP and a one-step profile', async () => {
    const sent = await api.post('/portal/auth/send-otp', { tenantSlug: 'serenity-wellness', phone }).expect(201);
    expect(sent.body.data.devCode).toMatch(/^\d{6}$/);

    const wrong = sent.body.data.devCode === '000000' ? '111111' : '000000';
    expect((await api.post('/portal/auth/verify-otp', { tenantSlug: 'serenity-wellness', phone, code: wrong })).status).toBe(400);

    const verified = await api.post('/portal/auth/verify-otp', { tenantSlug: 'serenity-wellness', phone, code: sent.body.data.devCode }).expect(201);
    expect(verified.body.data.needsProfile).toBe(true);
    signupToken = verified.body.data.signupToken;

    const registered = await api.post('/portal/auth/register', { signupToken, name: 'Portal Test User' }).expect(201);
    tokens = registered.body.data.tokens;
    const me = await api.get('/portal/me', tokens.accessToken).expect(200);
    expect(me.body.data).toMatchObject({ name: 'Portal Test User', phone: `+91${phone}` });

    const staffView = await api.get(`/customers/${registered.body.data.customer.id}`, 'owner').expect(200);
    expect(staffView.body.data.source).toBe('CUSTOMER_APP');
  });

  it('refuses the short-lived signup token everywhere else', async () => {
    expect((await api.get('/portal/me', signupToken)).status).toBe(401);
    expect((await api.get('/customers', signupToken)).status).toBe(401);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const rotated = await api.post('/portal/auth/refresh', { refreshToken: tokens.refreshToken }).expect(201);
    const reused = await api.post('/portal/auth/refresh', { refreshToken: tokens.refreshToken });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('TOKEN_REUSED');
    expect((await api.post('/portal/auth/refresh', { refreshToken: rotated.body.data.refreshToken })).status).toBe(401);
  });

  it('never accepts a customer refresh token on the staff endpoint or vice versa', async () => {
    expect((await api.post('/auth/refresh', { refreshToken: f.tokens.otherCustomer.refreshToken })).status).toBe(401);
    expect((await api.post('/portal/auth/refresh', { refreshToken: f.tokens.reception.refreshToken })).status).toBe(401);
  });

  it('is unavailable for businesses without the customer app', async () => {
    const res = await api.post('/portal/auth/send-otp', { tenantSlug: 'mindful-care', phone });
    expect(res.status).toBe(404);
  });
});
