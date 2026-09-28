import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { env } from './config/env';
import { PrismaModule } from './common/prisma/prisma.service';
import { RedisModule, REDIS } from './common/redis/redis.module';
import { RedisThrottlerStorage } from './common/guards/throttler-redis.storage';
import { AuthGuard } from './common/guards/auth.guard';
import { FeatureGuard, PermissionsGuard } from './common/guards/permissions.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { EnvelopeInterceptor } from './common/interceptors/envelope.interceptor';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { CoreModule } from './core/core.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { FEATURE_MODULES } from './feature-modules';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env().LOG_LEVEL,
        genReqId: (req) => (req.headers['x-request-id'] as string) ?? `req_${randomUUID()}`,
        transport: env().NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
        autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
        quietReqLogger: true,
      },
    }),
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) => ((req as any).id as string) ?? `req_${randomUUID()}`,
        setup: (cls, req: Request) => {
          cls.set('requestId', cls.getId());
          cls.set('ip', req.ip);
          cls.set('userAgent', req.headers['user-agent']);
        },
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: env().NODE_ENV === 'test' ? 10_000 : 300 }],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    PrismaModule,
    RedisModule,
    CoreModule,
    IntegrationsModule,
    JobsModule,
    ...FEATURE_MODULES,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
