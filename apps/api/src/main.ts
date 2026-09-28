import './bootstrap-env';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { env } from './config/env';
import { mountBullBoard } from './jobs/bull-board';
import { initObservability } from './observability/observability';
import { setupApp } from './setup-app';

async function bootstrap() {
  await initObservability('therapyos-api');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  app.set('trust proxy', env().TRUST_PROXY);
  setupApp(app);
  mountBullBoard(app);
  app.enableShutdownHooks();
  await app.listen(env().PORT);
  app.get(Logger).log(`TherapyOS API listening on ${env().API_URL} (docs at /api/docs)`);
}

void bootstrap();
