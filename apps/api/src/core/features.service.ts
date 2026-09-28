import { HttpStatus, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Db, InjectDb } from '../common/prisma/prisma.service';
import { InjectRedis } from '../common/redis/redis.module';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';

export type LimitKind = 'branches' | 'users' | 'customers';

@Injectable()
export class FeaturesService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  /** Effective features = plan features + global defaults, overridden by tenant-level flags. */
  async getFeatures(tenantId: string): Promise<string[]> {
    const key = `features:${tenantId}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);

    const [sub, flags] = await Promise.all([
      this.db.tenantSubscription.findFirst({
        where: { tenantId, isCurrent: true },
        include: { plan: true },
      }),
      this.db.featureFlag.findMany({ where: { OR: [{ tenantId: null }, { tenantId }] } }),
    ]);
    const features = new Set<string>(sub?.plan.features ?? []);
    for (const f of flags.filter((f) => f.tenantId === null)) {
      if (f.enabled) features.add(f.key);
      else features.delete(f.key);
    }
    for (const f of flags.filter((f) => f.tenantId === tenantId)) {
      if (f.enabled) features.add(f.key);
      else features.delete(f.key);
    }
    const list = [...features].sort();
    await this.redis.set(key, JSON.stringify(list), 'EX', 60);
    return list;
  }

  async isEnabled(tenantId: string, key: string) {
    return (await this.getFeatures(tenantId)).includes(key);
  }

  async assertEnabled(tenantId: string, key: string) {
    if (!(await this.isEnabled(tenantId, key))) {
      throw new AppError(
        ErrorCode.FEATURE_DISABLED,
        `The ${key.replace(/_/g, ' ').toLowerCase()} feature is not enabled for your plan.`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  async invalidate(tenantId: string) {
    await this.redis.del(`features:${tenantId}`);
  }

  async getLimits(tenantId: string) {
    const sub = await this.db.tenantSubscription.findFirst({ where: { tenantId, isCurrent: true }, include: { plan: true } });
    return {
      branches: sub?.plan.maxBranches ?? 1,
      users: sub?.plan.maxUsers ?? 5,
      customers: sub?.plan.maxCustomers ?? 1000,
      subscriptionStatus: sub?.status ?? null,
      planCode: sub?.plan.code ?? null,
      planName: sub?.plan.name ?? null,
      planFeatures: sub?.plan.features ?? [],
    };
  }

  async getUsage(tenantId: string) {
    const [branches, users, customers] = await Promise.all([
      this.db.branch.count({ where: { tenantId, status: 'ACTIVE' } }),
      this.db.user.count({ where: { tenantId, status: { not: 'DISABLED' } } }),
      this.db.customer.count({ where: { tenantId } }),
    ]);
    return { branches, users, customers };
  }

  async assertWithinLimit(tenantId: string, kind: LimitKind, adding = 1) {
    const [limits, usage] = await Promise.all([this.getLimits(tenantId), this.getUsage(tenantId)]);
    if (usage[kind] + adding > limits[kind]) {
      throw new AppError(
        ErrorCode.PLAN_LIMIT_REACHED,
        `Your plan allows up to ${limits[kind]} ${kind}. Upgrade your subscription to add more.`,
        HttpStatus.PAYMENT_REQUIRED,
        { kind, limit: limits[kind], usage: usage[kind] },
      );
    }
  }
}
