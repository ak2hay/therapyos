import { Global, Module } from '@nestjs/common';
import { IntegrationsConfigService } from './integrations-config.service';
import { MockPushProvider, PushProvider } from './messaging.providers';
import { PlatformSettingsService } from './platform-settings.service';
import { ProviderFactory } from './provider.factory';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [StorageService, IntegrationsConfigService, PlatformSettingsService, ProviderFactory, { provide: PushProvider, useClass: MockPushProvider }],
  exports: [StorageService, IntegrationsConfigService, PlatformSettingsService, ProviderFactory, PushProvider],
})
export class IntegrationsModule {}
