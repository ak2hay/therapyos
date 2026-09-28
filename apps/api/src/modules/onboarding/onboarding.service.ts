import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { FeatureFlagKey } from '@therapyos/types';
import { branchSchema, email, emptyToUndefined, phone, updateTenantSchema } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { AuditService } from '../../core/audit.service';
import { AuthzService } from '../../core/authz.service';
import { EventsService } from '../../core/events.service';
import { FeaturesService } from '../../core/features.service';
import { SettingsService } from '../../core/settings.service';
import { BranchesService } from '../branches/branches.service';
import { ServicesService } from '../catalog/services.service';
import { TherapistsService } from '../catalog/therapists.service';
import { UsersService } from '../users/users.service';
import { BUSINESS_DEFAULTS, BUSINESS_TEMPLATES } from '../catalog/business-templates';

export const ONBOARDING_STEPS = [
  { step: 1, key: 'business', title: 'Business details', optional: false },
  { step: 2, key: 'logo', title: 'Logo', optional: true },
  { step: 3, key: 'address', title: 'Address & tax', optional: false },
  { step: 4, key: 'branch', title: 'First branch', optional: false },
  { step: 5, key: 'services', title: 'Services', optional: false },
  { step: 6, key: 'prices', title: 'Prices & tax', optional: false },
  { step: 7, key: 'therapists', title: 'Therapists', optional: true },
  { step: 8, key: 'payments', title: 'Payment setup', optional: true },
  { step: 9, key: 'whatsapp', title: 'WhatsApp', optional: true },
  { step: 10, key: 'golive', title: 'Go live', optional: false },
] as const;

const stepSchemas = {
  1: updateTenantSchema.pick({ name: true, legalName: true, phone: true, email: true, businessType: true }).required({ name: true, businessType: true }),
  2: z.object({ logoUrl: emptyToUndefined(z.string().url()) }),
  3: updateTenantSchema.pick({ address: true, taxId: true, timezone: true, currency: true, country: true }),
  4: branchSchema,
  5: z.object({
    services: z
      .array(
        z.object({
          name: z.string().trim().min(2).max(120),
          category: z.string().trim().min(1).max(80),
          durationMinutes: z.coerce.number().int().min(5).max(600),
          basePrice: z.coerce.number().min(0),
        }),
      )
      .min(1, 'Add at least one service'),
  }),
  6: z.object({
    tax: z.object({ name: z.string().min(1), rate: z.coerce.number().min(0).max(100), isInclusive: z.boolean().default(false) }).optional(),
    prices: z.array(z.object({ serviceId: z.string(), basePrice: z.coerce.number().min(0), taxRate: z.coerce.number().min(0).max(100).optional() })).default([]),
  }),
  7: z.object({
    therapists: z
      .array(
        z.object({
          name: z.string().trim().min(2).max(120),
          phone: emptyToUndefined(phone),
          email: emptyToUndefined(email),
          specialization: emptyToUndefined(z.string().max(200)),
          invite: z.boolean().default(false),
        }),
      )
      .default([]),
  }),
  8: z.object({
    methods: z.array(z.enum(['CASH', 'UPI', 'CARD', 'ONLINE', 'BANK_TRANSFER'])).min(1),
    upiId: emptyToUndefined(z.string().max(80)),
    onlineGateway: z.enum(['NONE', 'RAZORPAY']).default('NONE'),
  }),
  9: z.object({
    enabled: z.boolean().default(false),
    phoneNumber: emptyToUndefined(phone),
    displayName: emptyToUndefined(z.string().max(80)),
  }),
  10: z.object({}).passthrough(),
} as const;

