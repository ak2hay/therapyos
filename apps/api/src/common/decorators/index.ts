import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Permission, FeatureFlagKey } from '@therapyos/types';

export const IS_PUBLIC = 'isPublic';
export const PERMISSIONS_KEY = 'permissions';
export const ANY_PERMISSIONS_KEY = 'anyPermissions';
export const FEATURE_KEY = 'feature';
export const PLATFORM_KEY = 'platform';
export const CUSTOMER_KEY = 'customer';
export const ALLOW_ONBOARDING_KEY = 'allowOnboarding';
export const AUDIT_KEY = 'audit';
export const API_KEY_ALLOWED = 'apiKeyAllowed';
export const RAW_RESPONSE = 'rawResponse';

/** Skip the `{ success, data }` envelope (metrics, health, webhooks that providers read). */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);

/** Route does not require authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Caller must hold ALL listed permissions. */
export const RequirePermissions = (...perms: Permission[]) => SetMetadata(PERMISSIONS_KEY, perms);

/** Caller must hold at least ONE of the listed permissions. */
export const RequireAnyPermission = (...perms: Permission[]) => SetMetadata(ANY_PERMISSIONS_KEY, perms);

/** Route is gated behind a tenant feature flag / subscription feature. */
export const RequireFeature = (key: FeatureFlagKey) => SetMetadata(FEATURE_KEY, key);

/** Route is only for Rkyves platform administrators. */
export const PlatformOnly = () => SetMetadata(PLATFORM_KEY, true);

/** Route is for signed-in end customers of a business (customer app); staff and platform tokens are refused. */
export const CustomerOnly = () => SetMetadata(CUSTOMER_KEY, true);

/** Route remains usable while the tenant is still onboarding / suspended checks relaxed. */
export const AllowOnboarding = () => SetMetadata(ALLOW_ONBOARDING_KEY, true);

/** Route may be called with a tenant API key (public API). */
export const ApiKeyAllowed = () => SetMetadata(API_KEY_ALLOWED, true);

/** Records an audit entry for this route with the given action + entity type. */
export const Audit = (action: string, entityType: string) => SetMetadata(AUDIT_KEY, { action, entityType });

export interface JwtPrincipal {
  sub: string;
  /** `signup` tokens only prove a verified phone number and are accepted solely by customer registration. */
  typ: 'user' | 'platform' | 'customer' | 'signup';
  tid?: string;
  roles?: string[];
  bs?: string[] | '*';
  pv?: number;
  name?: string;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  return req.user as JwtPrincipal | undefined;
});
