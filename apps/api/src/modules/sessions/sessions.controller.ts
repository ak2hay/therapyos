import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { cancelSchema, completeSessionSchema, sessionListQuery, sessionNotesSchema, sessionSchema } from '@therapyos/validation';
import { z } from 'zod';
import { RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { SessionsService } from './sessions.service';

const dayQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

@ApiTags('Sessions')
@ApiBearerAuth()
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  @RequireAnyPermission(PERMISSIONS.SESSION_READ, PERMISSIONS.SESSION_READ_OWN)
  list(@Query(Zod(sessionListQuery)) q: z.infer<typeof sessionListQuery>) {
    return this.sessions.list(q);
  }

  @Get('my-day')
  @RequirePermissions(PERMISSIONS.SESSION_READ_OWN)
  myDay(@Query(Zod(dayQuery)) q: z.infer<typeof dayQuery>) {
    return this.sessions.myDay(q.date);
  }

  @Get(':id')
  @RequireAnyPermission(PERMISSIONS.SESSION_READ, PERMISSIONS.SESSION_READ_OWN)
  get(@Param('id') id: string) {
    return this.sessions.get(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.SESSION_MANAGE)
  create(@Body(Zod(sessionSchema)) body: z.infer<typeof sessionSchema>) {
    return this.sessions.create(body);
  }

  @Post(':id/start')
  @RequirePermissions(PERMISSIONS.SESSION_MANAGE)
  start(@Param('id') id: string) {
    return this.sessions.start(id);
  }

  @Post(':id/pause')
  @RequirePermissions(PERMISSIONS.SESSION_MANAGE)
  pause(@Param('id') id: string) {
    return this.sessions.pause(id);
  }

  @Post(':id/resume')
  @RequirePermissions(PERMISSIONS.SESSION_MANAGE)
  resume(@Param('id') id: string) {
    return this.sessions.resume(id);
  }

  @Post(':id/complete')
  @RequirePermissions(PERMISSIONS.SESSION_MANAGE)
  complete(@Param('id') id: string, @Body(Zod(completeSessionSchema)) body: z.infer<typeof completeSessionSchema>) {
    return this.sessions.complete(id, body);
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.SESSION_MANAGE)
  cancel(@Param('id') id: string, @Body(Zod(cancelSchema)) body: z.infer<typeof cancelSchema>) {
    return this.sessions.cancel(id, body.reason);
  }

  @Patch(':id/notes')
  @RequirePermissions(PERMISSIONS.SESSION_NOTES)
  notes(@Param('id') id: string, @Body(Zod(sessionNotesSchema)) body: z.infer<typeof sessionNotesSchema>) {
    return this.sessions.updateNotes(id, body.notes);
  }
}
