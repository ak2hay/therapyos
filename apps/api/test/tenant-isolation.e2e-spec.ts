import { INestApplication } from '@nestjs/common';
import { client, createTestApp, fixtures } from './fixtures';

const randomPhone = () => `+9199${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

describe('tenant isolation', () => {
  let app: INestApplication;
  let api: ReturnType<typeof client>;
  const f = fixtures();

  beforeAll(async () => {
    app = await createTestApp();
    api = client(app);
  });
  afterAll(() => app.close());

  describe('another business cannot reach Serenity data by id', () => {
    it.each([
      ['customer', () => `/customers/${f.customers.aarav}`],
      ['customer timeline', () => `/customers/${f.customers.aarav}/timeline`],
      ['invoice', () => `/invoices/${f.invoiceId}`],
      ['appointment', () => `/appointments/${f.appointmentId}`],
    ])('%s -> 404', async (_label, path) => {
      const res = await api.get(path(), 'otherOwner');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('cannot update or delete a foreign customer', async () => {
      expect((await api.patch(`/customers/${f.customers.aarav}`, { name: 'Hijacked Name' }, 'otherOwner')).status).toBe(404);
      expect((await api.delete(`/customers/${f.customers.aarav}`, 'otherOwner')).status).toBe(404);
      const own = await api.get(`/customers/${f.customers.aarav}`, 'owner').expect(200);
      expect(own.body.data.name).toBe('Aarav Kapoor');
    });

    it('cannot book into a foreign branch', async () => {
      const res = await api.post('/appointments', { branchId: f.branches.ind, customerId: f.customers.aarav, serviceId: f.serviceId, date: '2030-01-10', startTime: '10:00' }, 'otherOwner');
      expect([403, 404]).toContain(res.status);
    });

    it('cannot open a foreign queue board', async () => {
      const res = await api.get(`/queue?branchId=${f.branches.ind}`, 'otherOwner');
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('lists only ever contain the caller’s own records', () => {
    it('customer search does not leak across businesses', async () => {
      const res = await api.get('/customers?search=Aarav&pageSize=50', 'otherOwner').expect(200);
      expect(res.body.data.map((c: { id: string }) => c.id)).not.toContain(f.customers.aarav);
    });

    it('branches are scoped to the business', async () => {
      const res = await api.get('/branches', 'otherOwner').expect(200);
      const ids = (res.body.data as { id: string }[]).map((b) => b.id);
      expect(ids).not.toContain(f.branches.ind);
      expect(ids).not.toContain(f.branches.kor);
    });

    it('a record created by one business is invisible to the other', async () => {
      const created = await api.post('/customers', { name: 'Isolation Probe', phone: randomPhone() }, 'otherOwner').expect(201);
      const id = created.body.data.id as string;
      expect((await api.get(`/customers/${id}`, 'otherOwner')).status).toBe(200);
      expect((await api.get(`/customers/${id}`, 'owner')).status).toBe(404);
      const search = await api.get('/customers?search=Isolation%20Probe&pageSize=50', 'owner').expect(200);
      expect(search.body.data.map((c: { id: string }) => c.id)).not.toContain(id);
    });
  });

  describe('customer app tokens only see their own records', () => {
    it('cannot read another customer’s invoice or appointment in the same business', async () => {
      expect((await api.get(`/portal/invoices/${f.invoiceId}/pdf`, 'customer')).status).toBe(404);
      expect((await api.get(`/portal/appointments/${f.appointmentId}`, 'customer')).status).toBe(404);
      expect((await api.post(`/portal/invoices/${f.invoiceId}/pay`, {}, 'customer')).status).toBe(404);
    });

    it('returns only the caller’s appointments', async () => {
      const mine = await api.get('/portal/appointments?scope=past', 'customer').expect(200);
      const theirs = await api.get('/portal/appointments?scope=past', 'otherCustomer').expect(200);
      const a = new Set((mine.body.data as { id: string }[]).map((x) => x.id));
      expect((theirs.body.data as { id: string }[]).some((x) => a.has(x.id))).toBe(false);
    });
  });

  describe('API keys are bound to their business and scopes', () => {
    let key: { id: string; key: string };

    beforeAll(async () => {
      const res = await api.post('/api-keys', { name: 'Isolation test', scopes: ['customer.read'] }, 'owner').expect(201);
      key = res.body.data;
    });
    afterAll(async () => {
      await api.delete(`/api-keys/${key.id}`, 'owner');
    });

    it('reads its own business within scope', async () => {
      await api.raw().get(`/api/v1/customers/${f.customers.aarav}`).set('x-api-key', key.key).expect(200);
    });

    it('cannot read another business or act outside its scopes', async () => {
      const foreign = await api.post('/customers', { name: 'Key Probe', phone: randomPhone() }, 'otherOwner').expect(201);
      expect((await api.raw().get(`/api/v1/customers/${foreign.body.data.id}`).set('x-api-key', key.key)).status).toBe(404);
      expect((await api.raw().get('/api/v1/invoices').set('x-api-key', key.key)).status).toBe(403);
      expect((await api.raw().post('/api/v1/customers').set('x-api-key', key.key).send({ name: 'Nope', phone: randomPhone() })).status).toBe(403);
    });

    it('stops working once revoked', async () => {
      const temp = (await api.post('/api-keys', { name: 'Revocation test', scopes: ['customer.read'] }, 'owner').expect(201)).body.data;
      await api.delete(`/api-keys/${temp.id}`, 'owner').expect(200);
      expect((await api.raw().get(`/api/v1/customers/${f.customers.aarav}`).set('x-api-key', temp.key)).status).toBe(401);
    });
  });
});
