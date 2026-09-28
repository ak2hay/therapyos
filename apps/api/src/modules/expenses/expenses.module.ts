import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { expenseQuery, expenseSchema, ExpenseInput } from '@therapyos/validation';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { ExpensesService } from './expenses.service';

@ApiTags('Expenses')
@ApiBearerAuth()
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.EXPENSE_READ)
  list(@Query(Zod(expenseQuery)) q: z.infer<typeof expenseQuery>) {
    return this.expenses.list(q);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.EXPENSE_READ)
  get(@Param('id') id: string) {
    return this.expenses.get(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.EXPENSE_MANAGE)
  create(@Body(Zod(expenseSchema)) body: ExpenseInput) {
    return this.expenses.create(body);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.EXPENSE_MANAGE)
  update(@Param('id') id: string, @Body(Zod(expenseSchema.partial())) body: Partial<ExpenseInput>) {
    return this.expenses.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.EXPENSE_MANAGE)
  remove(@Param('id') id: string) {
    return this.expenses.remove(id);
  }
}

@Module({ controllers: [ExpensesController], providers: [ExpensesService], exports: [ExpensesService] })
export class ExpensesModule {}
