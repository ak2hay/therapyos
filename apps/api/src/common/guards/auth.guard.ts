import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { AuthzService } from '../../core/authz.service';
import { FeaturesService } from '../../core/features.service';
import { RequestContext } from '../context/request-context';
import {
  ALLOW_ONBOARDING_KEY,
  API_KEY_ALLOWED,
  CUSTOMER_KEY,
  IS_PUBLIC,
  JwtPrincipal,
  PLATFORM_KEY,
} from '../decorators';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';
import { Db, InjectDb } from '../prisma/prisma.service';

export const API_KEY_PREFIX = 'tos_';

/**
 * Authenticates the caller and establishes the tenant context:
 * Request -> JWT / API key -> principal -> tenant context (CLS) -> permission guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly authz: AuthzService,
    private readonly features: FeaturesService,
    @InjectDb() private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const apiKey: string | undefined = req.headers['x-api-key'] ?? (header?.startsWith(`Bearer ${API_KEY_PREFIX}`) ? header.slice(7) : undefined);

    if (apiKey) {
      if (!this.reflector.getAllAndOverride<boolean>(API_KEY_ALLOWED, targets)) {
        throw AppError.forbidden('This endpoint is not available through the public API.');
      }
      return this.authenticateApiKey(apiKey);
    }

    if (!header?.startsWith('Bearer ')) throw AppError.unauthenticated();
    let principal: JwtPrincipal;
    try {
      principal = await this.jwt.verifyAsync<JwtPrincipal>(header.slice(7));
    } catch (err) {
      const expired = (err as Error).name === 'TokenExpiredError';
      throw AppError.unauthenticated(
        expired ? 'Session expired.' : 'Invalid token.',
        expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.UNAUTHENTICATED,
      );
    }
    req.user = principal;
    const platformRoute = this.reflector.getAllAndOverride<boolean>(PLATFORM_KEY, targets);
    const customerRoute = this.reflector.getAllAndOverride<boolean>(CUSTOMER_KEY, targets);

    if (principal.typ === 'signup') throw AppError.unauthenticated('Invalid token.');
    if (principal.typ === 'customer') {
      if (!customerRoute) throw AppError.forbidden('Customer accounts can only use the customer app.');
      return this.authenticateCustomer(principal);
    }
    if (customerRoute) throw AppError.forbidden('This endpoint is for customer app accounts.');

    if (principal.typ === 'platform') {
      if (!platformRoute) throw AppError.forbidden('Platform administrators must use the admin console.');
      RequestContext.set('platformAdminId', principal.sub);
      RequestContext.set('allBranches', true);
      return true;
    }
    if (platformRoute) throw AppError.forbidden();

    const authz = await this.authz.getUserAuthz(principal.sub);
    if (!authz || authz.status === 'DISABLED') throw AppError.unauthenticated('Account is disabled.');
    if (principal.pv !== undefined && principal.pv !== authz.pv) {
      throw AppError.unauthenticated('Your permissions changed. Please refresh your session.', ErrorCode.PERMISSIONS_CHANGED);
    }
    const allowOnboarding = this.reflector.getAllAndOverride<boolean>(ALLOW_ONBOARDING_KEY, targets);
    if ((authz.tenantStatus === 'SUSPENDED' || authz.tenantStatus === 'CANCELLED') && !allowOnboarding) {
      throw new AppError(
        ErrorCode.TENANT_SUSPENDED,
        'This business account is suspended. Please contact support.',
        HttpStatus.FORBIDDEN,
      );
    }

    RequestContext.set('tenantId', authz.tenantId);
    RequestContext.set('userId', authz.userId);
    RequestContext.set('userName', authz.name);
    RequestContext.set('roles', authz.roles);
    RequestContext.set('permissions', new Set(authz.permissions));
    RequestContext.set('branchIds', authz.branchIds);
    RequestContext.set('allBranches', authz.allBranches);
    RequestContext.set('therapistId', authz.therapistId);
    return true;
  }

  private async authenticateCustomer(principal: JwtPrincipal): Promise<boolean> {
    const [customer, tenant] = await Promise.all([
      this.db.customer.findFirst({ where: { id: principal.sub, tenantId: principal.tid }, select: { id: true, tenantId: true, name: true, status: true } }),
      this.db.tenant.findUnique({ where: { id: principal.tid }, select: { status: true } }),
    ]);
    if (!customer || !tenant || customer.status === 'BLOCKED') throw AppError.unauthenticated('Account is disabled.');
    if (tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED') {
      throw new AppError(ErrorCode.TENANT_SUSPENDED, 'This business is not taking online bookings right now.', HttpStatus.FORBIDDEN);
    }
    RequestContext.set('tenantId', customer.tenantId);
    RequestContext.set('customerId', customer.id);
    RequestContext.set('userName', customer.name);
    RequestContext.set('permissions', new Set());
    RequestContext.set('allBranches', true);
    return true;
  }

  private async authenticateApiKey(raw: string): Promise<boolean> {
    const keyHash = createHash('sha256').update(raw).digest('hex');
    const key = await this.db.apiKey.findUnique({ where: { keyHash } });
    if (!key || key.revokedAt) throw AppError.unauthenticated('Invalid API key.');
    const tenant = await this.db.tenant.findUnique({ where: { id: key.tenantId } });
    if (!tenant || tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED') {
      throw new AppError(ErrorCode.TENANT_SUSPENDED, 'Tenant is suspended.', HttpStatus.FORBIDDEN);
    }
    await this.features.assertEnabled(key.tenantId, 'API_ACCESS');
    RequestContext.set('tenantId', key.tenantId);
    RequestContext.set('apiKeyId', key.id);
    RequestContext.set('permissions', new Set(key.scopes));
    RequestContext.set('allBranches', true);
    const branches = await this.db.branch.findMany({ where: { tenantId: key.tenantId }, select: { id: true } });
    RequestContext.set('branchIds', branches.map((b) => b.id));
    void this.db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return true;
  }
}
