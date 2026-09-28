import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, RawBodyRequest, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { FeatureFlagKey, PAYMENT_METHODS, PERMISSIONS } from '@therapyos/types';
import {
  cartCreateSchema,
  cartItemSchema,
  CartItemInput,
  checkoutSchema,
  CheckoutInput,
  emptyToUndefined,
  invoiceFromSessionSchema,
  isoDate,
  money,
  paginationQuery,
  paymentSchema,
  PaymentInput,
  queryBool,
  razorpayOrderSchema,
  razorpayVerifySchema,
  refundSchema,
  sellMembershipSchema,
  sellPackageSchema,
  updateCartSchema,
  voidInvoiceSchema,
} from '@therapyos/validation';
import { z } from 'zod';
import { Public, RawResponse, RequireFeature, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { CartsService } from './carts.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';

const openCartsQuery = z.object({ branchId: z.string().optional() });
const updateItemSchema = z.object({
  quantity: z.coerce.number().int().min(1).max(999).optional(),
  manualDiscount: emptyToUndefined(money),
  therapistId: z.string().nullable().optional(),
  customerPackageId: z.string().nullable().optional(),
  customerMembershipId: z.string().nullable().optional(),
});
const invoiceQuery = paginationQuery.extend({
  branchId: z.string().optional(),
  customerId: z.string().optional(),
  status: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  unpaid: queryBool,
});
const paymentQuery = paginationQuery.extend({
  branchId: z.string().optional(),
  method: z.string().optional(),
  status: z.string().optional(),
  invoiceId: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

@ApiTags('POS')
@ApiBearerAuth()
@Controller('carts')
export class CartsController {
  constructor(private readonly carts: CartsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.POS_USE)
  listOpen(@Query(Zod(openCartsQuery)) q: z.infer<typeof openCartsQuery>) {
    return this.carts.listOpen(q.branchId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.POS_USE)
  create(@Body(Zod(cartCreateSchema)) body: z.infer<typeof cartCreateSchema>) {
    return this.carts.create(body);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.POS_USE)
  get(@Param('id') id: string) {
    return this.carts.view(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.POS_USE)
  update(@Param('id') id: string, @Body(Zod(updateCartSchema)) body: z.infer<typeof updateCartSchema>) {
    return this.carts.update(id, body);
  }

  @Post(':id/items')
  @RequirePermissions(PERMISSIONS.POS_USE)
  addItem(@Param('id') id: string, @Body(Zod(cartItemSchema)) body: CartItemInput) {
    return this.carts.addItem(id, body);
  }

  @Patch(':id/items/:itemId')
  @RequirePermissions(PERMISSIONS.POS_USE)
  updateItem(@Param('id') id: string, @Param('itemId') itemId: string, @Body(Zod(updateItemSchema)) body: z.infer<typeof updateItemSchema>) {
    return this.carts.updateItem(id, itemId, body);
  }

  @Delete(':id/items/:itemId')
  @RequirePermissions(PERMISSIONS.POS_USE)
  removeItem(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.carts.removeItem(id, itemId);
  }

  @Post(':id/checkout')
  @RequirePermissions(PERMISSIONS.POS_USE, PERMISSIONS.INVOICE_CREATE)
  checkout(@Param('id') id: string, @Body(Zod(checkoutSchema)) body: CheckoutInput) {
    return this.carts.checkout(id, body);
  }

  @Post(':id/abandon')
  @RequirePermissions(PERMISSIONS.POS_USE)
  abandon(@Param('id') id: string) {
    return this.carts.abandon(id);
  }
}

@ApiTags('Invoices')
@ApiBearerAuth()
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly carts: CartsService,
    private readonly payments: PaymentsService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  list(@Query(Zod(invoiceQuery)) q: z.infer<typeof invoiceQuery>) {
    return this.invoices.list(q);
  }

  @Post('from-session')
  @RequirePermissions(PERMISSIONS.POS_USE)
  fromSession(@Body(Zod(invoiceFromSessionSchema)) body: z.infer<typeof invoiceFromSessionSchema>) {
    return this.carts.fromSession(body.sessionId);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  get(@Param('id') id: string) {
    return this.invoices.detail(id);
  }

  @Get(':id/pdf')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  async pdf(@Param('id') id: string, @Query('download') download: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { buffer, filename } = await this.invoices.pdf(id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`, 'Cache-Control': 'private, no-store' });
    return new StreamableFile(buffer);
  }

  @Post(':id/void')
  @RequirePermissions(PERMISSIONS.INVOICE_VOID)
  void(@Param('id') id: string, @Body(Zod(voidInvoiceSchema)) body: z.infer<typeof voidInvoiceSchema>) {
    return this.invoices.void(id, body.reason);
  }

  @Post(':id/payments')
  @RequirePermissions(PERMISSIONS.PAYMENT_CREATE)
  pay(@Param('id') id: string, @Body(Zod(paymentSchema)) body: PaymentInput) {
    return this.payments.record(id, body);
  }
}

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PAYMENT_READ)
  list(@Query(Zod(paymentQuery)) q: z.infer<typeof paymentQuery>) {
    return this.payments.list(q);
  }

  @Get('methods')
  @RequirePermissions(PERMISSIONS.PAYMENT_READ)
  methods() {
    return PAYMENT_METHODS.filter((m) => m !== 'PACKAGE' && m !== 'MEMBERSHIP');
  }

  @Post('gateway/order')
  @RequirePermissions(PERMISSIONS.PAYMENT_CREATE)
  order(@Body(Zod(razorpayOrderSchema)) body: z.infer<typeof razorpayOrderSchema>) {
    return this.payments.createOrder(body.invoiceId, body.amount);
  }

  @Post('gateway/verify')
  @RequirePermissions(PERMISSIONS.PAYMENT_CREATE)
  verify(@Body(Zod(razorpayVerifySchema)) body: z.infer<typeof razorpayVerifySchema>) {
    return this.payments.verify(body);
  }

  @Post(':id/mock-complete')
  @RequirePermissions(PERMISSIONS.PAYMENT_CREATE)
  mockComplete(@Param('id') id: string) {
    return this.payments.mockComplete(id);
  }

  @Post('refunds')
  @RequirePermissions(PERMISSIONS.PAYMENT_REFUND)
  refund(@Body(Zod(refundSchema)) body: z.infer<typeof refundSchema>) {
    return this.payments.refund(body);
  }
}

@ApiTags('Payments')
@Controller('webhooks')
export class PaymentWebhooksController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('razorpay')
  @Public()
  @RawResponse()
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature: string | undefined, @Body() body: unknown) {
    return this.payments.webhook(req.rawBody, signature, body);
  }
}

@ApiTags('Packages')
@ApiBearerAuth()
@Controller()
export class SellController {
  constructor(private readonly carts: CartsService) {}

  @Post('customer-packages/sell')
  @RequireFeature(FeatureFlagKey.PACKAGES_ENABLED)
  @RequirePermissions(PERMISSIONS.PACKAGE_SELL, PERMISSIONS.INVOICE_CREATE)
  sellPackage(@Body(Zod(sellPackageSchema)) body: z.infer<typeof sellPackageSchema>) {
    return this.carts.sellDirect({ branchId: body.branchId, customerId: body.customerId, itemType: 'PACKAGE', itemId: body.packageId });
  }

  @Post('memberships/sell')
  @RequireFeature(FeatureFlagKey.MEMBERSHIP_ENABLED)
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_SELL, PERMISSIONS.INVOICE_CREATE)
  sellMembership(@Body(Zod(sellMembershipSchema)) body: z.infer<typeof sellMembershipSchema>) {
    return this.carts.sellDirect({ branchId: body.branchId, customerId: body.customerId, itemType: 'MEMBERSHIP', itemId: body.membershipPlanId, autoRenew: body.autoRenew, startDate: body.startDate });
  }
}
