import { Body, Controller, Delete, Get, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { API_KEY_SCOPES, FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { apiKeySchema } from '@therapyos/validation';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context';
import { RequireFeature, RequirePermissions } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { API_KEY_PREFIX } from '../../common/guards/auth.guard';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { Zod } from '../../common/pipes/zod.pipe';
import { env } from '../../config/env';
import { AuditService } from '../../core/audit.service';

const ALLOWED = new Set<string>(API_KEY_SCOPES.map((s) => s.scope));
const MAX_ACTIVE_KEYS = 10;

@Injectable()
export class ApiKeysService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const keys = await this.db.apiKey.findMany({ orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }] });
    const creators = await this.db.user.findMany({ where: { id: { in: keys.map((k) => k.createdBy).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const byId = new Map(creators.map((c) => [c.id, c.name]));
    return {
      keys: keys.map(({ keyHash: _hash, ...k }) => ({ ...k, createdByName: k.createdBy ? byId.get(k.createdBy) ?? null : null })),
      scopes: API_KEY_SCOPES,
      docsUrl: `${env().API_URL}/api/docs`,
    };
  }

  /** Returns the raw key exactly once; only its SHA-256 hash is stored. */
  async create(input: z.infer<typeof apiKeySchema>) {
    const tenantId = RequestContext.requireTenantId();
    const invalid = input.scopes.filter((s) => !ALLOWED.has(s));
    if (invalid.length) throw AppError.validation(`Unsupported scopes: ${invalid.join(', ')}`);
    const active = await this.db.apiKey.count({ where: { revokedAt: null } });
    if (active >= MAX_ACTIVE_KEYS) throw AppError.invalidState(`You can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
    const raw = `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
    const key = await this.db.apiKey.create({
      data: { tenantId, name: input.name, prefix: raw.slice(0, 12), keyHash: createHash('sha256').update(raw).digest('hex'), scopes: [...new Set(input.scopes)], createdBy: RequestContext.userId },
    });
    await this.audit.log({ action: 'API_KEY_CREATED', entityType: 'ApiKey', entityId: key.id, newValues: { name: input.name, scopes: input.scopes, prefix: key.prefix } });
    const { keyHash: _hash, ...rest } = key;
    return { ...rest, key: raw };
  }

  async revoke(id: string) {
    const key = await this.db.apiKey.findFirst({ where: { id } });
    if (!key) throw AppError.notFound('API key');
    if (key.revokedAt) throw AppError.invalidState('This key is already revoked.');
    await this.db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.log({ action: 'API_KEY_REVOKED', entityType: 'ApiKey', entityId: id, oldValues: { name: key.name, prefix: key.prefix } });
    return { revoked: true };
  }
}

@ApiTags('API keys')
@ApiBearerAuth()
@RequireFeature(FeatureFlagKey.API_ACCESS)
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.API_KEY_MANAGE)
  list() {
    return this.keys.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.API_KEY_MANAGE)
  create(@Body(Zod(apiKeySchema)) body: z.infer<typeof apiKeySchema>) {
    return this.keys.create(body);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.API_KEY_MANAGE)
  revoke(@Param('id') id: string) {
    return this.keys.revoke(id);
  }
}

@Module({ controllers: [ApiKeysController], providers: [ApiKeysService] })
export class ApiKeysModule {}
