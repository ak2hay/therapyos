import { Controller, Get, Header, Headers, Injectable, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, HealthIndicatorService, TerminusModule } from '@nestjs/terminus';
import Redis from 'ioredis';
import { Public, RawResponse } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { InjectRedis } from '../../common/redis/redis.module';
import { safeEqual } from '../../common/utils/crypto';
import { env } from '../../config/env';
import { metricsRegistry } from '../../observability/observability';
import { StorageService } from '../../integrations/storage.service';

@Injectable()
class Indicators {
  constructor(
    private readonly indicator: HealthIndicatorService,
    @InjectDb() private readonly db: Db,
    @InjectRedis() private readonly redis: Redis,
    private readonly storage: StorageService,
  ) {}

  async database() {
    const check = this.indicator.check('database');
    try {
      await this.db.$queryRaw`SELECT 1`;
      return check.up();
    } catch (e) {
      return check.down({ message: (e as Error).message });
    }
  }

  async redisCheck() {
    const check = this.indicator.check('redis');
    try {
      await this.redis.ping();
      return check.up();
    } catch (e) {
      return check.down({ message: (e as Error).message });
    }
  }

  async storageCheck() {
    return this.indicator.check('storage').up({ driver: this.storage.driver });
  }
}

@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly ind: Indicators,
  ) {}

  @Public()
  @RawResponse()
  @Get('health')
  @HealthCheck()
  check() {
    return this.health.check([() => this.ind.database(), () => this.ind.redisCheck(), () => this.ind.storageCheck()]);
  }

  /** Liveness only: no dependency checks, so a database blip does not restart every container. */
  @Public()
  @RawResponse()
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @RawResponse()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics(@Headers('authorization') authorization?: string) {
    const token = env().METRICS_TOKEN;
    if (token && !safeEqual(authorization ?? '', `Bearer ${token}`)) {
      throw AppError.unauthenticated('Metrics token required.');
    }
    return metricsRegistry.metrics();
  }
}

@Module({ imports: [TerminusModule], controllers: [HealthController], providers: [Indicators] })
export class HealthModule {}
