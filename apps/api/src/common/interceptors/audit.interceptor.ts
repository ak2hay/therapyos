import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AuditService } from '../../core/audit.service';
import { AUDIT_KEY } from '../decorators';

/** Writes an audit entry for routes annotated with @Audit() once the handler succeeds. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<{ action: string; entityType: string }>(AUDIT_KEY, context.getHandler());
    if (!meta || context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    return next.handle().pipe(
      tap((result: any) => {
        void this.audit.log({
          action: meta.action,
          entityType: meta.entityType,
          entityId: result?.id ?? req.params?.id ?? null,
          newValues: req.body,
        });
      }),
    );
  }
}
