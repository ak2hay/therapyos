import { Body, Controller, Get, HttpCode, Module, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { integrationProviderSchema, integrationTestSchema } from '@therapyos/validation';
import { z } from 'zod';
import { Public, RequirePermissions } from '../../common/decorators';
import { RequestContext } from '../../common/context/request-context';
import { Zod } from '../../common/pipes/zod.pipe';
import { PlatformSettingsService } from '../../integrations/platform-settings.service';
import { IntegrationSettingsService } from './integration-settings.service';

type Provider = z.infer<typeof integrationProviderSchema>;

/** A business's own Razorpay / MSG91 / WhatsApp / SMTP accounts, overriding the platform defaults. */
@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly settings: IntegrationSettingsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  list() {
    return this.settings.list(RequestContext.requireTenantId());
  }

  @Put(':provider')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  update(@Param('provider', Zod(integrationProviderSchema)) provider: Provider, @Body() body: unknown) {
    return this.settings.update(provider, RequestContext.requireTenantId(), body);
  }

  @Post(':provider/test')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  test(@Param('provider', Zod(integrationProviderSchema)) provider: Provider, @Body(Zod(integrationTestSchema)) body: z.infer<typeof integrationTestSchema>) {
    return this.settings.test(provider, RequestContext.requireTenantId(), body.to);
  }
}

@ApiTags('Platform')
@Controller('public/platform')
export class PublicPlatformController {
  constructor(private readonly platform: PlatformSettingsService) {}

  @Public()
  @Get()
  get() {
    return this.platform.publicView();
  }
}

@Module({
  controllers: [IntegrationsController, PublicPlatformController],
  providers: [IntegrationSettingsService],
  exports: [IntegrationSettingsService],
})
export class IntegrationSettingsModule {}
