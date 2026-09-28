import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../../config/env';

export const REDIS = Symbol('REDIS');
export const InjectRedis = () => Inject(REDIS);

export function createRedis() {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
}

@Injectable()
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: createRedis }, RedisLifecycle],
  exports: [REDIS],
})
export class RedisModule {}
