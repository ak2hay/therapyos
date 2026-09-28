import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../common/prisma/prisma.service';

export interface ActivityInput {
  customerId: string;
  branchId?: string | null;
  type: string;
  title: string;
  refType?: string;
  refId?: string;
  meta?: Record<string, unknown>;
  occurredAt?: Date;
}

/** Writes entries to the unified customer timeline (spec section 13). */
@Injectable()
export class ActivityService {
  constructor(@InjectDb() private readonly db: Db) {}

  async record(input: ActivityInput, tx?: DbOrTx) {
    const client = tx ?? this.db;
    await client.customerActivity.create({
      data: {
        tenantId: RequestContext.requireTenantId(),
        customerId: input.customerId,
        branchId: input.branchId ?? null,
        type: input.type,
        title: input.title,
        refType: input.refType,
        refId: input.refId,
        meta: (input.meta ?? undefined) as Prisma.InputJsonValue | undefined,
        occurredAt: input.occurredAt ?? new Date(),
      },
    });
  }
}
