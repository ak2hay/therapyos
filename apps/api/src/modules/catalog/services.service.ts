import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { branchServiceSchema, serviceCategorySchema, ServiceInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { num } from '../../common/utils/money';
import { AuditService } from '../../core/audit.service';
import { SERVICE_COLORS } from './business-templates';

type CategoryInput = z.infer<typeof serviceCategorySchema>;
type BranchServiceInput = z.infer<typeof branchServiceSchema>;

export interface EffectiveService {
  id: string;
  name: string;
  categoryId: string | null;
  durationMinutes: number;
  price: number;
  taxRate: number;
}

@Injectable()
export class ServicesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ---------- categories ----------

  async listCategories() {
    const cats = await this.db.serviceCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { services: true } } },
    });
    return cats.map(({ _count, ...c }) => ({ ...c, serviceCount: _count.services }));
  }

  async createCategory(input: CategoryInput) {
    const tenantId = RequestContext.requireTenantId();
    const cat = await this.db.serviceCategory.create({ data: { ...input, tenantId } });
    await this.audit.log({ action: 'SERVICE_CATEGORY_CREATED', entityType: 'ServiceCategory', entityId: cat.id, newValues: input });
    return cat;
  }

  async updateCategory(id: string, input: Partial<CategoryInput>) {
    await this.requireCategory(id);
    return this.db.serviceCategory.update({ where: { id }, data: input });
  }

  async deleteCategory(id: string) {
    await this.requireCategory(id);
    await this.db.serviceCategory.delete({ where: { id } });
    await this.audit.log({ action: 'SERVICE_CATEGORY_DELETED', entityType: 'ServiceCategory', entityId: id });
    return { id };
  }

  private async requireCategory(id: string) {
    const cat = await this.db.serviceCategory.findFirst({ where: { id } });
    if (!cat) throw AppError.notFound('Service category');
    return cat;
  }

  // ---------- services ----------

  async list(q: { branchId?: string; active?: boolean; categoryId?: string; search?: string }) {
    const where: Prisma.ServiceWhereInput = {};
    if (q.active) where.status = 'ACTIVE';
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.search) where.name = { contains: q.search, mode: 'insensitive' };
    if (q.branchId) RequestContext.assertBranch(q.branchId);
    const services = await this.db.service.findMany({
      where,
      orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
      include: {
        category: { select: { id: true, name: true } },
        branchServices: { select: { branchId: true, price: true, durationMinutes: true, isActive: true } },
        _count: { select: { therapistServices: true } },
      },
    });
    return services
      .map(({ _count, ...s }) => {
        const override = q.branchId ? s.branchServices.find((b) => b.branchId === q.branchId) : undefined;
        return {
          ...s,
          therapistCount: _count.therapistServices,
          effectivePrice: override?.price != null ? num(override.price) : num(s.basePrice),
          effectiveDuration: override?.durationMinutes ?? s.durationMinutes,
          availableAtBranch: override ? override.isActive : true,
        };
      })
      .filter((s) => !q.branchId || !q.active || s.availableAtBranch);
  }

  async get(id: string) {
    const service = await this.db.service.findFirst({
      where: { id },
      include: {
        category: true,
        branchServices: { include: { branch: { select: { id: true, name: true } } } },
        consumables: { include: { product: { select: { id: true, name: true, unit: true, sku: true } } } },
        therapistServices: { include: { therapist: { select: { id: true, name: true, status: true } } } },
      },
    });
    if (!service) throw AppError.notFound('Service');
    return service;
  }

  private async validateRefs(input: Partial<ServiceInput>) {
    if (input.categoryId) await this.requireCategory(input.categoryId);
    if (input.consumables?.length) {
      const ids = input.consumables.map((c) => c.productId);
      const count = await this.db.product.count({ where: { id: { in: ids } } });
      if (count !== new Set(ids).size) throw AppError.notFound('Product');
    }
  }

  async create(input: ServiceInput, client: DbOrTx = this.db) {
    const tenantId = RequestContext.requireTenantId();
    await this.validateRefs(input);
    const { consumables, ...data } = input;
    const count = await client.service.count();
    const service = await client.service.create({
      data: {
        ...data,
        tenantId,
        color: data.color ?? SERVICE_COLORS[count % SERVICE_COLORS.length],
        consumables: consumables?.length
          ? { create: consumables.map((c) => ({ tenantId, productId: c.productId, quantity: c.quantity })) }
          : undefined,
      },
    });
    await this.audit.log({ action: 'SERVICE_CREATED', entityType: 'Service', entityId: service.id, newValues: input });
    return service;
  }

  async update(id: string, input: Partial<ServiceInput>) {
    const tenantId = RequestContext.requireTenantId();
    const before = await this.get(id);
    await this.validateRefs(input);
    const { consumables, ...data } = input;
    await this.db.$transaction(async (tx) => {
      await tx.service.update({ where: { id }, data });
      if (consumables) {
        await tx.serviceConsumable.deleteMany({ where: { serviceId: id } });
        if (consumables.length) {
          await tx.serviceConsumable.createMany({
            data: consumables.map((c) => ({ tenantId, serviceId: id, productId: c.productId, quantity: c.quantity })),
          });
        }
      }
    });
    await this.audit.log({
      action: before.basePrice.toString() !== String(input.basePrice ?? before.basePrice) ? 'PRICE_CHANGED' : 'SERVICE_UPDATED',
      entityType: 'Service',
      entityId: id,
      oldValues: { name: before.name, basePrice: before.basePrice, durationMinutes: before.durationMinutes, status: before.status },
      newValues: input,
    });
    return this.get(id);
  }

  /** Services have booking and billing history, so they are deactivated rather than deleted. */
  async deactivate(id: string) {
    await this.get(id);
    const service = await this.db.service.update({ where: { id }, data: { status: 'INACTIVE' } });
    await this.audit.log({ action: 'SERVICE_DEACTIVATED', entityType: 'Service', entityId: id });
    return service;
  }

  async setBranchOverride(serviceId: string, input: BranchServiceInput) {
    const tenantId = RequestContext.requireTenantId();
    RequestContext.assertBranch(input.branchId);
    const service = await this.get(serviceId);
    const branch = await this.db.branch.findFirst({ where: { id: input.branchId } });
    if (!branch) throw AppError.notFound('Branch');
    const before = service.branchServices.find((b) => b.branchId === input.branchId);
    const row = await this.db.branchService.upsert({
      where: { branchId_serviceId: { branchId: input.branchId, serviceId } },
      create: { tenantId, serviceId, branchId: input.branchId, price: input.price, durationMinutes: input.durationMinutes, isActive: input.isActive },
      update: { price: input.price ?? null, durationMinutes: input.durationMinutes ?? null, isActive: input.isActive },
    });
    await this.audit.log({
      action: 'PRICE_CHANGED',
      entityType: 'BranchService',
      entityId: row.id,
      oldValues: before ? { price: before.price, isActive: before.isActive } : null,
      newValues: input,
    });
    return row;
  }

  async removeBranchOverride(serviceId: string, branchId: string) {
    RequestContext.assertBranch(branchId);
    await this.db.branchService.deleteMany({ where: { serviceId, branchId } });
    return { serviceId, branchId };
  }

  /** Price, duration and tax for a service at a branch, honouring branch overrides. Throws if unavailable. */
  async effective(serviceId: string, branchId: string, client: DbOrTx = this.db): Promise<EffectiveService> {
    const service = await client.service.findFirst({
      where: { id: serviceId },
      include: { branchServices: { where: { branchId } } },
    });
    if (!service) throw AppError.notFound('Service');
    const override = service.branchServices[0];
    if (service.status !== 'ACTIVE' || (override && !override.isActive)) {
      throw AppError.invalidState(`${service.name} is not available at this branch.`);
    }
    return {
      id: service.id,
      name: service.name,
      categoryId: service.categoryId,
      durationMinutes: override?.durationMinutes ?? service.durationMinutes,
      price: override?.price != null ? num(override.price) : num(service.basePrice),
      taxRate: num(service.taxRate),
    };
  }
}
