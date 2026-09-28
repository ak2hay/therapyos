import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { randomInt } from 'crypto';
import { InjectRedis } from '../../common/redis/redis.module';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { SmsProvider } from '../../integrations/messaging.providers';
import { isProd } from '../../config/env';
import { sha256 } from './token.service';

const OTP_TTL = 300;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN = 30;

/** Phone OTP state lives only in Redis (hashed code + attempt counter). */
@Injectable()
export class OtpService {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly sms: SmsProvider,
  ) {}

  private key(phone: string, scope?: string) {
    return scope ? `otp:${scope}:${phone}` : `otp:${phone}`;
  }

  /** `scope` keeps separate codes per purpose, e.g. customer sign-in for one business vs. staff sign-in. */
  async send(phone: string, scope?: string): Promise<{ sent: true; devCode?: string }> {
    const key = this.key(phone, scope);
    const cooldownKey = `${key}:cooldown`;
    if (await this.redis.exists(cooldownKey)) {
      throw AppError.badRequest(ErrorCode.RATE_LIMITED, 'Please wait before requesting another code.');
    }
    const code = String(randomInt(100000, 1000000));
    await this.redis
      .multi()
      .hset(key, { hash: sha256(code), attempts: '0' })
      .expire(key, OTP_TTL)
      .set(cooldownKey, '1', 'EX', RESEND_COOLDOWN)
      .exec();
    await this.sms.send(phone, `${code} is your TherapyOS verification code. It expires in 5 minutes.`);
    return isProd() ? { sent: true } : { sent: true, devCode: code };
  }

  async verify(phone: string, code: string, scope?: string): Promise<void> {
    const key = this.key(phone, scope);
    const state = await this.redis.hgetall(key);
    if (!state.hash) throw AppError.badRequest(ErrorCode.OTP_EXPIRED, 'Code expired. Request a new one.');
    const attempts = Number(state.attempts ?? 0);
    if (attempts >= MAX_ATTEMPTS) {
      await this.redis.del(key);
      throw AppError.badRequest(ErrorCode.OTP_TOO_MANY_ATTEMPTS, 'Too many attempts. Request a new code.');
    }
    if (state.hash !== sha256(code)) {
      await this.redis.hincrby(key, 'attempts', 1);
      throw AppError.badRequest(ErrorCode.OTP_INVALID, 'Incorrect code.');
    }
    await this.redis.del(key);
  }
}
