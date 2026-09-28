import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env, isProd } from './config/env';
import { httpDuration } from './observability/observability';

/** Shared HTTP setup used by main.ts and the integration tests. */
export function setupApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live', 'metrics'] });
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());
  const allowed = env()
    .CORS_ORIGINS.split(',')
    .map((o) => o.trim());
  // Flutter web and other local dev servers pick random ports; production only trusts CORS_ORIGINS.
  const localDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, !origin || allowed.includes(origin) || (!isProd() && localDev.test(origin))),
    credentials: true,
  });
  app.use((req: any, res: any, next: () => void) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => end({ method: req.method, route: req.route?.path ?? 'unmatched', status: res.statusCode }));
    next();
  });

  const config = new DocumentBuilder()
    .setTitle('Rkyves TherapyOS API')
    .setDescription('Multi-tenant business operating system for therapy & wellness businesses')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  if (!isProd() || env().API_DOCS_ENABLED) SwaggerModule.setup('api/docs', app, document);
  return document;
}
