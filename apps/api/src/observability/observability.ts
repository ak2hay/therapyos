import * as Sentry from '@sentry/node';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import { env } from '../config/env';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: 'therapyos_' });

export const httpDuration = new Histogram({
  name: 'therapyos_http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const jobCounter = new Counter({
  name: 'therapyos_jobs_total',
  help: 'Background jobs processed',
  labelNames: ['queue', 'name', 'result'],
  registers: [metricsRegistry],
});

export const notificationCounter = new Counter({
  name: 'therapyos_notifications_total',
  help: 'Notifications by channel and status',
  labelNames: ['channel', 'status'],
  registers: [metricsRegistry],
});

export const webhookCounter = new Counter({
  name: 'therapyos_webhooks_total',
  help: 'Inbound webhooks by provider and result',
  labelNames: ['provider', 'result'],
  registers: [metricsRegistry],
});

let initialised = false;

/** Initialises Sentry and (optionally) OpenTelemetry tracing. Safe to call multiple times. */
export async function initObservability(serviceName: string) {
  if (initialised) return;
  initialised = true;
  const e = env();
  if (e.SENTRY_DSN) {
    Sentry.init({ dsn: e.SENTRY_DSN, environment: e.NODE_ENV, tracesSampleRate: 0.1, serverName: serviceName });
  }
  if (e.OTEL_EXPORTER_OTLP_ENDPOINT) {
    try {
      // Optional dependency: install @opentelemetry/sdk-node + auto-instrumentations to enable tracing.
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { NodeSDK } = require('@opentelemetry/sdk-node');
      const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const sdk = new NodeSDK({
        serviceName,
        traceExporter: new OTLPTraceExporter({ url: `${e.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
        instrumentations: [getNodeAutoInstrumentations()],
      });
      sdk.start();
    } catch {
      console.warn('OTEL_EXPORTER_OTLP_ENDPOINT is set but OpenTelemetry packages are not installed; tracing disabled.');
    }
  }
}
