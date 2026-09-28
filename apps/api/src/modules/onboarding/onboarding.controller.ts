import { Body, Controller, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { AllowOnboarding, RequirePermissions } from '../../common/decorators';
import { OnboardingService } from './onboarding.service';

@ApiTags('Onboarding')
@ApiBearerAuth()
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.TENANT_READ)
  state() {
    return this.onboarding.state();
  }

  @Get('templates/:businessType')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.TENANT_READ)
  template(@Param('businessType') businessType: string) {
    return this.onboarding.template(businessType);
  }

  @Put('steps/:step')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.TENANT_UPDATE)
  save(@Param('step', ParseIntPipe) step: number, @Body() body: Record<string, unknown>) {
    return this.onboarding.saveStep(step, body ?? {});
  }

  @Post('steps/:step/skip')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.TENANT_UPDATE)
  skip(@Param('step', ParseIntPipe) step: number) {
    return this.onboarding.skip(step);
  }

  @Post('complete')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.TENANT_UPDATE)
  complete() {
    return this.onboarding.complete();
  }
}
