import { Controller, Get, Global, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { isoDate, paginationQuery } from '@therapyos/validation';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { LedgerService } from './ledger.service';

const entriesQuery = paginationQuery.extend({
  branchId: z.string().optional(),
  accountCode: z.string().optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
const balanceQuery = z.object({ branchId: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() });

@ApiTags('Ledger')
@ApiBearerAuth()
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('entries')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  entries(@Query(Zod(entriesQuery)) q: z.infer<typeof entriesQuery>) {
    return this.ledger.entries(q);
  }

  @Get('trial-balance')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  trialBalance(@Query(Zod(balanceQuery)) q: z.infer<typeof balanceQuery>) {
    return this.ledger.trialBalance(q);
  }
}

@Global()
@Module({ controllers: [LedgerController], providers: [LedgerService], exports: [LedgerService] })
export class LedgerModule {}
