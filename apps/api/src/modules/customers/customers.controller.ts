import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { customerListQuery, customerSchema, CustomerInput, updateCustomerSchema } from '@therapyos/validation';
import { z } from 'zod';
import { ApiKeyAllowed, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { CustomersService } from './customers.service';

const noteSchema = z.object({ note: z.string().trim().min(1).max(2000) });
const timelineQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  type: z.string().optional(),
});

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiKeyAllowed()
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  list(@Query(Zod(customerListQuery)) q: z.infer<typeof customerListQuery>) {
    return this.customers.list(q);
  }

  @Get('lookup')
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  lookup(@Query('q') q = '') {
    return this.customers.lookup(q);
  }

  @Get(':id')
  @ApiKeyAllowed()
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  get(@Param('id') id: string) {
    return this.customers.get(id);
  }

  @Get(':id/timeline')
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  timeline(@Param('id') id: string, @Query(Zod(timelineQuery)) q: z.infer<typeof timelineQuery>) {
    return this.customers.timeline(id, q.page, q.pageSize, q.type);
  }

  @Get(':id/history')
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  history(@Param('id') id: string) {
    return this.customers.history(id);
  }

  @Post()
  @ApiKeyAllowed()
  @RequirePermissions(PERMISSIONS.CUSTOMER_CREATE)
  create(@Body(Zod(customerSchema)) body: CustomerInput) {
    return this.customers.create(body);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CUSTOMER_UPDATE)
  update(@Param('id') id: string, @Body(Zod(updateCustomerSchema)) body: z.infer<typeof updateCustomerSchema>) {
    return this.customers.update(id, body);
  }

  @Post(':id/notes')
  @RequirePermissions(PERMISSIONS.CUSTOMER_UPDATE)
  addNote(@Param('id') id: string, @Body(Zod(noteSchema)) body: z.infer<typeof noteSchema>) {
    return this.customers.addNote(id, body.note);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.CUSTOMER_DELETE)
  remove(@Param('id') id: string) {
    return this.customers.remove(id);
  }
}
