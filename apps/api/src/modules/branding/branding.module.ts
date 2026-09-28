import { Body, Controller, Get, Injectable, Module, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { brandingSchema } from '@therapyos/validation';
import { z } from 'zod';
import { Public, RequireFeature, RequirePermissions } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { Zod } from '../../common/pipes/zod.pipe';
import { AuditService } from '../../core/audit.service';
import { FeaturesService } from '../../core/features.service';

type BrandingInput = z.infer<typeof brandingSchema>;
const publicQuery = z.object({ slug: z.string().max(80).optional(), domain: z.string().max(253).optional() }).refine((q) => q.slug || q.domain, 'slug or domain is required');

@Injectable()
export class BrandingService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly features: FeaturesService,
  ) {}

  get() {
    return this.db.tenantBranding.findUnique({ where: { tenantId: RequestContext.requireTenantId() } });
  }

  async update(input: BrandingInput) {
    const tenantId = RequestContext.requireTenantId();
    if (input.customDomain) {
      const taken = await this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant_branding WHERE "customDomain" = ${input.customDomain} AND "tenantId" <> ${tenantId}`;
      if (taken[0]?.n) throw AppError.conflict('That domain is already connected to another business');
    }
    const data = {
      appName: input.appName ?? null,
      primaryColor: input.primaryColor ?? null,
      accentColor: input.accentColor ?? null,
      logoUrl: input.logoUrl ?? null,
      customDomain: input.customDomain ?? null,
      emailSenderName: input.emailSenderName ?? null,
      emailSenderAddress: input.emailSenderAddress ?? null,
      whatsappDisplayName: input.whatsappDisplayName ?? null,
      invoiceFooter: input.invoiceFooter ?? null,
      poweredBy: input.poweredBy,
    };
    const before = await this.db.tenantBranding.findUnique({ where: { tenantId } });
    const saved = await this.db.tenantBranding.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
    await this.audit.log({ action: 'BRANDING_UPDATED', entityType: 'TenantBranding', entityId: saved.id, oldValues: before, newValues: data });
    return saved;
  }

  /** Branding for unauthenticated pages (booking, feedback), resolved by tenant slug or connected custom domain. */
  async publicBranding(q: { slug?: string; domain?: string }) {
    const tenant = q.slug
      ? await this.db.tenant.findUnique({ where: { slug: q.slug }, select: { id: true, name: true, logoUrl: true, slug: true, status: true } })
      : await this.db.tenantBranding
          .findFirst({ where: { customDomain: q.domain!.toLowerCase() }, select: { tenantId: true } })
          .then((b) => (b ? this.db.tenant.findUnique({ where: { id: b.tenantId }, select: { id: true, name: true, logoUrl: true, slug: true, status: true } }) : null));
    if (!tenant || tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED') throw AppError.notFound('Business');
    const whiteLabel = (await this.features.getFeatures(tenant.id)).includes(FeatureFlagKey.WHITE_LABEL);
    if (q.domain && !whiteLabel) throw AppError.notFound('Business');
    const b = whiteLabel ? await this.db.tenantBranding.findUnique({ where: { tenantId: tenant.id } }) : null;
    return {
      slug: tenant.slug,
      name: b?.appName ?? tenant.name,
      logoUrl: b?.logoUrl ?? tenant.logoUrl,
      primaryColor: b?.primaryColor ?? null,
      accentColor: b?.accentColor ?? null,
      poweredBy: b ? b.poweredBy : true,
    };
  }
}

@ApiTags('Branding')
@ApiBearerAuth()
@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  get() {
    return this.branding.get();
  }

  @Put()
  @RequireFeature(FeatureFlagKey.WHITE_LABEL)
  @RequirePermissions(PERMISSIONS.BRANDING_MANAGE)
  update(@Body(Zod(brandingSchema)) body: BrandingInput) {
    return this.branding.update(body);
  }
}

@ApiTags('Branding')
@Controller('public/branding')
export class PublicBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Public()
  @Get()
  get(@Query(Zod(publicQuery)) q: z.infer<typeof publicQuery>) {
    return this.branding.publicBranding(q);
  }
}

@Module({ controllers: [BrandingController, PublicBrandingController], providers: [BrandingService], exports: [BrandingService] })
export class BrandingModule {}
