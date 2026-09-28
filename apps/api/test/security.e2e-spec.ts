import { createHmac } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { MockPaymentProvider } from '../src/integrations/payment.provider';
import { client, createTestApp, fixtures } from './fixtures';

describe('security controls', () => {
  let app: INestApplication;
  let api: ReturnType<typeof client>;
  const f = fixtures();

  beforeAll(async () => {
    app = await createTestApp();
    api = client(app);
  });
  afterAll(() => app.close());

  it('sends hardening headers and hides the framework', async () => {
    const res = await api.raw().get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['referrer-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('exposes liveness and Prometheus metrics outside the versioned API', async () => {
    const live = await api.raw().get('/health/live').expect(200);
    expect(live.body).toEqual({ status: 'ok' });
    const metrics = await api.raw().get('/metrics').expect(200);
    expect(metrics.text).toMatch(/process_cpu_user_seconds_total/);
  });

  it('only allows CORS from configured origins outside development', async () => {
    const res = await api.raw().options('/api/v1/customers').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('validates input and reports field errors in the standard envelope', async () => {
    const res = await api.post('/customers', { name: 'A', phone: 'abc' }, 'owner').expect(400);
    expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
    expect(JSON.stringify(res.body.error.details)).toMatch(/phone/);
  });

  it('treats SQL meta-characters in search as plain text', async () => {
    for (const q of ["' OR 1=1 --", "%'; DROP TABLE customers; --", '\\', '%_%']) {
      const res = await api.get(`/customers?search=${encodeURIComponent(q)}`, 'owner');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    }
    await api.get(`/customers/${f.customers.aarav}`, 'owner').expect(200);
  });

  it('stores markup as inert text and never renders HTML', async () => {
    const created = await api.post('/customers', { name: '<img src=x onerror=alert(1)>', phone: `+9197${Date.now().toString().slice(-8)}` }, 'owner').expect(201);
    const res = await api.get(`/customers/${created.body.data.id}`, 'owner').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.data.name).toBe('<img src=x onerror=alert(1)>');
  });

  it('returns a JSON 404 for unknown routes without a stack trace', async () => {
    const res = await api.get('/definitely-not-a-route', 'owner').expect(404);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules/);
  });

  describe('payment webhooks', () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_test', order_id: 'order_unknown_123' } } } });
    const post = (signature?: string) => {
      const req = api.raw().post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json');
      return (signature ? req.set('x-razorpay-signature', signature) : req).send(body);
    };

    it('rejects missing and forged signatures', async () => {
      for (const res of [await post(), await post('deadbeef'), await post(createHmac('sha256', 'wrong-secret').update(body).digest('hex'))]) {
        expect(res.status).toBe(400);
        expect(res.body.error?.code ?? res.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      }
    });

    it('accepts a correctly signed event and ignores unknown orders', async () => {
      const res = await post(createHmac('sha256', MockPaymentProvider.SECRET).update(body).digest('hex'));
      expect(res.status).toBeLessThan(300);
      expect(JSON.stringify(res.body)).toMatch(/unknown order/);
    });
  });

  it('records an audit trail for sensitive changes', async () => {
    await api.patch(`/customers/${f.customers.other}`, { notes: `audited ${Date.now()}` }, 'owner').expect(200);
    const res = await api.get(`/audit-logs?entityId=${f.customers.other}&pageSize=5`, 'owner').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toMatchObject({ entityType: 'Customer' });
  });

  it('rate-limits sign-up attempts', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await api.post('/auth/register', {})).status);
    expect(statuses).toContain(429);
    const limited = await api.post('/auth/register', {});
    expect(limited.status).toBe(429);
  });
});
