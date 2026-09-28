import { Module } from '@nestjs/common';
import { AuditController, SettingsController } from './settings.controller';

@Module({ controllers: [SettingsController, AuditController] })
export class SettingsModule {}
