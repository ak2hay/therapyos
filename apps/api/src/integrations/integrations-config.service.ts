import { Injectable, Logger } from '@nestjs/common';
import { IntegrationProvider, Prisma } from '@prisma/client';
import Redis from 'ioredis';
import {
  INTEGRATIONS,
  TENANT_INTEGRATIONS,
  type IntegrationProviderKey,
  type IntegrationSource,
  type IntegrationView,
} from '@therapyos/types';
import type { IntegrationUpdateInput } from '@therapyos/validation';
import { AppError } from '../common/errors/app-error';
import { Db, InjectDb } from '../common/prisma/prisma.service';
import { InjectRedis } from '../common/redis/redis.module';
import { openJson, sealJson, secretHint } from '../common/utils/secret-box';
import { env } from '../config/env';

export type IntegrationValues = Record<string, string | number | boolean>;

export interface ResolvedIntegration {
  source: Exclude<IntegrationSource, 'mock'>;
  values: IntegrationValues;
}

interface StoredRow {
  id: string;
  enabled: boolean;
  config: Record<string, string | number | boolean | null>;
  secrets: Record<string, string>;
  updatedAt: Date;
}

const VERSION_KEY = 'integrations:version';
const TTL_MS = 60_000;

function parseFrom(from: string) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { fromName: m[1].trim(), fromAddress: m[2].trim() } : { fromAddress: from.trim() };
}

/** Credentials from environment variables: the fallback used before anything is saved in the database. */
export function envIntegration(provider: IntegrationProviderKey): IntegrationValues | null {
  const e = env();
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as IntegrationValues;
  switch (provider) {
    case 'RAZORPAY':
      return e.PAYMENT_PROVIDER === 'razorpay' && e.RAZORPAY_KEY_ID && e.RAZORPAY_KEY_SECRET
        ? clean({ keyId: e.RAZORPAY_KEY_ID, keySecret: e.RAZORPAY_KEY_SECRET, webhookSecret: e.RAZORPAY_WEBHOOK_SECRET })
        : null;
    case 'MSG91':
      return e.SMS_PROVIDER === 'msg91' && e.SMS_API_KEY ? clean({ authKey: e.SMS_API_KEY, senderId: e.SMS_SENDER_ID }) : null;
    case 'WHATSAPP_CLOUD':
      return e.WHATSAPP_PROVIDER === 'cloud' && e.WHATSAPP_PHONE_NUMBER_ID && e.WHATSAPP_ACCESS_TOKEN
        ? clean({ phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID, accessToken: e.WHATSAPP_ACCESS_TOKEN })
        : null;
    case 'SMTP':
      return e.EMAIL_PROVIDER === 'smtp' && e.SMTP_HOST
        ? clean({ host: e.SMTP_HOST, port: e.SMTP_PORT ?? 587, user: e.SMTP_USER, pass: e.SMTP_PASS, ...parseFrom(e.EMAIL_FROM) })
        : null;
    case 'OPENAI':
      return e.LLM_PROVIDER === 'openai' && e.OPENAI_API_KEY ? clean({ apiKey: e.OPENAI_API_KEY, model: e.OPENAI_MODEL }) : null;
  }
}

/** A saved configuration is usable when every required field has a value. */
export function isComplete(provider: IntegrationProviderKey, values: Record<string, unknown>) {
  return INTEGRATIONS[provider].fields.every((f) => !f.required || (values[f.key] !== undefined && values[f.key] !== null && values[f.key] !== ''));
}

function withDefaults(provider: IntegrationProviderKey, values: Record<string, unknown>): IntegrationValues {
  const out: IntegrationValues = {};
  for (const f of INTEGRATIONS[provider].fields) {
    const v = values[f.key];
    if (v !== undefined && v !== null && v !== '') out[f.key] = v as string | number | boolean;
    else if (f.defaultValue !== undefined) out[f.key] = f.defaultValue;
  }
  return out;
}

/**
 * Integration credentials, resolved per business: its own keys (when enabled) win over the
 * platform keys set in the super-admin console, which win over environment variables.
 */
@Injectable()
export class IntegrationsConfigService {
  private readonly logger = new Logger(IntegrationsConfigService.name);
  private readonly cache = new Map<string, { row: StoredRow | null; at: number; version: string }>();

