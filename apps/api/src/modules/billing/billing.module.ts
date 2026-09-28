import { Global, Module } from '@nestjs/common';
import { CartsController, InvoicesController, PaymentsController, PaymentWebhooksController, SellController } from './billing.controller';
import { CartsService } from './carts.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';
import { PricingService } from './pricing.service';

@Global()
@Module({
  controllers: [CartsController, InvoicesController, PaymentsController, PaymentWebhooksController, SellController],
  providers: [PricingService, InvoicesService, PaymentsService, CartsService],
  exports: [PricingService, InvoicesService, PaymentsService, CartsService],
})
export class BillingModule {}
