# Rkyves TherapyOS

Multi-tenant business operating system for therapy, physiotherapy, spa and wellness businesses: appointments and walk-ins, therapy sessions, billing and payments, packages and memberships, inventory, expenses, reports, retention marketing, multi-branch HQ and franchise management, a SaaS super-admin console, a public API, an AI business assistant, and staff + customer mobile apps.

The product specification lives in [`Rkyves_TherapyOS_Detailed_Architecture.md`](Rkyves_TherapyOS_Detailed_Architecture.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS 11 REST + WebSocket API, BullMQ workers, Prisma 6 (PostgreSQL) |
| `apps/web` | Next.js 15 web app: back office, POS, dashboards, super-admin console, public booking and feedback pages |
| `apps/mobile` | Flutter app with two flavors: `staff` (therapists, reception, managers) and `customer` - see [`apps/mobile/README.md`](apps/mobile/README.md) |
| `packages/validation` | Shared Zod schemas used by the API (request validation) and the web app (forms) |
| `packages/types` | Shared enums, permission keys, role templates and DTO types |
| `packages/api-client` | Typed fetch client used by the web app |
| `packages/ui` | Shared React UI components |
| `packages/config` | Shared TypeScript configuration |
| `infrastructure/docker` | Local infrastructure (`docker-compose.yml`) and production Dockerfiles |
| `infrastructure/scripts` | Database backup, restore and restore-test scripts |
| `docs` | [Operations](docs/operations.md) and [security](docs/security.md) guides |

## Architecture in brief

- **Modular monolith.** Each business area is a NestJS module under `apps/api/src/modules` (appointments, queue, sessions, billing, packages, memberships, inventory, reports, campaigns, franchise, subscription, admin, portal, ai, ...). Modules communicate through services and a transactional outbox of domain events.
- **Multi-tenancy.** Every tenant-owned table carries `tenantId`. A Prisma client extension (`apps/api/src/common/prisma/prisma.service.ts`) injects the current tenant into every query from the request context, so application code cannot accidentally read another tenant's rows. Integration tests in `apps/api/test/tenant-isolation.e2e-spec.ts` verify this over HTTP.
- **Request pipeline.** Rate limit, authentication (staff JWT, customer JWT, platform-admin JWT or API key), tenant context, feature flag / plan check, permission and branch-scope check, Zod validation, business logic. Errors use one envelope: `{ "success": false, "error": { "code", "message", "details" } }`.
- **RBAC.** Permission keys and role templates live in `packages/types`. Roles are stored per tenant and can be customised; users can be restricted to specific branches.
- **Async work.** Domain events are written to an outbox table in the same transaction as the change, then dispatched to BullMQ queues (notifications, campaigns, reports, scheduled jobs such as reminders, membership expiry, royalty calculation and subscription renewals). Workers run in a separate process (`dist/worker.js`) or inside the API for development (`RUN_WORKER_IN_API=true`).
- **Integrations behind adapters.** Payments (Razorpay), WhatsApp Cloud API, SMS (MSG91/Twilio), email (SMTP), object storage (S3-compatible) and the LLM (OpenAI) each have a mock implementation. Real providers are switched on by environment variables, so the whole product runs locally without third-party accounts.
- **Realtime.** Socket.IO rooms per tenant/branch push queue-board and session updates to the web and mobile apps.

## Prerequisites

- Node.js 22 and pnpm 11 (`corepack enable`)
- Docker (PostgreSQL 17, Redis 7, SeaweedFS for S3, Mailpit for email)
- Flutter 3.35+ only if you work on the mobile app

## Local setup

```bash
pnpm install
pnpm infra:up                               # postgres :5434, redis :6380, s3 :8333, mailpit :8025
cp apps/api/.env.example apps/api/.env      # then adjust values if needed
pnpm db:deploy                              # apply Prisma migrations
pnpm db:seed                                # demo businesses, staff, customers and history
pnpm dev                                    # API on :4000, web on :3000
```

- Web app: <http://localhost:3000>
- API docs (OpenAPI / Swagger): <http://localhost:4000/api/docs>
- Queue dashboard: <http://localhost:4000/admin/queues> (basic auth; `admin` / `admin` in development)
- Captured emails: <http://localhost:8025>

### Demo accounts

All staff passwords are `Demo@12345`.

| Business | Sign in as | Role |
| --- | --- | --- |
| Serenity Wellness (multi-branch, all features) | `owner@serenity.demo` | Business owner |
| | `hq@serenity.demo` | HQ admin |
| | `manager@serenity.demo` | Branch manager (Indiranagar) |
| | `area@serenity.demo` | Area manager (Koramangala) |
| | `reception@serenity.demo` | Receptionist |
| | `accounts@serenity.demo` | Accountant |
| | `inventory@serenity.demo` | Inventory manager |
| | `arjun@serenity.demo` | Therapist |
| Mindful Care (Starter plan) | `owner@mindfulcare.demo` | Business owner |

The platform super-admin console is at `/admin/login`. The seed creates the admin from `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`, falling back to `admin@rkyves.com` / `Admin@12345` - always set both before seeding a real environment. In development the customer app shows the OTP on screen; try phone `+91 98450 10036` against `serenity-wellness`.

## Configuration

The API validates its environment at start-up (`apps/api/src/config/env.ts`) and refuses to boot on invalid configuration.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `PORT` | `4000` | API port |
| `APP_URL` / `API_URL` | `http://localhost:3000` / `:4000` | Public URLs used in links, emails and CORS |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed browser origins |
| `DATABASE_URL` | - (required) | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6380` | Redis for queues, rate limits and caching |
| `JWT_ACCESS_SECRET` | - (required) | Access-token signing secret (min 16 chars, 32 in production) |
| `JWT_ACCESS_TTL_SECONDS` / `REFRESH_TOKEN_TTL_DAYS` | `900` / `30` | Token lifetimes |
| `RUN_WORKER_IN_API` | `false` | Run BullMQ workers inside the API process |
| `STORAGE_DRIVER`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE` | `local` | File storage (invoices, exports, logos) |
| `EMAIL_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | `mock` | Email delivery |
| `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID` | `mock` | SMS delivery (`msg91`, `twilio`) |
| `WHATSAPP_PROVIDER`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | `mock` | WhatsApp Cloud API (outbound messages) |
| `PAYMENT_PROVIDER`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_MAP` | `mock` | Payments and SaaS subscriptions |
| `SUBSCRIPTION_GRACE_DAYS` | `7` | Days a lapsed subscription keeps working |
| `GOOGLE_CLIENT_ID` | - | Enables Google sign-in |
| `LLM_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_MODEL` | `mock` | AI business assistant |
| `LOG_LEVEL` | `info` | Pino log level |
| `SENTRY_DSN` | - | Error reporting |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OpenTelemetry tracing (install the optional `@opentelemetry/*` packages) |
| `API_DOCS_ENABLED` | `false` | Serve Swagger UI at `/api/docs` in production (always on in development) |
| `METRICS_TOKEN` | - | If set, `/metrics` requires `Authorization: Bearer <token>` |
| `TRUST_PROXY` | `1` | Reverse-proxy hops in front of the API |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | - | Seeds the first super-admin |
| `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD` | `admin` / - | Queue dashboard credentials (disabled in production without a password) |

The web app reads `API_URL` (where `/api/v1` is proxied; baked in at build time), `APP_URL`, `PLATFORM_HOSTS` (host names that are not tenant subdomains) and optionally `NEXT_PUBLIC_WS_URL`.

## Testing

| Suite | Command | Needs |
| --- | --- | --- |
| API unit tests | `pnpm --filter @therapyos/api test:unit` | nothing |
| API integration tests (RBAC, tenant isolation, customer portal, security controls) | `pnpm --filter @therapyos/api test:integration` | Postgres + Redis. Runs against `<DATABASE_URL database>_test` (created by the Docker init script), applies migrations and seeds it on first run |
| Web end-to-end (Playwright) | `pnpm test:e2e` | API and web running on :4000 / :3000 with seeded demo data |
| Mobile | `cd apps/mobile && flutter analyze && flutter test` | Flutter SDK |
| Lint / types | `pnpm lint` / `pnpm typecheck` | nothing |

CI (`.github/workflows/ci.yml`) runs lint, type-check, unit + integration tests and the build, then the Playwright suite against a seeded stack, then builds and scans both Docker images with Trivy.

## Deployment

Production images are built from the repository root:

```bash
docker build -f infrastructure/docker/api.Dockerfile -t therapyos-api .                       # API; run `node dist/worker.js` for the worker
docker build -f infrastructure/docker/api.Dockerfile --target migrate -t therapyos-migrate .  # one-off `prisma migrate deploy`
docker build -f infrastructure/docker/web.Dockerfile --build-arg API_URL=http://api:4000 -t therapyos-web .
```

To try the whole stack in containers locally:

```bash
docker compose -f infrastructure/docker/docker-compose.yml --profile app up -d --build
```

See [docs/operations.md](docs/operations.md) for the production topology, migrations, backups, monitoring and runbooks, and [docs/security.md](docs/security.md) for the security controls and the pre-production checklist.

## Implementation notes

- Request validation uses the shared Zod schemas in `packages/validation` (through a `Zod(...)` Nest pipe) rather than class-validator DTO classes, so the API and the web forms enforce exactly the same rules. The Swagger document at `/api/docs` is built from controller metadata (routes, tags, auth), not from these schemas.
- Database changes are additive Prisma migrations (`apps/api/prisma/schema/migrations`); never edit an applied migration.
