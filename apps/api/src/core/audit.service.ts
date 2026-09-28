import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { DbOrTx, InjectDb, Db } from '../common/prisma/prisma.service';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  tenantId?: string | null;
}

const SECRET_KEYS = /password|token|secret|hash|otp/i;

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return Number(value);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(@InjectDb() private readonly db: Db) {}

  async log(entry: AuditEntry, tx?: DbOrTx) {
    const client = tx ?? this.db;
    try {
      await client.auditLog.create({
        data: {
          tenantId: entry.tenantId ?? RequestContext.tenantId ?? null,
          userId: RequestContext.userId ?? RequestContext.get('platformAdminId') ?? null,
          actorType: RequestContext.get('platformAdminId') ? 'PLATFORM_ADMIN' : RequestContext.userId ? 'USER' : 'SYSTEM',
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          oldValues: (redact(entry.oldValues) ?? undefined) as Prisma.InputJsonValue | undefined,
          newValues: (redact(entry.newValues) ?? undefined) as Prisma.InputJsonValue | undefined,
          ipAddress: RequestContext.get('ip') ?? null,
          userAgent: RequestContext.get('userAgent') ?? null,
          requestId: RequestContext.requestId,
        },
      });
    } catch (err) {
      if (tx) throw err;
      this.logger.error(`Failed to write audit log ${entry.action}: ${(err as Error).message}`);
    }
  }
}