  constructor(
    @InjectDb() private readonly db: Db,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private async version() {
    return (await this.redis.get(VERSION_KEY).catch(() => null)) ?? '0';
  }

  private async load(provider: IntegrationProviderKey, tenantId: string | null): Promise<StoredRow | null> {
    const key = `${tenantId ?? 'platform'}:${provider}`;
    const version = await this.version();
    const hit = this.cache.get(key);
    if (hit && hit.version === version && Date.now() - hit.at < TTL_MS) return hit.row;
    const r = await this.db.integrationConfig.findFirst({ where: { tenantId, provider: provider as IntegrationProvider } });
    let row: StoredRow | null = null;
    if (r) {
      let secrets: Record<string, string> = {};
      if (r.secrets) {
        try {
          secrets = openJson(r.secrets);
        } catch (e) {
          this.logger.error(`Cannot decrypt ${provider} secrets for ${tenantId ?? 'platform'} (was SETTINGS_ENCRYPTION_KEY changed?): ${(e as Error).message}`);
        }
      }
      row = { id: r.id, enabled: r.enabled, config: (r.config ?? {}) as StoredRow['config'], secrets, updatedAt: r.updatedAt };
    }
    this.cache.set(key, { row, at: Date.now(), version });
    return row;
  }

  private usable(provider: IntegrationProviderKey, row: StoredRow | null): IntegrationValues | null {
    if (!row?.enabled) return null;
    const values = withDefaults(provider, { ...row.config, ...row.secrets });
    return isComplete(provider, values) ? values : null;
  }

  /** Every usable credential set for a business, most specific first (used to match stored gateway key ids). */
  async candidates(provider: IntegrationProviderKey, tenantId: string | null | undefined): Promise<ResolvedIntegration[]> {
    const out: ResolvedIntegration[] = [];
    if (tenantId && TENANT_INTEGRATIONS.includes(provider)) {
      const own = this.usable(provider, await this.load(provider, tenantId));
      if (own) out.push({ source: 'tenant', values: own });
    }
    const platform = this.usable(provider, await this.load(provider, null));
    if (platform) out.push({ source: 'platform', values: platform });
    const fromEnv = envIntegration(provider);
    if (fromEnv) out.push({ source: 'env', values: withDefaults(provider, fromEnv) });
    return out;
  }

  async resolve(provider: IntegrationProviderKey, tenantId: string | null | undefined): Promise<ResolvedIntegration | null> {
    return (await this.candidates(provider, tenantId))[0] ?? null;
  }

  async source(provider: IntegrationProviderKey, tenantId: string | null | undefined): Promise<IntegrationSource> {
    return (await this.resolve(provider, tenantId))?.source ?? 'mock';
  }

  /** Safe representation for the settings screens: secrets are reduced to "set" + last four characters. */
  async view(provider: IntegrationProviderKey, tenantId: string | null): Promise<IntegrationView> {
    const row = await this.load(provider, tenantId);
    const def = INTEGRATIONS[provider];
    const config: IntegrationView['config'] = {};
    const secrets: IntegrationView['secrets'] = {};
    for (const f of def.fields) {
      if (f.secret) secrets[f.key] = { set: !!row?.secrets[f.key], hint: secretHint(row?.secrets[f.key]) };
      else config[f.key] = (row?.config[f.key] as string | number | boolean | undefined) ?? null;
    }
    const values = row ? withDefaults(provider, { ...row.config, ...row.secrets }) : {};
    return {
      provider,
      enabled: row?.enabled ?? false,
      configured: !!row && isComplete(provider, values),
      config,
      secrets,
      effectiveSource: await this.source(provider, tenantId),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async list(tenantId: string | null) {
    const providers = tenantId ? TENANT_INTEGRATIONS : (Object.keys(INTEGRATIONS) as IntegrationProviderKey[]);
    return Promise.all(providers.map((p) => this.view(p, tenantId)));
  }

  /** Merges an update into the stored row. Blank secrets keep their value; `clear` erases them. */
  async update(provider: IntegrationProviderKey, tenantId: string | null, input: IntegrationUpdateInput, actor?: string) {
    if (tenantId && !TENANT_INTEGRATIONS.includes(provider)) throw AppError.forbidden(`${INTEGRATIONS[provider].name} can only be configured by the platform.`);
    const current = await this.db.integrationConfig.findFirst({ where: { tenantId, provider: provider as IntegrationProvider } });
    let secrets: Record<string, string> = {};
    if (current?.secrets) {
      try {
        secrets = openJson(current.secrets);
      } catch {
        secrets = {};
      }
    }
    for (const [k, v] of Object.entries(input.secrets ?? {})) if (typeof v === 'string' && v.trim()) secrets[k] = v.trim();
    for (const k of input.clear ?? []) delete secrets[k];
    const config: Record<string, unknown> = { ...((current?.config ?? {}) as Record<string, unknown>) };
    for (const [k, v] of Object.entries(input.config ?? {})) {
      if (v === undefined) continue;
      if (v === null || v === '') delete config[k];
      else config[k] = v;
    }
    if (input.enabled && !isComplete(provider, withDefaults(provider, { ...config, ...secrets }))) {
      const missing = INTEGRATIONS[provider].fields.filter((f) => f.required && !(config[f.key] ?? secrets[f.key])).map((f) => f.label);
      throw AppError.validation(`Fill in ${missing.join(', ')} before enabling ${INTEGRATIONS[provider].name}.`);
    }
    const data = {
      enabled: input.enabled,
      config: config as Prisma.InputJsonValue,
      secrets: Object.keys(secrets).length ? sealJson(secrets) : null,
      updatedBy: actor ?? null,
    };
    if (current) await this.db.integrationConfig.update({ where: { id: current.id }, data });
    else await this.db.integrationConfig.create({ data: { tenantId, provider: provider as IntegrationProvider, ...data } });
    await this.invalidate();
    return {
      view: await this.view(provider, tenantId),
      changed: { enabled: input.enabled, config: Object.keys(input.config ?? {}), secrets: Object.keys(input.secrets ?? {}).filter((k) => input.secrets?.[k]), cleared: input.clear ?? [] },
    };
  }

  async invalidate() {
    this.cache.clear();
    await this.redis.incr(VERSION_KEY).catch(() => undefined);
  }
}
