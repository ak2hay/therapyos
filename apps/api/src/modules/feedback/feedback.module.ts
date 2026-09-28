import { Body, Controller, Get, Module, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PERMISSIONS } from '@therapyos/types';
import { feedbackQuery, feedbackSchema, manualFeedbackSchema, publicBranchFeedbackSchema } from '@therapyos/validation';
import { z } from 'zod';
import { Public, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { FeedbackService } from './feedback.service';

const reviewUrlSchema = z.object({ googleReviewUrl: z.preprocess((v) => (v === '' ? null : v), z.string().url().max(500).nullable()) });

@ApiTags('Feedback')
@Controller('public/feedback')
export class PublicFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Public()
  @Get('branch/:slug/:code')
  branchInfo(@Param('slug') slug: string, @Param('code') code: string) {
    return this.feedback.branchInfo(slug, code);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('branch/:slug/:code')
  submitBranch(@Param('slug') slug: string, @Param('code') code: string, @Body(Zod(publicBranchFeedbackSchema)) body: z.infer<typeof publicBranchFeedbackSchema>) {
    return this.feedback.submitBranch(slug, code, body);
  }

  @Public()
  @Get(':token')
  tokenInfo(@Param('token') token: string) {
    return this.feedback.tokenInfo(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token')
  submitToken(@Param('token') token: string, @Body(Zod(feedbackSchema)) body: z.infer<typeof feedbackSchema>) {
    return this.feedback.submitToken(token, body);
  }
}

@ApiTags('Feedback')
@ApiBearerAuth()
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.FEEDBACK_READ)
  list(@Query(Zod(feedbackQuery)) q: z.infer<typeof feedbackQuery>) {
    return this.feedback.list(q);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.FEEDBACK_MANAGE)
  create(@Body(Zod(manualFeedbackSchema)) body: z.infer<typeof manualFeedbackSchema>) {
    return this.feedback.createManual(body);
  }

  @Get('qr/:branchId')
  @RequirePermissions(PERMISSIONS.FEEDBACK_READ)
  qr(@Param('branchId') branchId: string) {
    return this.feedback.branchQr(branchId);
  }

  @Put('qr/:branchId/review-url')
  @RequirePermissions(PERMISSIONS.FEEDBACK_MANAGE)
  reviewUrl(@Param('branchId') branchId: string, @Body(Zod(reviewUrlSchema)) body: z.infer<typeof reviewUrlSchema>) {
    return this.feedback.setReviewUrl(branchId, body.googleReviewUrl);
  }
}

@Module({ controllers: [PublicFeedbackController, FeedbackController], providers: [FeedbackService], exports: [FeedbackService] })
export class FeedbackModule {}
