import { INestApplication } from '@nestjs/common';
import { client, createTestApp, fixtures } from './fixtures';

type Role = Parameters<ReturnType<typeof client>['get']>[1];

describe('role-based access control', () => {
  let app: INestApplication;
  let api: ReturnType<typeof client>;
  const f = fixtures();

  beforeAll(async () => {
    app = await createTestApp();
    api = client(app);
  });
  afterAll(() => app.close());

  const send = (method: string, path: string, as: Role, body: object = {}) =>
    method === 'GET' ? api.get(path, as) : method === 'POST' ? api.post(path, body, as) : api.patch(path, body, as);

  it.each([
    ['reception', 'GET', '/reports/sales?from=2026-09-01&to=2026-09-30'],
    ['reception', 'GET', '/expenses'],
    ['reception', 'POST', '/expenses'],
    ['reception', 'GET', '/users'],
    ['reception', 'GET', '/ai/suggestions'],
    ['reception', 'GET', '/analytics/overview'],
    ['reception', 'GET', '/dashboard/accounts'],
    ['therapist', 'GET', '/invoices'],
    ['therapist', 'POST', '/customers'],
    ['therapist', 'GET', '/reports/sales?from=2026-09-01&to=2026-09-30'],
    ['therapist', 'POST', '/queue'],
    ['accountant', 'POST', '/appointments'],
    ['accountant', 'GET', '/customers'],
    ['manager', 'GET', '/hq/overview'],
    ['manager', 'GET', '/api-keys'],
    ['manager', 'POST', '/users'],
    ['hq', 'GET', '/api-keys'],
    ['area', 'GET', '/ai/suggestions'],
  ] as const)('%s is forbidden from %s %s', async (role, method, path) => {
    const res = await send(method, path, role);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
  });

  it.each([
    ['owner', '/reports/sales?from=2026-09-01&to=2026-09-30'],
    ['accountant', '/reports/sales?from=2026-09-01&to=2026-09-30'],
    ['accountant', '/dashboard/accounts'],
    ['manager', '/expenses'],
    ['area', '/hq/overview?from=2026-09-01&to=2026-09-30'],
    ['reception', '/customers'],
    ['therapist', '/sessions/my-day'],
    ['hq', '/ai/suggestions'],
    ['owner', '/api-keys'],
  ] as const)('%s may GET %s', async (role, path) => {
    const res = await api.get(path, role);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  describe('branch scoping', () => {
    it('a branch manager only sees their own branch', async () => {
      await api.get(`/queue?branchId=${f.branches.ind}`, 'manager').expect(200);
      expect((await api.get(`/queue?branchId=${f.branches.kor}`, 'manager')).status).toBe(403);
      expect((await api.get(`/reports/sales?from=2026-09-01&to=2026-09-30&branchId=${f.branches.kor}`, 'manager')).status).toBe(403);
    });

    it('an area manager only sees their assigned branches', async () => {
      await api.get(`/queue?branchId=${f.branches.kor}`, 'area').expect(200);
      expect((await api.get(`/queue?branchId=${f.branches.ind}`, 'area')).status).toBe(403);
    });

    it('a therapist only lists their own sessions', async () => {
      const res = await api.get('/sessions?pageSize=100', 'therapist').expect(200);
      const therapists = new Set((res.body.data as { therapist: { name: string } }[]).map((s) => s.therapist.name));
      expect([...therapists].every((n) => n === 'Arjun Das')).toBe(true);
    });
  });

  describe('authentication', () => {
    it('rejects requests without credentials', async () => {
      const res = await api.get('/customers');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHENTICATED' } });
    });

    it('rejects malformed and tampered tokens', async () => {
      expect((await api.get('/customers', 'not-a-jwt')).status).toBe(401);
      const [h, p, s] = f.tokens.owner.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      const forged = Buffer.from(JSON.stringify({ ...claims, tid: f.tenants.other })).toString('base64url');
      expect((await api.get('/customers', `${h}.${forged}.${s}`)).status).toBe(401);
    });

    it('keeps platform-admin and business tokens apart', async () => {
      await api.get('/admin/tenants', 'admin').expect(200);
      expect((await api.get('/admin/tenants', 'owner')).status).toBe(403);
      expect((await api.get('/customers', 'admin')).status).toBe(403);
    });

    it('keeps customer-app and staff tokens apart', async () => {
      expect((await api.get('/customers', 'customer')).status).toBe(403);
      expect((await api.get('/sessions/my-day', 'customer')).status).toBe(403);
      expect((await api.get('/portal/me', 'owner')).status).toBe(403);
      await api.get('/portal/me', 'customer').expect(200);
    });
  });
});
