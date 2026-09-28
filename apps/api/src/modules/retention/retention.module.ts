import { Controller, Get, Module, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { retentionCustomersQuery, retentionOverviewQuery } from '@therapyos/validation';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { AuditService } from '../../core/audit.service';
import { RetentionService } from './retention.service';

@ApiTags('Retention')
@ApiBearerAuth()
@Controller('retention')
export class RetentionController {
  constructor(
    private readonly retention: RetentionService,
    private readonly audit: AuditService,
  ) {}

  @Get('overview')
  @RequirePermissions(PERMISSIONS.RETENTION_READ)
  overview(@Query(Zod(retentionOverviewQuery)) q: z.infer<typeof retentionOverviewQuery>) {
    return this.retention.overview(q.branchId);
  }

  @Get('customers')
  @RequirePermissions(PERMISSIONS.RETENTION_READ)
  customers(@Query(Zod(retentionCustomersQuery)) q: z.infer<typeof retentionCustomersQuery>) {
    return this.retention.customers(q);
  }

  @Post('recompute')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  async recompute() {
    const result = await this.retention.recomputeAll();
    await this.audit.log({ action: 'RETENTION_RECOMPUTED', entityType: 'CustomerMetrics', newValues: result });
    return result;
  }
}

@Module({ controllers: [RetentionController], providers: [RetentionService], exports: [RetentionService] })
export class RetentionModule {}
