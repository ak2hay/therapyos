import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuthzService } from './authz.service';
import { EventsService } from './events.service';
import { FeaturesService } from './features.service';
import { SettingsService } from './settings.service';
import { ActivityService } from './activity.service';

@Global()
@Module({
  providers: [AuditService, AuthzService, EventsService, FeaturesService, SettingsService, ActivityService],
  exports: [AuditService, AuthzService, EventsService, FeaturesService, SettingsService, ActivityService],
})
export class CoreModule {}
