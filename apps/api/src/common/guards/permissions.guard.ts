import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeaturesService } from '../../core/features.service';
import { RequestContext } from '../context/request-context';
import { ANY_PERMISSIONS_KEY, FEATURE_KEY, IS_PUBLIC, PERMISSIONS_KEY } from '../decorators';
import { AppError } from '../errors/app-error';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (RequestContext.get('platformAdminId')) return true;

    const all = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
    const any = this.reflector.getAllAndOverride<string[]>(ANY_PERMISSIONS_KEY, targets) ?? [];
    const granted = RequestContext.get('permissions') ?? new Set<string>();

    if (all.length && !all.every((p) => granted.has(p))) {
      throw AppError.forbidden(`Missing permission: ${all.filter((p) => !granted.has(p)).join(', ')}`);
    }
    if (any.length && !any.some((p) => granted.has(p))) {
      throw AppError.forbidden(`Requires one of: ${any.join(', ')}`);
    }
    return true;
  }
}

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly features: FeaturesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const key = this.reflector.getAllAndOverride<string>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!key) return true;
    const tenantId = RequestContext.tenantId;
    if (!tenantId) return true;
    await this.features.assertEnabled(tenantId, key);
    return true;
  }
}
