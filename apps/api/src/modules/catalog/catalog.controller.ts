import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import {
  branchServiceSchema,
  scheduleExceptionSchema,
  scheduleSchema,
  serviceCategorySchema,
  serviceSchema,
  ServiceInput,
  therapistSchema,
  TherapistInput,
} from '@therapyos/validation';
import { z } from 'zod';
import { AllowOnboarding, ApiKeyAllowed, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { ServicesService } from './services.service';
import { TherapistsService } from './therapists.service';

const listQuery = z.object({
  branchId: z.string().optional(),
  active: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  categoryId: z.string().optional(),
  serviceId: z.string().optional(),
  search: z.string().optional(),
});
type ListQuery = z.infer<typeof listQuery>;

@ApiTags('Catalogue')
@ApiBearerAuth()
@Controller()
export class CatalogController {
  constructor(
    private readonly services: ServicesService,
    private readonly therapists: TherapistsService,
  ) {}

  // ---------- categories ----------
  @Get('service-categories')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SERVICE_READ)
  listCategories() {
    return this.services.listCategories();
  }

  @Post('service-categories')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SERVICE_MANAGE)
  createCategory(@Body(Zod(serviceCategorySchema)) body: z.infer<typeof serviceCategorySchema>) {
    return this.services.createCategory(body);
  }

  @Patch('service-categories/:id')
  @RequirePermissions(PERMISSIONS.SERVICE_MANAGE)
  updateCategory(@Param('id') id: string, @Body(Zod(serviceCategorySchema.partial())) body: Partial<z.infer<typeof serviceCategorySchema>>) {
    return this.services.updateCategory(id, body);
  }

  @Delete('service-categories/:id')
  @RequirePermissions(PERMISSIONS.SERVICE_MANAGE)
  deleteCategory(@Param('id') id: string) {
    return this.services.deleteCategory(id);
  }

  // ---------- services ----------
  @Get('services')
  @AllowOnboarding()
  @ApiKeyAllowed()
  @RequirePermissions(PERMISSIONS.SERVICE_READ)
  listServices(@Query(Zod(listQuery)) q: ListQuery) {
    return this.services.list(q);
  }

  @Get('services/:id')
  @RequirePermissions(PERMISSIONS.SERVICE_READ)
  getService(@Param('id') id: string) {
    return this.services.get(id);
  }

  @Post('services')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SERVICE_MANAGE)
  createService(@Body(Zod(serviceSchema)) body: ServiceInput) {
    return this.services.create(body);
  }

  @Patch('services/:id')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SERVICE_MANAGE)
  updateService(@Param('id') id: string, @Body(Zod(serviceSchema.partial())) body: Partial<ServiceInput>) {
    return this.services.update(id, body);
  }

  @Delete('services/:id')
  @RequirePermissions(PERMISSIONS.SERVICE_MANAGE)
  deactivateService(@Param('id') id: string) {
    return this.services.deactivate(id);
  }

  @Put('services/:id/branches')
  @RequirePermissions(PERMISSIONS.SERVICE_MANAGE)
  setBranchOverride(@Param('id') id: string, @Body(Zod(branchServiceSchema)) body: z.infer<typeof branchServiceSchema>) {
    return this.services.setBranchOverride(id, body);
  }

  @Delete('services/:id/branches/:branchId')
  @RequirePermissions(PERMISSIONS.SERVICE_MANAGE)
  removeBranchOverride(@Param('id') id: string, @Param('branchId') branchId: string) {
    return this.services.removeBranchOverride(id, branchId);
  }

  // ---------- therapists ----------
  @Get('therapists')
  @AllowOnboarding()
  @ApiKeyAllowed()
  @RequireAnyPermission(PERMISSIONS.THERAPIST_READ, PERMISSIONS.APPOINTMENT_READ, PERMISSIONS.QUEUE_READ)
  listTherapists(@Query(Zod(listQuery)) q: ListQuery) {
    return this.therapists.list(q);
  }

  @Get('therapists/me')
  @RequirePermissions(PERMISSIONS.SESSION_READ_OWN)
  me() {
    return this.therapists.me();
  }

  @Get('therapists/:id')
  @RequirePermissions(PERMISSIONS.THERAPIST_READ)
  getTherapist(@Param('id') id: string) {
    return this.therapists.get(id);
  }

  @Post('therapists')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.THERAPIST_MANAGE)
  createTherapist(@Body(Zod(therapistSchema)) body: TherapistInput) {
    return this.therapists.create(body);
  }

  @Patch('therapists/:id')
  @RequirePermissions(PERMISSIONS.THERAPIST_MANAGE)
  updateTherapist(@Param('id') id: string, @Body(Zod(therapistSchema.partial())) body: Partial<TherapistInput>) {
    return this.therapists.update(id, body);
  }

  @Put('therapists/:id/schedule')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.THERAPIST_MANAGE)
  setSchedule(@Param('id') id: string, @Body(Zod(scheduleSchema)) body: z.infer<typeof scheduleSchema>) {
    return this.therapists.setSchedule(id, body);
  }

  @Get('therapists/:id/exceptions')
  @RequirePermissions(PERMISSIONS.THERAPIST_READ)
  listExceptions(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.therapists.listExceptions(id, from, to);
  }

  @Post('therapists/:id/exceptions')
  @RequirePermissions(PERMISSIONS.THERAPIST_MANAGE)
  addException(@Param('id') id: string, @Body(Zod(scheduleExceptionSchema)) body: z.infer<typeof scheduleExceptionSchema>) {
    return this.therapists.addException(id, body);
  }

  @Delete('therapists/:id/exceptions/:exceptionId')
  @RequirePermissions(PERMISSIONS.THERAPIST_MANAGE)
  removeException(@Param('id') id: string, @Param('exceptionId') exceptionId: string) {
    return this.therapists.removeException(id, exceptionId);
  }
}
