import { Controller, Get, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { RequestContext } from '../../common/context/request-context';
import { RequirePermissions } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { QUEUES, QueueService } from '../../jobs/queue.service';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { FranchiseModule } from '../franchise/franchise.module';
import { RetentionModule } from '../retention/retention.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { AUTOMATION_JOBS, AutomationJob, AutomationService } from './automation.service';

@ApiTags('Automation')
@ApiBearerAuth()
@Controller('automation')
export class AutomationController {
  constructor(
    private readonly automation: AutomationService,
    private readonly settings: SettingsService,
    private readonly queues: QueueService,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_MANAGE)
  async status() {
    const tenantId = RequestContext.requireTenantId();
    const counts = await Promise.all(
      [QUEUES.EVENTS, QUEUES.NOTIFICATIONS, QUEUES.SCHEDULED].map(async (q) => ({
        queue: q,
        ...(await this.queues
          .queue(q)
          .getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
          .catch(() => ({}))),
      })),
    );
    const schedulers = await this.queues
      .queue(QUEUES.SCHEDULED)
      .getJobSchedulers()
      .catch(() => []);
    return {
      lastDailyRun: (await this.settings.get<string>(tenantId, 'LAST_DAILY_JOBS')) ?? null,
      jobs: AUTOMATION_JOBS,
      queues: counts,
      schedulers: schedulers.map((s) => ({ key: s.key, name: s.name, every: s.every ?? null, pattern: s.pattern ?? null, next: s.next ? new Date(s.next) : null })),
    };
  }

  /** Runs a job immediately for the caller's tenant only (useful for testing and catch-up). */
  @Post('jobs/:name/run')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_MANAGE)
  async run(@Param('name') name: string) {
    if (!AUTOMATION_JOBS.includes(name as AutomationJob)) throw AppError.notFound('Job');
    const result = await this.automation.run(name as AutomationJob, { force: true });
    await this.audit.log({ action: 'AUTOMATION_JOB_RUN', entityType: 'Automation', entityId: name, newValues: result });
    return { job: name, result };
  }
}

@Module({
  imports: [CampaignsModule, RetentionModule, FranchiseModule, SubscriptionModule],
  controllers: [AutomationController],
  providers: [AutomationService],
})
export class AutomationModule {}
