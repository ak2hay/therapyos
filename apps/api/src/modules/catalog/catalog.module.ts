import { Global, Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { ServicesService } from './services.service';
import { TherapistsService } from './therapists.service';

@Global()
@Module({
  controllers: [CatalogController],
  providers: [ServicesService, TherapistsService],
  exports: [ServicesService, TherapistsService],
})
export class CatalogModule {}
