import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Redis from 'ioredis';
import type { PlatformSettings } from '@therapyos/types';
import { Db, InjectDb } from '../common/prisma/prisma.service';
import { InjectRedis } from '../common/redis/redis.module';
import { env } from '../config/env';

const VERSION_KEY = 'platform-settings:version';
const TTL_MS = 60_000;

export function defaultPlatformSettings(): PlatformSettings {
  return {
    platformName: 'TherapyOS',
    supportEmail: '',
    supportPhone: '',
    allowSelfSignup: true,
    trialPlanCode: 'BUSINESS',
    trialDays: 14,
    subscriptionGraceDays: env().SUBSCRIPTION_GRACE_DAYS,
    defaultTimezone: 'Asia/Kolkata',
    defaultCurrency: 'INR',
    defaultCountry: 'IN',
  };
}

/** Platform-wide settings edited in the super-admin console; each key is one `platform_settings` row. */
@Injectable()
export class PlatformSettingsService {
  private cache: { value: PlatformSettings; at: number; version: string } | null = null;

  constructor(
    @InjectDb() private readonly db: Db,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private async version() {
    return (await this.redis.get(VERSION_KEY).catch(() => null)) ?? '0';
  }

  async get(): Promise<PlatformSettings> {
    const version = await this.version();
    if (this.cache && this.cache.version === version && Date.now() - this.cache.at < TTL_MS) return this.cache.value;
    const rows = await this.db.platformSetting.findMany();
    const defaults = defaultPlatformSettings();
    const value = { ...defaults } as Record<string, unknown>;
    for (const r of rows) if (r.key in defaults) value[r.key] = r.value;
    this.cache = { value: value as unknown as PlatformSettings, at: Date.now(), version };
    return this.cache.value;
  }

  async update(input: Partial<PlatformSettings>) {
    const entries = Object.entries(input).filter(([, v]) => v !== undefined);
    await this.db.$transaction(
      entries.map(([key, value]) =>
        this.db.platformSetting.upsert({ where: { key }, create: { key, value: value as Prisma.InputJsonValue }, update: { value: value as Prisma.InputJsonValue } }),
      ),
    );
    this.cache = null;
    await this.redis.incr(VERSION_KEY).catch(() => undefined);
    return this.get();
  }

  /** The subset safe to show before sign-in. */
  async publicView() {
    const s = await this.get();
    return { platformName: s.platformName, supportEmail: s.supportEmail, supportPhone: s.supportPhone, allowSelfSignup: s.allowSelfSignup, trialDays: s.trialDays };
  }
}
