import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EventHandlerRegistry } from './event-handlers';
import { OutboxRelay } from './outbox.relay';
import { QueueService } from './queue.service';

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [QueueService, EventHandlerRegistry, OutboxRelay],
  exports: [QueueService, EventHandlerRegistry, OutboxRelay],
})
export class JobsModule {}
