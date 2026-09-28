import './bootstrap-env';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { initObservability } from './observability/observability';

process.env.WORKER_PROCESS = 'true';

/** Background worker: outbox relay, event handlers, notifications, scheduled jobs and reports. */
async function bootstrap() {
  await initObservability('therapyos-worker');
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log('TherapyOS worker started');
}

void bootstrap();
