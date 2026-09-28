import { Controller, Get, Module, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { reportExportQuery, reportQuery, ReportQuery } from '@therapyos/validation';
import type { Response } from 'express';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context';
import { RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { Zod } from '../../common/pipes/zod.pipe';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { DashboardService } from './dashboard.service';
import { reportCsv, reportPdf, reportXlsx } from './report-export';
import { REPORTS } from './report-types';
import { ReportsService } from './reports.service';

const branchQuery = z.object({ branchId: z.string().optional() });

@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @InjectDb() private readonly db: Db,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.REPORTS_READ)
  catalogue() {
    const financial = RequestContext.hasPermission(PERMISSIONS.REPORTS_FINANCIAL);
    return Object.entries(REPORTS)
      .filter(([, r]) => financial || !r.financial)
      .map(([key, r]) => ({ key, title: r.title, financial: r.financial }));
  }

  @Get(':key')
  @RequirePermissions(PERMISSIONS.REPORTS_READ)
  run(@Param('key') key: string, @Query(Zod(reportQuery)) q: ReportQuery) {
    return this.reports.run(key, q);
  }

  @Get(':key/export')
  @RequirePermissions(PERMISSIONS.REPORTS_READ, PERMISSIONS.REPORTS_EXPORT)
  async export(
    @Param('key') key: string,
    @Query(Zod(reportExportQuery)) q: z.infer<typeof reportExportQuery>,
    @Query('table') table: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const report = await this.reports.run(key, q);
    const tenantId = RequestContext.requireTenantId();
    const [tenant, branch, currency] = await Promise.all([
      this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      q.branchId ? this.db.branch.findFirst({ where: { id: q.branchId }, select: { name: true } }) : null,
      this.settings.get<string>(tenantId, 'CURRENCY'),
    ]);
    const meta = { businessName: tenant?.name ?? 'Business', branchName: branch?.name ?? null, currency: currency ?? 'INR', generatedBy: RequestContext.get('userName') ?? null };
    const base = `${key}-${q.from}-to-${q.to}`;
    let buffer: Buffer;
    let type: string;
    let ext: string;
    if (q.format === 'xlsx') {
      buffer = await reportXlsx(report, meta);
      type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      ext = 'xlsx';
    } else if (q.format === 'pdf') {
      buffer = await reportPdf(report, meta);
      type = 'application/pdf';
      ext = 'pdf';
    } else {
      buffer = reportCsv(report, table || undefined);
      type = 'text/csv; charset=utf-8';
      ext = 'csv';
    }
    await this.audit.log({ action: 'REPORT_EXPORTED', entityType: 'Report', entityId: key, newValues: { from: q.from, to: q.to, branchId: q.branchId, format: q.format } });
    res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${base}.${ext}"`, 'Cache-Control': 'private, no-store' });
    return new StreamableFile(buffer);
  }
}

@ApiTags('Dashboards')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboards: DashboardService) {}

  @Get('overview')
  @RequirePermissions(PERMISSIONS.REPORTS_READ)
  overview(@Query(Zod(branchQuery)) q: z.infer<typeof branchQuery>) {
    return this.dashboards.overview(q.branchId);
  }

  @Get('front-desk')
  @RequireAnyPermission(PERMISSIONS.APPOINTMENT_READ, PERMISSIONS.QUEUE_READ, PERMISSIONS.POS_USE)
  frontDesk(@Query(Zod(branchQuery)) q: z.infer<typeof branchQuery>) {
    return this.dashboards.frontDesk(q.branchId);
  }

  @Get('therapist')
  @RequireAnyPermission(PERMISSIONS.SESSION_READ_OWN, PERMISSIONS.SESSION_READ)
  therapist() {
    return this.dashboards.therapist();
  }

  @Get('accounts')
  @RequirePermissions(PERMISSIONS.REPORTS_FINANCIAL)
  accounts(@Query(Zod(branchQuery)) q: z.infer<typeof branchQuery>) {
    return this.dashboards.accounts(q.branchId);
  }
}

@Module({ controllers: [ReportsController, DashboardController], providers: [ReportsService, DashboardService] })
export class ReportsModule {}
