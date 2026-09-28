import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  acceptInviteSchema,
  adminLoginSchema,
  changePasswordSchema,
  googleLoginSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  sendOtpSchema,
  verifyOtpSchema,
} from '@therapyos/validation';
import { z } from 'zod';
import { env, isProd } from '../../config/env';
import { AllowOnboarding, CurrentUser, JwtPrincipal, PlatformOnly, Public } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { AppError } from '../../common/errors/app-error';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

export const REFRESH_COOKIE = 'tos_rt';

type LoginResult = { tokens: { accessToken: string; refreshToken: string; expiresIn: number }; user: unknown };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  private respond(res: Response, result: LoginResult) {
    res.cookie(REFRESH_COOKIE, result.tokens.refreshToken, {
      httpOnly: true,
      secure: isProd(),
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: env().REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    });
    return result;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(@Body(Zod(registerSchema)) body: z.infer<typeof registerSchema>, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.register(body));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(@Body(Zod(loginSchema)) body: z.infer<typeof loginSchema>, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(body));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('send-otp')
  sendOtp(@Body(Zod(sendOtpSchema)) body: z.infer<typeof sendOtpSchema>) {
    return this.auth.sendOtp(body.phone, body.tenantSlug);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('verify-otp')
  async verifyOtp(@Body(Zod(verifyOtpSchema)) body: z.infer<typeof verifyOtpSchema>, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.verifyOtp(body.phone, body.code, body.tenantSlug));
  }

  @Public()
  @HttpCode(200)
  @Post('google')
  async google(@Body(Zod(googleLoginSchema)) body: z.infer<typeof googleLoginSchema>, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.googleLogin(body.idToken, body.tenantSlug));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Body(Zod(refreshSchema)) body: z.infer<typeof refreshSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = body.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    if (!raw) throw AppError.unauthenticated('No session.');
    return this.respond(res, await this.auth.refresh(raw));
  }

  @Public()
  @HttpCode(200)
  @Post('logout')
  async logout(@Body(Zod(refreshSchema)) body: z.infer<typeof refreshSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = body.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    if (raw) await this.tokens.revoke(raw);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return { loggedOut: true };
  }

  @Public()
  @HttpCode(200)
  @Post('accept-invite')
  async acceptInvite(@Body(Zod(acceptInviteSchema)) body: z.infer<typeof acceptInviteSchema>, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.acceptInvite(body.token, body.password));
  }

  @ApiBearerAuth()
  @AllowOnboarding()
  @Get('me')
  me(@CurrentUser() user: JwtPrincipal) {
    return this.auth.profile(user.sub);
  }

  @ApiBearerAuth()
  @AllowOnboarding()
  @HttpCode(200)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: JwtPrincipal,
    @Body(Zod(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.changePassword(user.sub, body.currentPassword, body.newPassword));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('admin/login')
  async adminLogin(@Body(Zod(adminLoginSchema)) body: z.infer<typeof adminLoginSchema>, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.adminLogin(body.email, body.password));
  }

  @ApiBearerAuth()
  @PlatformOnly()
  @Get('admin/me')
  adminMe(@CurrentUser() user: JwtPrincipal) {
    return this.auth.adminProfileById(user.sub);
  }
}
