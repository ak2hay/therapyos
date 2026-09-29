import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';

export const FIXTURES_FILE = join(tmpdir(), 'therapyos-integration-fixtures.json');

type Pair = { accessToken: string; refreshToken: string };
type Role = 'owner' | 'hq' | 'manager' | 'reception' | 'therapist' | 'area' | 'accountant' | 'otherOwner' | 'admin' | 'customer' | 'otherCustomer';

export interface Fixtures {
  tenants: { serenity: string; other: string };
  branches: { ind: string; kor: string };
  customers: { aarav: string; other: string };
  invoiceId: string;
  appointmentId: string;
  serviceId: string;
  tokens: Record<Role, Pair>;
}

export const fixtures = (): Fixtures => JSON.parse(readFileSync(FIXTURES_FILE, 'utf8'));

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  setupApp(app);
  await app.init();
  return app;
}

/** Supertest bound to `/api/v1`, optionally authenticated as one of the fixture roles. */
export function client(app: INestApplication) {
  const f = fixtures();
  const http = () => request(app.getHttpServer());
  const auth = (req: request.Test, as?: Role | string) => {
    if (!as) return req;
    const token = as in f.tokens ? f.tokens[as as Role].accessToken : as;
    return req.set('Authorization', `Bearer ${token}`);
  };
  return {
    get: (path: string, as?: Role | string) => auth(http().get(`/api/v1${path}`), as),
    post: (path: string, body: object = {}, as?: Role | string) => auth(http().post(`/api/v1${path}`).send(body), as),
    patch: (path: string, body: object = {}, as?: Role | string) => auth(http().patch(`/api/v1${path}`).send(body), as),
    put: (path: string, body: object = {}, as?: Role | string) => auth(http().put(`/api/v1${path}`).send(body), as),
    delete: (path: string, as?: Role | string) => auth(http().delete(`/api/v1${path}`), as),
    raw: http,
  };
}
