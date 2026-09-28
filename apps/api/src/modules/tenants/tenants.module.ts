import { Module } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { TenantsController } from './tenants.controller';

@Module({
  controllers: [TenantsController],
  providers: [ProvisioningService],
  exports: [ProvisioningService],
})
export class TenantsModule {}
