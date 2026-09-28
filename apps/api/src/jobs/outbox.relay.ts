import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { Db, InjectDb } from '../common/prisma/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { EventsService } from '../core/events.service';
import { jobCounter } from '../observability/observability';
import { EventHandlerRegistry, EventMeta } from './event-handlers';
import { bullConnection, QUEUES, QueueService, shouldRunWorkers } from './queue.service';

interface EventJob {
  eventId: string;
  handler: string;
  type: string;
  tenantId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

const BATCH = 100;

/**
 * Transactional outbox relay: moves committed `domain_events` rows onto BullMQ (one job per
 * handler, idempotent job ids) and runs the handler worker.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private worker?: Worker;
  private draining = false;
  private pendingSignal = false;
  private readonly onSignal = () => void this.drain();

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly registry: EventHandlerRegistry,
    private readonly queues: QueueService,
  ) {}

  onApplicationBootstrap() {
    if (!shouldRunWorkers()) return;
    this.timer = setInterval(() => void this.drain(), 2_000);
    EventsService.signal.on('published', this.onSignal);
    this.worker = new Worker<EventJob>(QUEUES.EVENTS, (job) => this.process(job), {
      connection: bullConnection(),
      concurrency: 10,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`Event handler ${job?.data.handler} failed (attempt ${job?.attemptsMade}): ${err.message}`);
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void this.db.domainEvent.update({ where: { id: job.data.eventId }, data: { status: 'FAILED', error: `${job.data.handler}: ${err.message}`.slice(0, 1000) } }).catch(() => undefined);
      }
    });
    this.logger.log('Outbox relay and event worker started');
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    EventsService.signal.off('published', this.onSignal);
    await this.worker?.close().catch(() => undefined);
  }

  async drain() {
    if (this.draining) {
      this.pendingSignal = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.pendingSignal = false;
        const moved = await this.relayBatch();
        if (moved === BATCH) this.pendingSignal = true;
      } while (this.pendingSignal);
    } catch (err) {
      this.logger.error(`Outbox relay failed: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  private async relayBatch(): Promise<number> {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM domain_events WHERE status = 'PENDING' ORDER BY "createdAt" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;
      if (!rows.length) return 0;
      const events = await tx.domainEvent.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: 'asc' } });
      for (const e of events) {
        for (const h of this.registry.handlersFor(e.type)) {
          await this.queues.add(
            QUEUES.EVENTS,
            e.type,
            { eventId: e.id, handler: h.name, type: e.type, tenantId: e.tenantId, payload: e.payload as Record<string, unknown>, createdAt: e.createdAt.toISOString() },
            { jobId: `${e.id}__${h.name}` },
          );
        }
      }
      await tx.domainEvent.updateMany({ where: { id: { in: events.map((e) => e.id) } }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      return events.length;
    });
  }

  private async process(job: Job<EventJob>) {
    const handler = this.registry.get(job.data.handler);
    if (!handler) return;
    const meta: EventMeta = {
      eventId: job.data.eventId,
      type: job.data.type,
      tenantId: job.data.tenantId,
      actorId: (job.data.payload.actorId as string | undefined) ?? null,
      createdAt: new Date(job.data.createdAt),
    };
    try {
      await RequestContext.runAsTenant(job.data.tenantId ?? undefined, () => handler.fn(job.data.payload, meta), { requestId: `evt_${job.data.eventId}` });
      jobCounter.inc({ queue: QUEUES.EVENTS, name: job.data.handler, result: 'success' });
    } catch (err) {
      jobCounter.inc({ queue: QUEUES.EVENTS, name: job.data.handler, result: 'failure' });
      throw err;
    }
  }

  /**
   * Runs pending events synchronously in-process, bypassing BullMQ. Used by the seed and by
   * integration tests so handler side effects are visible immediately.
   */
  async processInline(maxRounds = 200) {
    for (let round = 0; round < maxRounds; round++) {
      const events = await this.db.domainEvent.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200 });
      if (!events.length) return;
      for (const e of events) {
        const meta: EventMeta = { eventId: e.id, type: e.type, tenantId: e.tenantId, createdAt: e.createdAt };
        let error: string | null = null;
        for (const h of this.registry.handlersFor(e.type)) {
          try {
            await RequestContext.runAsTenant(e.tenantId ?? undefined, () => h.fn(e.payload as Record<string, unknown>, meta));
          } catch (err) {
            error = `${h.name}: ${(err as Error).message}`;
            this.logger.warn(`Inline handler ${error}`);
          }
        }
        await this.db.domainEvent.update({ where: { id: e.id }, data: { status: error ? 'FAILED' : 'PUBLISHED', publishedAt: new Date(), error } });
      }
    }
  }
}