@Injectable()
export class OnboardingService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
    private readonly events: EventsService,
    private readonly features: FeaturesService,
    private readonly settings: SettingsService,
    private readonly branches: BranchesService,
    private readonly services: ServicesService,
    private readonly therapists: TherapistsService,
    private readonly users: UsersService,
  ) {}

  async state() {
    const tenantId = RequestContext.requireTenantId();
    const [tenant, branches, services, therapists, taxRates, staff, settings] = await Promise.all([
      this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      this.db.branch.findMany({ orderBy: { createdAt: 'asc' } }),
      this.db.service.findMany({ where: { status: 'ACTIVE' }, include: { category: { select: { name: true } } }, orderBy: { name: 'asc' } }),
      this.db.therapist.findMany({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } }),
      this.db.taxRate.findMany({ where: { status: 'ACTIVE' } }),
      this.db.user.count(),
      this.settings.getAll(tenantId),
    ]);
    return {
      currentStep: tenant.onboardingStep,
      completed: !!tenant.onboardingCompletedAt,
      steps: ONBOARDING_STEPS,
      data: (tenant.onboardingData as Record<string, unknown>) ?? {},
      tenant: {
        name: tenant.name,
        legalName: tenant.legalName,
        phone: tenant.phone,
        email: tenant.email,
        businessType: tenant.businessType,
        logoUrl: tenant.logoUrl,
        address: tenant.address,
        taxId: tenant.taxId,
        timezone: tenant.timezone,
        currency: tenant.currency,
        country: tenant.country,
      },
      branches,
      services,
      therapists,
      taxRates,
      staffCount: staff,
      settings: { PAYMENT_PROVIDERS: settings.PAYMENT_PROVIDERS, UPI_ID: settings.UPI_ID, WHATSAPP_ENABLED: settings.WHATSAPP_ENABLED },
    };
  }

  template(businessType: string) {
    const categories = BUSINESS_TEMPLATES[businessType] ?? BUSINESS_TEMPLATES.OTHER;
    return { businessType, categories, defaults: BUSINESS_DEFAULTS[businessType] ?? {} };
  }

  async saveStep(step: number, raw: Record<string, unknown>) {
    const tenantId = RequestContext.requireTenantId();
    const schema = stepSchemas[step as keyof typeof stepSchemas];
    if (!schema) throw AppError.validation('Unknown onboarding step.');
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.validation(parsed.error.issues[0]?.message ?? 'Invalid data', parsed.error.flatten());
    }
    const data = parsed.data as Record<string, any>;

    switch (step) {
      case 1: {
        await this.db.tenant.update({ where: { id: tenantId }, data: data as Prisma.TenantUpdateInput });
        const defaults = BUSINESS_DEFAULTS[data.businessType as string];
        if (defaults) await this.settings.setMany(tenantId, defaults);
        break;
      }
      case 2:
        await this.db.tenant.update({ where: { id: tenantId }, data: { logoUrl: data.logoUrl ?? null } });
        break;
      case 3:
        await this.db.tenant.update({ where: { id: tenantId }, data: data as Prisma.TenantUpdateInput });
        await this.settings.invalidate(tenantId);
        break;
      case 4: {
        const first = await this.db.branch.findFirst({ orderBy: { createdAt: 'asc' } });
        if (first) await this.branches.update(first.id, data as never);
        else await this.branches.create(data as never);
        break;
      }
      case 5:
        await this.createServices(data.services);
        break;
      case 6:
        await this.applyPrices(data as z.infer<(typeof stepSchemas)[6]>);
        break;
      case 7:
        await this.createTherapists(data.therapists);
        break;
      case 8:
        await this.settings.setMany(tenantId, {
          PAYMENT_PROVIDERS: data.methods,
          UPI_ID: data.upiId ?? null,
          ONLINE_GATEWAY: data.onlineGateway,
        });
        break;
      case 9:
        await this.settings.setMany(tenantId, {
          WHATSAPP_ENABLED: data.enabled,
          WHATSAPP_NUMBER: data.phoneNumber ?? null,
          WHATSAPP_DISPLAY_NAME: data.displayName ?? null,
        });
        if (data.enabled && (await this.planIncludes(tenantId, FeatureFlagKey.WHATSAPP_ENABLED))) {
          await this.db.featureFlag.upsert({
            where: { tenantId_key: { tenantId, key: FeatureFlagKey.WHATSAPP_ENABLED } },
            create: { tenantId, key: FeatureFlagKey.WHATSAPP_ENABLED, enabled: true },
            update: { enabled: true },
          });
          await this.features.invalidate(tenantId);
        }
        break;
      case 10:
        return this.complete();
    }

    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const stored = { ...((tenant.onboardingData as Record<string, unknown>) ?? {}), [step]: this.redactForStorage(step, data) };
    await this.db.tenant.update({
      where: { id: tenantId },
      data: { onboardingStep: Math.max(tenant.onboardingStep, step + 1), onboardingData: stored as Prisma.InputJsonValue },
    });
    await this.authz.invalidateTenant(tenantId);
    return this.state();
  }

  async skip(step: number) {
    const def = ONBOARDING_STEPS.find((s) => s.step === step);
    if (!def) throw AppError.validation('Unknown onboarding step.');
    if (!def.optional) throw AppError.invalidState(`${def.title} cannot be skipped.`);
    const tenantId = RequestContext.requireTenantId();
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    await this.db.tenant.update({ where: { id: tenantId }, data: { onboardingStep: Math.max(tenant.onboardingStep, step + 1) } });
    return this.state();
  }

  private redactForStorage(step: number, data: Record<string, unknown>) {
    if (step === 5 || step === 7) return { count: (data.services ?? data.therapists ?? []) instanceof Array ? ((data.services ?? data.therapists) as unknown[]).length : 0 };
    return data;
  }

  private async planIncludes(tenantId: string, key: string) {
    const sub = await this.db.tenantSubscription.findFirst({ where: { tenantId, isCurrent: true }, include: { plan: true } });
    return !!sub?.plan.features.includes(key);
  }

  private async createServices(list: z.infer<(typeof stepSchemas)[5]>['services']) {
    const tenantId = RequestContext.requireTenantId();
    const categoryIds = new Map<string, string>();
    const existingCats = await this.db.serviceCategory.findMany();
    existingCats.forEach((c) => categoryIds.set(c.name.toLowerCase(), c.id));
    const existingServices = new Set((await this.db.service.findMany({ select: { name: true } })).map((s) => s.name.toLowerCase()));
    let sort = existingCats.length;
    for (const s of list) {
      if (existingServices.has(s.name.toLowerCase())) continue;
      let categoryId = categoryIds.get(s.category.toLowerCase());
      if (!categoryId) {
        const cat = await this.db.serviceCategory.create({ data: { tenantId, name: s.category, sortOrder: sort++ } });
        categoryId = cat.id;
        categoryIds.set(s.category.toLowerCase(), cat.id);
      }
      await this.services.create({ name: s.name, categoryId, durationMinutes: s.durationMinutes, basePrice: s.basePrice, taxRate: 0, status: 'ACTIVE' });
      existingServices.add(s.name.toLowerCase());
    }
  }

  private async applyPrices(data: z.infer<(typeof stepSchemas)[6]>) {
    const tenantId = RequestContext.requireTenantId();
    let defaultRate: number | undefined;
    if (data.tax) {
      defaultRate = data.tax.rate;
      const existing = await this.db.taxRate.findFirst({ where: { name: data.tax.name } });
      await this.db.taxRate.updateMany({ where: {}, data: { isDefault: false } });
      if (existing) {
        await this.db.taxRate.update({ where: { id: existing.id }, data: { rate: data.tax.rate, isInclusive: data.tax.isInclusive, isDefault: true, status: 'ACTIVE' } });
      } else {
        await this.db.taxRate.create({ data: { tenantId, name: data.tax.name, rate: data.tax.rate, isInclusive: data.tax.isInclusive, isDefault: true } });
      }
      await this.settings.setMany(tenantId, { TAX_MODE: data.tax.isInclusive ? 'INCLUSIVE' : 'EXCLUSIVE' });
    }
    for (const p of data.prices) {
      await this.db.service.updateMany({ where: { id: p.serviceId }, data: { basePrice: p.basePrice, taxRate: p.taxRate ?? defaultRate } });
    }
    if (defaultRate !== undefined && !data.prices.length) {
      await this.db.service.updateMany({ where: {}, data: { taxRate: defaultRate } });
    }
  }

  private async createTherapists(list: z.infer<(typeof stepSchemas)[7]>['therapists']) {
    const branch = await this.db.branch.findFirst({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
    if (!branch) throw AppError.invalidState('Create your first branch before adding therapists.');
    const serviceIds = (await this.db.service.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })).map((s) => s.id);
    const therapistRole = await this.db.role.findFirst({ where: { key: 'THERAPIST' } });

    for (const t of list) {
      let therapistId: string;
      if (t.invite && t.email && therapistRole) {
        const user = await this.users.create({
          name: t.name,
          email: t.email,
          phone: t.phone,
          roles: [{ roleId: therapistRole.id, branchId: branch.id }],
          sendInvite: true,
          isTherapist: true,
        });
        therapistId = user.therapist!.id;
        await this.therapists.update(therapistId, { specialization: t.specialization, serviceIds, primaryBranchId: branch.id });
      } else {
        const created = await this.therapists.create({
          name: t.name,
          phone: t.phone,
          specialization: t.specialization,
          primaryBranchId: branch.id,
          serviceIds,
          status: 'ACTIVE',
          commissionType: 'NONE',
          commissionValue: 0,
        });
        therapistId = created.id;
      }
      // Default working pattern: branch hours, Monday to Saturday.
      await this.therapists.setSchedule(therapistId, {
        schedules: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ branchId: branch.id, dayOfWeek, startTime: branch.openingTime, endTime: branch.closingTime })),
      });
    }
  }

  async complete() {
    const tenantId = RequestContext.requireTenantId();
    const [branches, services] = await Promise.all([
      this.db.branch.count({ where: { status: 'ACTIVE' } }),
      this.db.service.count({ where: { status: 'ACTIVE' } }),
    ]);
    if (!branches) throw AppError.invalidState('Add at least one branch before going live.');
    if (!services) throw AppError.invalidState('Add at least one service before going live.');
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!tenant.onboardingCompletedAt) {
      await this.db.tenant.update({
        where: { id: tenantId },
        data: { onboardingCompletedAt: new Date(), onboardingStep: 10, status: tenant.status === 'ONBOARDING' ? 'ACTIVE' : tenant.status },
      });
      await this.events.publish('tenant.onboarded', { tenantId });
      await this.audit.log({ action: 'ONBOARDING_COMPLETED', entityType: 'Tenant', entityId: tenantId });
    }
    await this.authz.invalidateTenant(tenantId);
    return this.state();
  }
}
