import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { Db, InjectDb } from '../common/prisma/prisma.service';
import { InjectRedis } from '../common/redis/redis.module';

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  CURRENCY: 'INR',
  TIMEZONE: 'Asia/Kolkata',
  TAX_MODE: 'EXCLUSIVE',
  INVOICE_PREFIX: 'INV',
  APPOINTMENT_BUFFER: 10,
  DEFAULT_APPOINTMENT_DURATION: 60,
  SLOT_INTERVAL: 15,
  WHATSAPP_ENABLED: false,
  THERAPIST_CAN_VIEW_CUSTOMER_PHONE: false,
  ROUNDING: 'NEAREST_1',
  PAYMENT_PROVIDERS: ['CASH', 'UPI', 'CARD'],
  FEEDBACK_REQUEST_ENABLED: true,
  REMINDER_HOURS_BEFORE: 24,
  PACKAGE_EXPIRY_REMINDER_DAYS: 7,
  MEMBERSHIP_EXPIRY_REMINDER_DAYS: 7,
  INACTIVE_AFTER_DAYS: 60,
  CHURNED_AFTER_DAYS: 120,
  VIP_LTV_THRESHOLD: 20000,
  CAMPAIGN_ATTRIBUTION_DAYS: 14,
};

@Injectable()
export class SettingsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async getAll(tenantId: string): Promise<Record<string, unknown>> {
    const key = `settings:${tenantId}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);
    const rows = await this.db.tenantSetting.findMany({ where: { tenantId } });
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { currency: true, timezone: true } });
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    if (tenant) {
      merged.CURRENCY = tenant.currency;
      merged.TIMEZONE = tenant.timezone;
    }
    for (const r of rows) merged[r.key] = r.value;
    await this.redis.set(key, JSON.stringify(merged), 'EX', 120);
    return merged;
  }

  async get<T = unknown>(tenantId: string, key: string): Promise<T> {
    const all = await this.getAll(tenantId);
    return all[key] as T;
  }

  async timezone(tenantId: string): Promise<string> {
    return (await this.get<string>(tenantId, 'TIMEZONE')) ?? 'Asia/Kolkata';
  }

  async setMany(tenantId: string, values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) {
      await this.db.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key } },
        create: { tenantId, key, value: value as Prisma.InputJsonValue },
        update: { value: value as Prisma.InputJsonValue },
      });
    }
    await this.invalidate(tenantId);
    return this.getAll(tenantId);
  }

  async invalidate(tenantId: string) {
    await this.redis.del(`settings:${tenantId}`);
  }
}
