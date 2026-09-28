import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JobsOptions, Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env';

export const QUEUES = {
  EVENTS: 'domain-events',
  NOTIFICATIONS: 'notifications',
  SCHEDULED: 'scheduled',
  REPORTS: 'reports',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const bullConnection = () => new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });

/** True in the dedicated worker process, or in the API when RUN_WORKER_IN_API=true (single-container dev). */
export const shouldRunWorkers = () => process.env.WORKER_PROCESS === 'true' || (env().RUN_WORKER_IN_API && process.env.DISABLE_WORKERS !== 'true');

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();
  private connection?: Redis;

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      this.connection ??= bullConnection();
      q = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T extends object>(queue: QueueName, name: string, data: T, opts?: JobsOptions) {
    return this.queue(queue).add(name, data, opts);
  }

  allQueues(): Queue[] {
    return (Object.values(QUEUES) as QueueName[]).map((n) => this.queue(n));
  }

  async onModuleDestroy() {
    for (const q of this.queues.values()) await q.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
    this.logger.log('Queues closed');
  }
}
