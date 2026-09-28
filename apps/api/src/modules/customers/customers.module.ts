import { Global, Module } from '@nestjs/common';
import { CustomerMetricsService } from './customer-metrics.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Global()
@Module({
  controllers: [CustomersController],
  providers: [CustomersService, CustomerMetricsService],
  exports: [CustomersService, CustomerMetricsService],
})
export class CustomersModule {}
