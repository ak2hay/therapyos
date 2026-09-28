import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { map, Observable } from 'rxjs';
import { RequestContext } from '../context/request-context';
import { RAW_RESPONSE } from '../decorators';
import { PagedResult } from '../utils/pagination';

const HIDDEN_KEYS = new Set(['passwordHash', 'tokenHash', 'keyHash', 'inviteTokenHash']);

/** Recursively converts Prisma Decimals to numbers so clients receive plain JSON numbers. */
export function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Prisma.Decimal.isDecimal(value)) return Number(value);
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (HIDDEN_KEYS.has(k)) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [context.getHandler(), context.getClass()]);
    if (raw) return next.handle();
    return next.handle().pipe(
      map((data) => {
        if (data instanceof StreamableFile) return data;
        const res = context.switchToHttp().getResponse();
        if (res.headersSent) return data;
        const requestId = RequestContext.requestId;
        if (data instanceof PagedResult) {
          return { success: true, data: normalize(data.items), meta: data.meta, requestId };
        }
        return { success: true, data: normalize(data ?? null), requestId };
      }),
    );
  }
}
