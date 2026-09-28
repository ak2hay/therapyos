import { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/** Redis-backed throttler storage so rate limits hold across multiple API instances. */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;

    const blockTtl = await this.redis.pttl(blockKey);
    if (blockTtl > 0) {
      return { totalHits: limit + 1, timeToExpire: Math.ceil(blockTtl / 1000), isBlocked: true, timeToBlockExpire: Math.ceil(blockTtl / 1000) };
    }

    const results = await this.redis.multi().incr(hitKey).pttl(hitKey).exec();
    const totalHits = Number(results?.[0]?.[1] ?? 1);
    let pttl = Number(results?.[1]?.[1] ?? -1);
    if (pttl < 0) {
      await this.redis.pexpire(hitKey, ttl);
      pttl = ttl;
    }

    if (totalHits > limit) {
      await this.redis.set(blockKey, '1', 'PX', blockDuration || ttl);
      return { totalHits, timeToExpire: Math.ceil(pttl / 1000), isBlocked: true, timeToBlockExpire: Math.ceil((blockDuration || ttl) / 1000) };
    }
    return { totalHits, timeToExpire: Math.ceil(pttl / 1000), isBlocked: false, timeToBlockExpire: 0 };
  }
}
