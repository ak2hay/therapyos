import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { CampaignAudienceInput, campaignAudienceSchema, CampaignInput, campaignQuery, campaignScheduleSchema, campaignSchema } from '@therapyos/validation';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { CampaignsService } from './campaigns.service';

@ApiTags('Campaigns')
@ApiBearerAuth()
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CAMPAIGN_READ)
  list(@Query(Zod(campaignQuery)) q: z.infer<typeof campaignQuery>) {
    return this.campaigns.list(q);
  }

  @Post('audience')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_READ)
  audience(@Body(Zod(campaignAudienceSchema)) body: CampaignAudienceInput) {
    return this.campaigns.audience(body);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_READ)
  get(@Param('id') id: string) {
    return this.campaigns.get(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  create(@Body(Zod(campaignSchema)) body: CampaignInput) {
    return this.campaigns.create(body);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  update(@Param('id') id: string, @Body(Zod(campaignSchema.partial())) body: Partial<CampaignInput>) {
    return this.campaigns.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  remove(@Param('id') id: string) {
    return this.campaigns.remove(id);
  }

  @Post(':id/send')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  send(@Param('id') id: string) {
    return this.campaigns.send(id);
  }

  @Post(':id/schedule')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  schedule(@Param('id') id: string, @Body(Zod(campaignScheduleSchema)) body: z.infer<typeof campaignScheduleSchema>) {
    return this.campaigns.schedule(id, body.scheduledAt);
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  cancel(@Param('id') id: string) {
    return this.campaigns.cancel(id);
  }
}

@Module({ controllers: [CampaignsController], providers: [CampaignsService], exports: [CampaignsService] })
export class CampaignsModule {}
