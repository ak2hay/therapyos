import { Injectable, Logger, OnModuleInit, SetMetadata } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { DomainEventType } from '../core/events.service';

const EVENT_HANDLER = 'therapyos:event-handler';

export interface EventMeta {
  eventId: string;
  type: string;
  tenantId: string | null;
  actorId?: string | null;
  createdAt: Date;
}

export type EventHandlerFn = (payload: Record<string, any>, meta: EventMeta) => Promise<unknown>;

/**
 * Marks a provider method as a handler for a domain event. Handlers run asynchronously in the
 * worker, at-least-once, inside the event's tenant context, so they must be idempotent.
 */
export const OnDomainEvent = (...types: DomainEventType[]) => SetMetadata(EVENT_HANDLER, types);

interface RegisteredHandler {
  name: string;
  fn: EventHandlerFn;
}

@Injectable()
export class EventHandlerRegistry implements OnModuleInit {
  private readonly logger = new Logger(EventHandlerRegistry.name);
  private readonly byType = new Map<string, RegisteredHandler[]>();
  private readonly byName = new Map<string, RegisteredHandler>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== 'object' || !wrapper.metatype) continue;
      const proto = Object.getPrototypeOf(instance);
      for (const method of this.scanner.getAllMethodNames(proto)) {
        const types = this.reflector.get<string[] | undefined>(EVENT_HANDLER, proto[method]);
        if (!types?.length) continue;
        const name = `${wrapper.metatype.name}.${method}`;
        const handler = { name, fn: (proto[method] as EventHandlerFn).bind(instance) };
        this.byName.set(name, handler);
        for (const t of types) this.byType.set(t, [...(this.byType.get(t) ?? []), handler]);
      }
    }
    this.logger.log(`Registered ${this.byName.size} domain event handlers`);
  }

  handlersFor(type: string): RegisteredHandler[] {
    return this.byType.get(type) ?? [];
  }

  get(name: string): RegisteredHandler | undefined {
    return this.byName.get(name);
  }
}
