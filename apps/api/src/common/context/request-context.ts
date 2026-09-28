import { HttpStatus } from '@nestjs/common';
import { ClsServiceManager, ClsStore } from 'nestjs-cls';
import { randomUUID } from 'crypto';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

export interface AppClsStore extends ClsStore {
  requestId: string;
  tenantId?: string;
  userId?: string;
  userName?: string;
  platformAdminId?: string;
  apiKeyId?: string;
  customerId?: string;
  roles?: string[];
  permissions?: Set<string>;
  branchIds?: string[];
  allBranches?: boolean;
  therapistId?: string | null;
  ip?: string;
  userAgent?: string;
}

function cls() {
  return ClsServiceManager.getClsService<AppClsStore>();
}

/**
 * Static accessor for the per-request (or per-job) context. The tenant id is always derived
 * from the authenticated principal, never from client input.
 */
export class RequestContext {
  static get<K extends keyof AppClsStore>(key: K): AppClsStore[K] | undefined {
    const c = cls();
    return c.isActive() ? c.get(key) : undefined;
  }

  static set<K extends keyof AppClsStore>(key: K, value: AppClsStore[K]) {
    const c = cls();
    if (c.isActive()) c.set(key, value);
  }

  static get tenantId(): string | undefined {
    return this.get('tenantId');
  }

  static get userId(): string | undefined {
    return this.get('userId');
  }

  static get customerId(): string | undefined {
    return this.get('customerId');
  }

  static requireCustomerId(): string {
    const id = this.customerId;
    if (!id) throw AppError.unauthenticated();
    return id;
  }

  static get requestId(): string {
    return this.get('requestId') ?? 'no-request';
  }

  static requireTenantId(): string {
    const t = this.tenantId;
    if (!t) throw new AppError(ErrorCode.TENANT_REQUIRED, 'Tenant context is required.', HttpStatus.FORBIDDEN);
    return t;
  }

  static hasPermission(code: string): boolean {
    return this.get('permissions')?.has(code) ?? false;
  }

  static canAccessBranch(branchId: string): boolean {
    if (this.get('allBranches')) return true;
    return (this.get('branchIds') ?? []).includes(branchId);
  }

  static assertBranch(branchId: string) {
    if (!this.canAccessBranch(branchId)) {
      throw new AppError(ErrorCode.BRANCH_FORBIDDEN, 'You do not have access to this branch.', HttpStatus.FORBIDDEN);
    }
  }

  /** Builds a Prisma `branchId` filter honouring the caller's branch scope. */
  static branchFilter(requested?: string | null, field = 'branchId'): Record<string, unknown> {
    if (requested) {
      this.assertBranch(requested);
      return { [field]: requested };
    }
    if (this.get('allBranches') || this.get('platformAdminId') || !this.get('userId')) return {};
    return { [field]: { in: this.get('branchIds') ?? [] } };
  }

  /** Branch ids the caller may see (`undefined` means every branch), narrowed to `requested` when given. */
  static branchScope(requested?: string | null): string[] | undefined {
    if (requested) {
      this.assertBranch(requested);
      return [requested];
    }
    if (this.get('allBranches') || this.get('platformAdminId') || !this.get('userId')) return undefined;
    return this.get('branchIds') ?? [];
  }

  /** Runs `fn` inside a fresh context bound to a tenant (used by workers, public routes and seeds). */
  static async runAsTenant<T>(tenantId: string | undefined, fn: () => Promise<T>, extra: Partial<AppClsStore> = {}) {
    const c = cls();
    return c.run(async () => {
      c.set('requestId', extra.requestId ?? `job_${randomUUID()}`);
      if (tenantId) c.set('tenantId', tenantId);
      c.set('allBranches', true);
      for (const [k, v] of Object.entries(extra)) c.set(k as keyof AppClsStore, v as never);
      return fn();
    });
  }

  /** Temporarily switch the tenant in the current context (e.g. public booking resolved by slug). */
  static bindTenant(tenantId: string) {
    this.set('tenantId', tenantId);
    this.set('allBranches', true);
  }
}
