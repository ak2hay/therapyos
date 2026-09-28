import { Body, Controller, Get, Global, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { couponSchema, CouponInput, offerSchema, OfferInput, queryBool, validateCouponSchema } from '@therapyos/validation';
import { z } from 'zod';
import { RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { OffersService } from './offers.service';

const offersQuery = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']).optional(), current: queryBool });
const couponsQuery = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']).optional(), search: z.string().optional() });

@ApiTags('Offers')
@ApiBearerAuth()
@Controller()
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Get('offers')
  @RequireAnyPermission(PERMISSIONS.OFFER_READ, PERMISSIONS.POS_USE)
  listOffers(@Query(Zod(offersQuery)) q: z.infer<typeof offersQuery>) {
    return this.offers.listOffers(q);
  }

  @Get('offers/:id')
  @RequirePermissions(PERMISSIONS.OFFER_READ)
  getOffer(@Param('id') id: string) {
    return this.offers.getOffer(id);
  }

  @Post('offers')
  @RequirePermissions(PERMISSIONS.OFFER_MANAGE)
  createOffer(@Body(Zod(offerSchema)) body: OfferInput) {
    return this.offers.createOffer(body);
  }

  @Patch('offers/:id')
  @RequirePermissions(PERMISSIONS.OFFER_MANAGE)
  updateOffer(@Param('id') id: string, @Body(Zod(offerSchema.partial())) body: Partial<OfferInput>) {
    return this.offers.updateOffer(id, body);
  }

  @Get('coupons')
  @RequirePermissions(PERMISSIONS.OFFER_READ)
  listCoupons(@Query(Zod(couponsQuery)) q: z.infer<typeof couponsQuery>) {
    return this.offers.listCoupons(q);
  }

  @Post('coupons/validate')
  @RequireAnyPermission(PERMISSIONS.OFFER_READ, PERMISSIONS.POS_USE)
  validate(@Body(Zod(validateCouponSchema)) body: z.infer<typeof validateCouponSchema>) {
    return this.offers.validate(body.code, body.customerId, body.orderAmount);
  }

  @Get('coupons/:id')
  @RequirePermissions(PERMISSIONS.OFFER_READ)
  getCoupon(@Param('id') id: string) {
    return this.offers.getCoupon(id);
  }

  @Post('coupons')
  @RequirePermissions(PERMISSIONS.OFFER_MANAGE)
  createCoupon(@Body(Zod(couponSchema)) body: CouponInput) {
    return this.offers.createCoupon(body);
  }

  @Patch('coupons/:id')
  @RequirePermissions(PERMISSIONS.OFFER_MANAGE)
  updateCoupon(@Param('id') id: string, @Body(Zod(couponSchema.partial())) body: Partial<CouponInput>) {
    return this.offers.updateCoupon(id, body);
  }
}

@Global()
@Module({ controllers: [OffersController], providers: [OffersService], exports: [OffersService] })
export class OffersModule {}
