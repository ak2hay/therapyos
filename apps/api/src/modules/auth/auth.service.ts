import { HttpStatus, Injectable } from '@nestjs/common';
import { verify } from '@node-rs/argon2';
import { OAuth2Client } from 'google-auth-library';
import type { AuthUser } from '@therapyos/types';
import type { LoginInput, RegisterInput } from '@therapyos/validation';
import { env } from '../../config/env';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { AuditService } from '../../core/audit.service';
import { AuthzService } from '../../core/authz.service';
import { FeaturesService } from '../../core/features.service';
import { hashPassword, ProvisioningService } from '../tenants/provisioning.service';
import { OtpService } from './otp.service';
import { sha256, TokenService } from './token.service';

type Candidate = { id: string; passwordHash: string | null; status: string; tenant: { slug: string; name: string; status: string } };

@Injectable()
export class AuthService {
  private google?: OAuth2Client;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly provisioning: ProvisioningService,
    private readonly authz: AuthzService,
    private readonly features: FeaturesService,
    private readonly audit: AuditService,
  ) {
    if (env().GOOGLE_CLIENT_ID) this.google = new OAuth2Client(env().GOOGLE_CLIENT_ID);
  }

  async register(input: RegisterInput) {
    const exists = await this.db.user.findFirst({ where: { OR: [{ email: input.email }, { phone: input.phone }] } });
    if (exists) {
      throw AppError.conflict('An account with this email or phone already exists. Please sign in instead.', ErrorCode.DUPLICATE);
    }
    const { owner } = await this.provisioning.provision(input);
    return this.completeLogin(owner.id);
  }

  private async findCandidates(identifier: string, tenantSlug?: string): Promise<Candidate[]> {
    const isEmail = identifier.includes('@');
    const where = isEmail ? { email: identifier.toLowerCase() } : { phone: identifier.replace(/\s/g, '') };
    return this.db.user.findMany({
      where: { ...where, ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}) },
      select: { id: true, passwordHash: true, status: true, tenant: { select: { slug: true, name: true, status: true } } },
    });
  }

  private pickSingle(matches: Candidate[]): Candidate {
    if (matches.length === 0) throw AppError.unauthenticated('Invalid credentials.', ErrorCode.INVALID_CREDENTIALS);
    if (matches.length > 1) {
      throw new AppError(
        ErrorCode.TENANT_REQUIRED,
        'Your account belongs to multiple businesses. Choose one to continue.',
        HttpStatus.CONFLICT,
        { tenants: matches.map((m) => ({ slug: m.tenant.slug, name: m.tenant.name })) },
      );
    }
    const user = matches[0];
    if (user.status === 'DISABLED') throw AppError.unauthenticated('This account is disabled.');
    return user;
  }

  async login(input: LoginInput) {
    const candidates = await this.findCandidates(input.identifier, input.tenantSlug);
    const matches: Candidate[] = [];
    for (const c of candidates) {
      if (c.passwordHash && (await verify(c.passwordHash, input.password).catch(() => false))) matches.push(c);
    }
    const user = this.pickSingle(matches);
    return this.completeLogin(user.id);
  }

  async sendOtp(phone: string, tenantSlug?: string) {
    const candidates = await this.findCandidates(phone, tenantSlug);
    // Always respond the same way to avoid account enumeration; only send when an account exists.
    if (!candidates.length) return { sent: true };
    return this.otp.send(phone);
  }

  async verifyOtp(phone: string, code: string, tenantSlug?: string) {
    await this.otp.verify(phone, code);
    const user = this.pickSingle(await this.findCandidates(phone, tenantSlug));
    return this.completeLogin(user.id);
  }

  async googleLogin(idToken: string, tenantSlug?: string) {
    if (!this.google) throw AppError.badRequest(ErrorCode.PROVIDER_ERROR, 'Google login is not configured.');
    const ticket = await this.google.verifyIdToken({ idToken, audience: env().GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified) throw AppError.unauthenticated('Google account email is not verified.');
    const user = this.pickSingle(await this.findCandidates(payload.email, tenantSlug));
    await this.db.user.update({ where: { id: user.id }, data: { googleId: payload.sub } });
    return this.completeLogin(user.id);
  }

  async adminLogin(email: string, password: string) {
    const admin = await this.db.platformAdmin.findUnique({ where: { email: email.toLowerCase() } });
    if (!admin || admin.status !== 'ACTIVE' || !(await verify(admin.passwordHash, password).catch(() => false))) {
      throw AppError.unauthenticated('Invalid credentials.', ErrorCode.INVALID_CREDENTIALS);
    }
    await this.db.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    const tokens = await this.tokens.issueForAdmin(admin.id, admin.name);
    await this.audit.log({ action: 'PLATFORM_LOGIN', entityType: 'PlatformAdmin', entityId: admin.id });
    return { tokens, user: this.adminProfile(admin) };
  }

  async acceptInvite(token: string, password: string) {
    const user = await this.db.user.findUnique({ where: { inviteTokenHash: sha256(token) } });
    if (!user || !user.inviteExpiresAt || user.inviteExpiresAt < new Date()) {
      throw AppError.badRequest(ErrorCode.TOKEN_EXPIRED, 'This invitation link is invalid or has expired.');
    }
    await this.db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password), status: 'ACTIVE', inviteTokenHash: null, inviteExpiresAt: null },
    });
    await this.authz.invalidateUser(user.id);
    return this.completeLogin(user.id);
  }

  async changePassword(userId: string, current: string, next: string) {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash || !(await verify(user.passwordHash, current).catch(() => false))) {
      throw AppError.badRequest(ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect.');
    }
    await this.db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next) } });
    await this.tokens.revokeAllForUser(userId);
    await this.audit.log({ action: 'PASSWORD_CHANGED', entityType: 'User', entityId: userId });
    return this.completeLogin(userId);
  }

  async completeLogin(userId: string) {
    await this.db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await this.authz.invalidateUser(userId);
    const tokens = await this.tokens.issueForUser(userId);
    return { tokens, user: await this.profile(userId) };
  }

  async refresh(raw: string) {
    const issued = await this.tokens.rotate(raw);
    const user = issued.userId ? await this.profile(issued.userId) : await this.adminProfileById(issued.platformAdminId!);
    return { tokens: { accessToken: issued.accessToken, refreshToken: issued.refreshToken, expiresIn: issued.expiresIn }, user };
  }

  async profile(userId: string): Promise<AuthUser & Record<string, unknown>> {
    const a = await this.authz.getUserAuthz(userId);
    if (!a) throw AppError.unauthenticated();
    const [tenant, features, branches] = await Promise.all([
      this.db.tenant.findUnique({
        where: { id: a.tenantId },
        select: { onboardingStep: true, onboardingCompletedAt: true, currency: true, timezone: true, logoUrl: true, businessType: true, suspendedReason: true },
      }),
      this.features.getFeatures(a.tenantId),
      this.db.branch.findMany({
        where: { tenantId: a.tenantId, id: { in: a.branchIds } },
        select: { id: true, name: true, code: true, status: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      id: a.userId,
      name: a.name,
      email: a.email,
      phone: a.phone,
      tenantId: a.tenantId,
      tenantName: a.tenantName,
      tenantSlug: a.tenantSlug,
      tenantStatus: a.tenantStatus,
      suspendedReason: tenant?.suspendedReason ?? null,
      roles: a.roles,
      roleNames: a.roleNames,
      permissions: a.permissions,
      branchIds: a.branchIds,
      allBranches: a.allBranches,
      therapistId: a.therapistId,
      isPlatformAdmin: false,
      features,
      branches,
      onboardingStep: tenant?.onboardingStep ?? 1,
      onboardingCompleted: !!tenant?.onboardingCompletedAt,
      currency: tenant?.currency ?? 'INR',
      timezone: tenant?.timezone ?? 'Asia/Kolkata',
      logoUrl: tenant?.logoUrl ?? null,
      businessType: tenant?.businessType,
    };
  }

  private adminProfile(admin: { id: string; name: string; email: string; role: string }): AuthUser & Record<string, unknown> {
    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      phone: null,
      tenantId: null,
      roles: [admin.role],
      permissions: [],
      branchIds: [],
      allBranches: true,
      isPlatformAdmin: true,
      features: [],
    };
  }

  async adminProfileById(id: string) {
    const admin = await this.db.platformAdmin.findUnique({ where: { id } });
    if (!admin) throw AppError.unauthenticated();
    return this.adminProfile(admin);
  }
}
