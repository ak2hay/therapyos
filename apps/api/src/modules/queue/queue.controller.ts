import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { queueAssignSchema, queueEntrySchema } from '@therapyos/validation';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { QueueService } from './queue.service';

const branchQuery = z.object({ branchId: z.string().min(1), serviceId: z.string().optional() });
const startSchema = z.object({ room: z.string().max(40).optional() });
const prioritySchema = z.object({ priority: z.coerce.number().int().min(0).max(10) });

@ApiTags('Queue')
@ApiBearerAuth()
@Controller('queue')
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.QUEUE_READ)
  board(@Query(Zod(branchQuery)) q: z.infer<typeof branchQuery>) {
    return this.queue.board(q.branchId);
  }

  @Get('estimate')
  @RequirePermissions(PERMISSIONS.QUEUE_READ)
  estimate(@Query(Zod(branchQuery)) q: z.infer<typeof branchQuery>) {
    return this.queue.estimate(q.branchId, q.serviceId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.QUEUE_MANAGE)
  add(@Body(Zod(queueEntrySchema)) body: z.infer<typeof queueEntrySchema>) {
    return this.queue.add(body);
  }

  @Post(':id/call')
  @RequirePermissions(PERMISSIONS.QUEUE_MANAGE)
  call(@Param('id') id: string) {
    return this.queue.call(id);
  }

  @Post(':id/assign')
  @RequirePermissions(PERMISSIONS.QUEUE_MANAGE)
  assign(@Param('id') id: string, @Body(Zod(queueAssignSchema)) body: z.infer<typeof queueAssignSchema>) {
    return this.queue.assign(id, body);
  }

  @Post(':id/start')
  @RequirePermissions(PERMISSIONS.QUEUE_MANAGE, PERMISSIONS.SESSION_MANAGE)
  start(@Param('id') id: string, @Body(Zod(startSchema)) body: z.infer<typeof startSchema>) {
    return this.queue.start(id, body.room);
  }

  @Post(':id/complete')
  @RequirePermissions(PERMISSIONS.QUEUE_MANAGE, PERMISSIONS.SESSION_MANAGE)
  complete(@Param('id') id: string) {
    return this.queue.complete(id);
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.QUEUE_MANAGE)
  cancel(@Param('id') id: string) {
    return this.queue.cancel(id);
  }

  @Patch(':id/priority')
  @RequirePermissions(PERMISSIONS.QUEUE_MANAGE)
  priority(@Param('id') id: string, @Body(Zod(prioritySchema)) body: z.infer<typeof prioritySchema>) {
    return this.queue.reorder(id, body.priority);
  }
}
