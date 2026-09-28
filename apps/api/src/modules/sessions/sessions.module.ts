import { Global, Module } from '@nestjs/common';
import { SessionCompletedHandlers } from './session-completed.handlers';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Global()
@Module({
  controllers: [SessionsController],
  providers: [SessionsService, SessionCompletedHandlers],
  exports: [SessionsService],
})
export class SessionsModule {}
