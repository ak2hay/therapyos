import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { appointmentListQuery, appointmentSchema, AppointmentInput, availabilityQuery, cancelSchema, updateAppointmentSchema } from '@therapyos/validation';
import { z } from 'zod';
import { ApiKeyAllowed, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { Zod } from '../../common/pipes/zod.pipe';
import { QueueService } from '../queue/queue.service';
import { SessionsService } from '../sessions/sessions.service';
import { AppointmentsService } from './appointments.service';
import { AvailabilityService } from './availability.service';

const boardQuery = z.object({ branchId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const startSchema = z.object({ room: z.string().max(40).optional(), therapistId: z.string().optional() });

@ApiTags('Appointments')
@ApiBearerAuth()
@Controller('appointments')
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly availability: AvailabilityService,
    private readonly queue: QueueService,
    private readonly sessions: SessionsService,
  ) {}

  @Get()
  @ApiKeyAllowed()
  @RequireAnyPermission(PERMISSIONS.APPOINTMENT_READ, PERMISSIONS.SESSION_READ_OWN)
  list(@Query(Zod(appointmentListQuery)) q: z.infer<typeof appointmentListQuery>) {
    return this.appointments.list(q);
  }

  @Get('board')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_READ)
  board(@Query(Zod(boardQuery)) q: z.infer<typeof boardQuery>) {
    return this.appointments.board(q.branchId, q.date);
  }

  @Get('availability')
  @ApiKeyAllowed()
  @RequireAnyPermission(PERMISSIONS.APPOINTMENT_READ, PERMISSIONS.APPOINTMENT_CREATE)
  slots(@Query(Zod(availabilityQuery)) q: z.infer<typeof availabilityQuery>) {
    return this.availability.slots(q);
  }

  @Get(':id')
  @RequireAnyPermission(PERMISSIONS.APPOINTMENT_READ, PERMISSIONS.SESSION_READ_OWN)
  get(@Param('id') id: string) {
    return this.appointments.get(id);
  }

  @Post()
  @ApiKeyAllowed()
  @RequirePermissions(PERMISSIONS.APPOINTMENT_CREATE)
  create(@Body(Zod(appointmentSchema)) body: AppointmentInput) {
    return this.appointments.create(body);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_UPDATE)
  update(@Param('id') id: string, @Body(Zod(updateAppointmentSchema)) body: z.infer<typeof updateAppointmentSchema>) {
    return this.appointments.update(id, body);
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_CANCEL)
  cancel(@Param('id') id: string, @Body(Zod(cancelSchema)) body: z.infer<typeof cancelSchema>) {
    return this.appointments.cancel(id, body.reason);
  }

  @Post(':id/check-in')
  @RequireAnyPermission(PERMISSIONS.APPOINTMENT_UPDATE, PERMISSIONS.QUEUE_MANAGE)
  checkIn(@Param('id') id: string) {
    return this.queue.checkInAppointment(id);
  }

  /** Starts the therapy session for a checked-in (or booked) appointment. */
  @Post(':id/start')
  @RequirePermissions(PERMISSIONS.SESSION_MANAGE)
  async start(@Param('id') id: string, @Body(Zod(startSchema)) body: z.infer<typeof startSchema>) {
    const a = await this.appointments.get(id);
    const therapistId = body.therapistId ?? a.therapistId;
    if (!therapistId) throw AppError.invalidState('Assign a therapist before starting the session.');
    return this.sessions.create({
      branchId: a.branchId,
      customerId: a.customerId,
      therapistId,
      serviceId: a.serviceId,
      appointmentId: a.id,
      queueEntryId: a.queueEntry?.id,
      room: body.room,
      startNow: true,
    });
  }
}
