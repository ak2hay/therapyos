import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { integrationProviderSchema, integrationTestSchema } from '@therapyos/validation';
import { z } from 'zod';
import { Public, RequirePermissions } from '../../common/decorators';
import { RequestContext } from '../../common/context/request-context';
import { Zod } from '../../common/pipes/zod.pipe';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { PlatformSettingsService } from '../../integrations/platform-settings.service';
import { ProviderFactory } from '../../integrations/provider.factory';
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

const otpWidgetQuery = z.object({ tenant: z.string().trim().max(80).optional() });

/** Widget ID, token and channels for starting the MSG91 OTP Widget on a login screen. */
@ApiTags('Platform')
@Controller('public/otp-widget')
export class PublicOtpWidgetController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly providers: ProviderFactory,
  ) {}

  @Public()
  @Get()
  async get(@Query(Zod(otpWidgetQuery)) q: z.infer<typeof otpWidgetQuery>) {
    const tenant = q.tenant ? await this.db.tenant.findUnique({ where: { slug: q.tenant }, select: { id: true } }) : null;
    return this.providers.otpWidgetPublicConfig(tenant?.id ?? null);
  }
}

@Module({
  controllers: [IntegrationsController, PublicPlatformController, PublicOtpWidgetController],
  providers: [IntegrationSettingsService],
  exports: [IntegrationSettingsService],
})
export class IntegrationSettingsModule {}
