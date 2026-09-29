import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().default('http://localhost:3000'),
  API_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6380'),
  JWT_ACCESS_SECRET: z.string().min(16),
  /** Encrypts integration secrets stored in the database (32-byte hex/base64 or a long passphrase). */
  SETTINGS_ENCRYPTION_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32).optional()),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  RUN_WORKER_IN_API: bool,
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('therapyos'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  EMAIL_PROVIDER: z.enum(['smtp', 'mock']).default('mock'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('TherapyOS <no-reply@therapyos.local>'),
  SMS_PROVIDER: z.enum(['mock', 'msg91', 'twilio']).default('mock'),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),
  WHATSAPP_PROVIDER: z.enum(['mock', 'cloud']).default('mock'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** JSON map of TherapyOS plan to Razorpay plan id, e.g. {"GROWTH:MONTHLY":"plan_ABC"}. */
  RAZORPAY_PLAN_MAP: z.string().default('{}'),
  SUBSCRIPTION_GRACE_DAYS: z.coerce.number().default(7),
  GOOGLE_CLIENT_ID: z.string().optional(),
  LLM_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  LOG_LEVEL: z.string().default('info'),
  SENTRY_DSN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  /** Serve Swagger UI at /api/docs in production (always on in development and test). */
  API_DOCS_ENABLED: bool,
  /** When set, GET /metrics requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.string().optional(),
  /** Number of reverse-proxy hops in front of the API (drives client IP for rate limits and audit logs). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  PLATFORM_ADMIN_EMAIL: z.string().optional(),
  PLATFORM_ADMIN_PASSWORD: z.string().optional(),
  BULL_BOARD_USER: z.string().default('admin'),
  BULL_BOARD_PASSWORD: z.string().optional(),
}).superRefine((e, ctx) => {
  if (e.NODE_ENV === 'production' && e.JWT_ACCESS_SECRET.length < 32) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_ACCESS_SECRET'], message: 'must be at least 32 characters in production' });
  }
  if (e.NODE_ENV === 'production' && !e.SETTINGS_ENCRYPTION_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SETTINGS_ENCRYPTION_KEY'], message: 'is required in production' });
  }
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const isProd = () => env().NODE_ENV === 'production';
export const isTest = () => env().NODE_ENV === 'test';
