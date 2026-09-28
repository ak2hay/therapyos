import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { env } from '../../config/env';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPrincipal } from '../../common/decorators';
import { AuthzService } from '../../core/authz.service';

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly authz: AuthzService,
    @InjectDb() private readonly db: Db,
  ) {}

  private async accessTokenForUser(userId: string): Promise<string> {
    const a = await this.authz.getUserAuthz(userId);
    if (!a) throw AppError.unauthenticated();
    const payload: JwtPrincipal = {
      sub: a.userId,
      typ: 'user',
      tid: a.tenantId,
      roles: a.roles,
      bs: a.allBranches ? '*' : a.branchIds,
      pv: a.pv,
      name: a.name,
    };
    return this.jwt.signAsync(payload);
  }

  private async accessTokenForAdmin(adminId: string, name: string): Promise<string> {
    const payload: JwtPrincipal = { sub: adminId, typ: 'platform', name };
    return this.jwt.signAsync(payload);
  }

  private async createRefreshToken(opts: { userId?: string; platformAdminId?: string; customerId?: string; familyId?: string }) {
    const raw = randomBytes(48).toString('base64url');
    const row = await this.db.refreshToken.create({
      data: {
        userId: opts.userId,
        platformAdminId: opts.platformAdminId,
        customerId: opts.customerId,
        tokenHash: sha256(raw),
        familyId: opts.familyId ?? randomUUID(),
        expiresAt: new Date(Date.now() + env().REFRESH_TOKEN_TTL_DAYS * 86_400_000),
        ip: RequestContext.get('ip'),
        userAgent: RequestContext.get('userAgent')?.slice(0, 250),
      },
    });
    return { raw, row };
  }

  async issueForUser(userId: string, familyId?: string): Promise<IssuedTokens> {
    const [accessToken, refresh] = await Promise.all([
      this.accessTokenForUser(userId),
      this.createRefreshToken({ userId, familyId }),
    ]);
    return { accessToken, refreshToken: refresh.raw, expiresIn: env().JWT_ACCESS_TTL_SECONDS };
  }

  async issueForAdmin(adminId: string, name: string, familyId?: string): Promise<IssuedTokens> {
    const [accessToken, refresh] = await Promise.all([
      this.accessTokenForAdmin(adminId, name),
      this.createRefreshToken({ platformAdminId: adminId, familyId }),
    ]);
    return { accessToken, refreshToken: refresh.raw, expiresIn: env().JWT_ACCESS_TTL_SECONDS };
  }

  async issueForCustomer(customer: { id: string; tenantId: string; name: string }, familyId?: string): Promise<IssuedTokens> {
    const payload: JwtPrincipal = { sub: customer.id, typ: 'customer', tid: customer.tenantId, name: customer.name };
    const [accessToken, refresh] = await Promise.all([
      this.jwt.signAsync(payload),
      this.createRefreshToken({ customerId: customer.id, familyId }),
    ]);
    return { accessToken, refreshToken: refresh.raw, expiresIn: env().JWT_ACCESS_TTL_SECONDS };
  }

  /** Short-lived proof that `phone` was verified by OTP for a business, used to finish customer sign-up. */
  signupToken(tenantId: string, phone: string) {
    const payload: JwtPrincipal = { sub: phone, typ: 'signup', tid: tenantId };
    return this.jwt.signAsync(payload, { expiresIn: 900 });
  }

  async verifySignupToken(token: string) {
    const p = await this.jwt.verifyAsync<JwtPrincipal>(token).catch(() => null);
    if (!p || p.typ !== 'signup' || !p.tid) throw AppError.unauthenticated('Your verification has expired. Please request a new code.', ErrorCode.TOKEN_EXPIRED);
    return { tenantId: p.tid, phone: p.sub };
  }

  /**
   * Refresh-token rotation with reuse detection: a refresh token can be used exactly once. Presenting an
   * already-rotated token revokes the entire token family (likely theft).
   */
  async rotate(raw: string, kind: 'staff' | 'customer' = 'staff'): Promise<IssuedTokens & { userId?: string; platformAdminId?: string; customerId?: string }> {
    const existing = await this.db.refreshToken.findUnique({
      where: { tokenHash: sha256(raw) },
      include: { platformAdmin: true, user: true, customer: { select: { id: true, tenantId: true, name: true, status: true } } },
    });
    if (!existing || (kind === 'customer') !== !!existing.customerId) throw AppError.unauthenticated('Invalid session.');
    if (existing.revokedAt) {
      await this.revokeFamily(existing.familyId);
      throw AppError.unauthenticated('Session was already used. Please sign in again.', ErrorCode.TOKEN_REUSED);
    }
    if (existing.expiresAt < new Date()) throw AppError.unauthenticated('Session expired.', ErrorCode.TOKEN_EXPIRED);
    if (existing.user && existing.user.status === 'DISABLED') throw AppError.unauthenticated('Account is disabled.');
    if (existing.customer && existing.customer.status === 'BLOCKED') throw AppError.unauthenticated('Account is disabled.');

    const issued = existing.platformAdminId
      ? await this.issueForAdmin(existing.platformAdminId, existing.platformAdmin!.name, existing.familyId)
      : existing.customer
        ? await this.issueForCustomer(existing.customer, existing.familyId)
        : await this.issueForUser(existing.userId!, existing.familyId);

    const next = await this.db.refreshToken.findUnique({ where: { tokenHash: sha256(issued.refreshToken) } });
    await this.db.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedById: next?.id },
    });
    return { ...issued, userId: existing.userId ?? undefined, platformAdminId: existing.platformAdminId ?? undefined, customerId: existing.customerId ?? undefined };
  }

  async revoke(raw: string) {
    const existing = await this.db.refreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
    if (existing) await this.revokeFamily(existing.familyId);
  }

  async revokeFamily(familyId: string) {
    await this.db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: string) {
    await this.db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
