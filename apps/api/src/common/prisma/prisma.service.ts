import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { RequestContext } from '../context/request-context';

/** Models that carry `tenantId` but must not be auto-scoped (they hold platform-wide defaults). */
const UNSCOPED = new Set(['FeatureFlag', 'NotificationTemplate', 'DomainEvent', 'IntegrationConfig']);

export const TENANT_MODELS = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => !UNSCOPED.has(m.name) && m.fields.some((f) => f.name === 'tenantId'))
    .map((m) => m.name),
);

const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);

type AnyArgs = Record<string, any>;

function withTenantData(data: AnyArgs, tenantId: string) {
  if (data.tenant || data.tenantId) return data;
  return { ...data, tenantId };
}

const LIKE_FILTERS = new Set(['contains', 'startsWith', 'endsWith']);
const isPlainObject = (v: unknown): v is AnyArgs => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Prisma renders string filters as (I)LIKE without escaping `%`, `_` or `\`, so user search text would act as a
 * wildcard pattern. Filters here always mean literal substring matching.
 */
export function escapeLikeFilters<T>(where: T): T {
  if (Array.isArray(where)) return where.map(escapeLikeFilters) as T;
  if (!isPlainObject(where)) return where;
  const out: AnyArgs = {};
  for (const [k, v] of Object.entries(where)) {
    out[k] = LIKE_FILTERS.has(k) && typeof v === 'string' ? v.replace(/[\\%_]/g, '\\$&') : escapeLikeFilters(v);
  }
  return out as T;
}

export function createDb(log = false) {
  const base = new PrismaClient({
    log: log ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

  return base.$extends({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const a = (args ?? {}) as AnyArgs;
          if (a.where) a.where = escapeLikeFilters(a.where);
          const tenantId = RequestContext.tenantId;
          if (!tenantId || !model || !TENANT_MODELS.has(model)) return query(a);


          if (WHERE_OPS.has(operation)) {
            a.where = { ...(a.where ?? {}), tenantId };
          } else if (operation === 'create') {
            a.data = withTenantData(a.data ?? {}, tenantId);
          } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
            a.data = Array.isArray(a.data)
              ? a.data.map((d: AnyArgs) => withTenantData(d, tenantId))
              : withTenantData(a.data, tenantId);
          } else if (operation === 'upsert') {
            a.where = { ...(a.where ?? {}), tenantId };
            a.create = withTenantData(a.create ?? {}, tenantId);
          }
          return query(a);
        },
      },
    },
  });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];
export type DbOrTx = Db | Tx;
export const DB = Symbol('DB');
export const InjectDb = () => Inject(DB);

@Injectable()
class DbLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger('Prisma');
  constructor(@Inject(DB) private readonly db: Db) {}
  async onModuleDestroy() {
    await this.db.$disconnect();
    this.logger.log('Disconnected');
  }
}

@Global()
@Module({
  providers: [{ provide: DB, useFactory: () => createDb(process.env.PRISMA_LOG === 'true') }, DbLifecycle],
  exports: [DB],
})
export class PrismaModule {}
