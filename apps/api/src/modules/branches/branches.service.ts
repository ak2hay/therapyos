import { Injectable } from '@nestjs/common';
import type { BranchInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { AuditService } from '../../core/audit.service';
import { AuthzService } from '../../core/authz.service';
import { FeaturesService } from '../../core/features.service';

@Injectable()
export class BranchesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
    private readonly features: FeaturesService,
  ) {}

  list(includeInactive = true) {
    return this.db.branch.findMany({
      where: { ...RequestContext.branchFilter(undefined, 'id'), ...(includeInactive ? {} : { status: 'ACTIVE' }) },
      orderBy: { name: 'asc' },
    });
  }

  async get(id: string) {
    RequestContext.assertBranch(id);
    const branch = await this.db.branch.findFirst({ where: { id } });
    if (!branch) throw AppError.notFound('Branch');
    return branch;
  }

  async create(input: BranchInput) {
    const tenantId = RequestContext.requireTenantId();
    await this.features.assertWithinLimit(tenantId, 'branches');
    const branch = await this.db.branch.create({ data: { ...input, tenantId } });
    await this.authz.invalidateTenant(tenantId);
    await this.audit.log({ action: 'BRANCH_CREATED', entityType: 'Branch', entityId: branch.id, newValues: input });
    return branch;
  }

  async update(id: string, input: Partial<BranchInput>) {
    const before = await this.get(id);
    const branch = await this.db.branch.update({ where: { id }, data: input });
    await this.audit.log({ action: 'BRANCH_UPDATED', entityType: 'Branch', entityId: id, oldValues: before, newValues: input });
    return branch;
  }

  async remove(id: string) {
    await this.get(id);
    const tenantId = RequestContext.requireTenantId();
    const active = await this.db.branch.count({ where: { status: 'ACTIVE' } });
    if (active <= 1) throw AppError.invalidState('A business must keep at least one active branch.');
    // Branches own historical financial data, so they are deactivated rather than deleted.
    const branch = await this.db.branch.update({ where: { id }, data: { status: 'INACTIVE' } });
    await this.authz.invalidateTenant(tenantId);
    await this.audit.log({ action: 'BRANCH_DEACTIVATED', entityType: 'Branch', entityId: id });
    return branch;
  }
}
