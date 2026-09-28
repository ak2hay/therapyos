import { Body, Controller, Get, Headers, HttpCode, Module, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { changePlanSchema } from '@therapyos/validation';
import type { Request } from 'express';
import { z } from 'zod';
import { AllowOnboarding, Public, RawResponse, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { SubscriptionService } from './subscription.service';

@ApiTags('Subscription')
@ApiBearerAuth()
@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptions: SubscriptionService) {}

  @Get()
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  summary() {
    return this.subscriptions.summary();
  }

  @Post('change')
  @AllowOnboarding()
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  change(@Body(Zod(changePlanSchema)) body: z.infer<typeof changePlanSchema>) {
    return this.subscriptions.change(body.planId, body.billingCycle);
  }

  @Post('cancel')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  cancel() {
    return this.subscriptions.cancel();
  }

  @Post('resume')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  resume() {
    return this.subscriptions.resume();
  }
}

@ApiTags('Subscription')
@Controller('webhooks/razorpay')
export class SubscriptionWebhooksController {
  constructor(private readonly subscriptions: SubscriptionService) {}

  @Post('subscriptions')
  @Public()
  @RawResponse()
  @HttpCode(200)
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature: string | undefined, @Body() body: unknown) {
    return this.subscriptions.webhook(req.rawBody, signature, body);
  }
}

@Module({ controllers: [SubscriptionController, SubscriptionWebhooksController], providers: [SubscriptionService], exports: [SubscriptionService] })
export class SubscriptionModule {}
