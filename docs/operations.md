# Operations

How to deploy, run, monitor and recover TherapyOS in production. For local development see the [README](../README.md).

## Production topology

```text
                ┌──────────── HTTPS load balancer / ingress ────────────┐
                │  app.example.com, *.example.com (tenant subdomains)   │
                └───────────────┬───────────────────────┬───────────────┘
                                │                       │
                      web (Next.js, N)            api (NestJS, N)  ◄── /api/v1, /realtime (WebSocket)
                   proxies /api/v1 to api                │
                                                         ├── PostgreSQL 17 (managed, PITR)
                      worker (BullMQ, 1+) ───────────────┼── Redis 7 (queues, rate limits, pub/sub)
                                                         └── S3-compatible object storage
```

| Component | Image / command | Scaling |
| --- | --- | --- |
| `api` | `therapyos-api`, `node dist/main.js` | Stateless; scale horizontally. Realtime events fan out between instances over Redis pub/sub. If Socket.IO clients may fall back to HTTP long-polling, enable sticky sessions on the load balancer. |
| `worker` | `therapyos-api`, `node dist/worker.js` | Runs outbox dispatch, notifications, reports and scheduled jobs. BullMQ distributes work safely across replicas, and repeatable jobs are registered idempotently. |
| `web` | `therapyos-web` | Stateless; scale horizontally. `API_URL` is fixed at image build time. |
| `migrate` | `therapyos-api` built with `--target migrate` | One-off job before each rollout. |

Keep `RUN_WORKER_IN_API` unset (false) in production so that request latency is isolated from background work.

## Configuration and secrets

- All API settings are environment variables, listed in the [README](../README.md#configuration) and validated at boot by `apps/api/src/config/env.ts`. A misconfigured container exits immediately with a readable list of problems instead of running half-configured.
- Store secrets in the platform's secret manager and inject them as environment variables. These include `DATABASE_URL`, `JWT_ACCESS_SECRET`, provider keys, `RAZORPAY_WEBHOOK_SECRET`, `METRICS_TOKEN` and `BULL_BOARD_PASSWORD`.
- Required in production: `NODE_ENV=production`, a JWT secret of 32+ random characters, `APP_URL`, `API_URL`, `CORS_ORIGINS` and real provider settings for every channel you use. Mock providers are for development only.
- Rotating `JWT_ACCESS_SECRET` signs everyone out within 15 minutes, once current access tokens expire. Refresh tokens are unaffected, so clients silently re-authenticate.
- Provider keys (Razorpay, MSG91, WhatsApp, SMTP, OpenAI) are usually entered in **Super admin → Integrations**, and businesses may add their own in **Settings → Integrations**. They are stored in `integration_configs`, encrypted with `SETTINGS_ENCRYPTION_KEY` (AES-256-GCM). Environment variables remain a fallback when nothing is saved.
- The **MSG91 OTP Widget** card (widget ID, widget token, server auth key, SMS/email switches) has no environment fallback. Browsers and apps read the public part from `GET /api/v1/public/otp-widget?tenant=<slug>`; the auth key never leaves the server. Whitelist the API server's IP for that auth key in MSG91, or token verification fails with `AuthenticationFailure`.
- `SETTINGS_ENCRYPTION_KEY` is required in production. Keep a copy outside the server (the VM deploy script writes one to `/root/.therapyos-settings-encryption-key`). If the key is lost or changed, saved secrets cannot be decrypted: the API logs `Cannot decrypt ... secrets`, falls back to the next credential source, and every key has to be re-entered. Database dumps alone are not enough to restore integrations without this key.

## Releases

1. CI builds and tests the commit, builds both images and scans them.
2. Run the `migrate` image against the production database (`prisma migrate deploy`). Migrations are additive, so the currently running version keeps working against the new schema.
3. Roll out `api` and `worker`, then `web`. Health checks gate traffic.
4. Watch error rate, p95 latency and queue depth for 15 minutes (see [Monitoring](#monitoring)).

**Rollback:** redeploy the previous image tags. Because migrations are additive, the previous version runs against the newer schema. Never roll a migration back by hand; ship a new forward migration instead.

**Schema change rules:** add columns as nullable or with defaults, backfill in a job, and only then tighten constraints in a later release. Rename or remove columns in two steps across two releases. Never edit a migration that has been applied anywhere.

## Health checks

| Endpoint | Use | Checks |
| --- | --- | --- |
| `GET /health/live` | Liveness probe / container `HEALTHCHECK` | Process is up and serving HTTP |
| `GET /health` | Readiness probe, uptime monitor | PostgreSQL, Redis and storage connectivity; returns 503 if any is down |
| `GET /metrics` | Prometheus scrape | See below; protect with `METRICS_TOKEN` or network policy |

Use `/health/live` for liveness so that a brief database outage does not restart every API container, and `/health` for readiness so that traffic drains from instances that lose their dependencies.

## Monitoring

**Logs.** Pino writes structured JSON to stdout. Each line carries a request ID taken from `X-Request-Id` (or generated), and the same ID is returned in every API response and stored with audit entries. Background jobs log with `job_`, `evt_`, `ntf_` or `cron_` request IDs. Ship stdout to your log platform and search by request ID when handling support tickets.

**Metrics** (Prometheus, `/metrics`):

- `therapyos_http_request_duration_seconds`: latency histogram by method, route and status. Alert when p95 exceeds 500 ms for 10 minutes (spec section 96), or when the 5xx rate exceeds 1%.
- `therapyos_jobs_total`: background jobs by queue, name and result. Alert on a sustained failure rate.
- `therapyos_notifications_total` and `therapyos_webhooks_total`: message deliveries by channel and outcome, and inbound webhooks by result. A spike in invalid webhook signatures usually means a rotated secret.
- Default Node.js process metrics: event-loop lag, heap and CPU.
- Queue depth is visible at `/admin/queues` (Bull Board; requires `BULL_BOARD_PASSWORD`). Alert if `domain-events` or `notifications` waiting counts grow for 10 minutes, which usually means the worker is down.

**Errors.** Set `SENTRY_DSN` on the API and worker. Unhandled exceptions are captured with the request context. Expected business errors (validation, permission, not found) are not reported.

**Tracing.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` and install `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node` and `@opentelemetry/exporter-trace-otlp-http` to export traces for HTTP, Prisma, Redis and BullMQ.

## Scheduled jobs

Registered automatically by the worker on the `scheduled` queue:

| Job | Schedule | Work |
| --- | --- | --- |
| `reminders` | every 15 min | Appointment reminders |
| `campaigns` | every minute | Sends campaigns whose scheduled time has passed |
| `daily-tick` | hourly at :05 | Once per tenant per day, after the configured hour in the tenant's time zone: package and membership expiry and reminders, birthday messages, retention metrics and segments, the owner's daily summary, and franchise royalties. Each step is isolated, so one failure does not block the others. |
| `subscriptions` | hourly at :15 | SaaS renewals, trial expiry, grace periods and suspension |

Owners can see queue counts and next run times, and trigger a job manually, under **Settings → Notifications**.

## Backups and restore

**Primary:** managed PostgreSQL automated snapshots with point-in-time recovery, retained for at least 14 days.

**Secondary (portable):** nightly logical dumps with `infrastructure/scripts/backup.sh`, uploaded to a separate account or bucket with object lock:

```bash
DATABASE_URL=postgresql://backup_user:***@db:5432/therapyos \
BACKUP_S3_URI=s3://therapyos-backups/prod/ BACKUP_RETENTION_DAYS=14 \
  infrastructure/scripts/backup.sh /var/backups/therapyos
```

**Restore test (weekly, automated):** `restore-test.sh` restores the latest dump into a throwaway database on a non-production server, compares row counts of key tables with the source, and drops the copy. Alert if it fails.

```bash
DATABASE_URL=postgresql://restore_user:***@staging-db:5432/therapyos infrastructure/scripts/restore-test.sh /var/backups/therapyos/therapyos-<stamp>.dump
```

**Restoring for real:**

1. Stop `worker` and scale `api` to zero (or enable maintenance mode at the load balancer).
2. Prefer point-in-time recovery into a new instance and repoint `DATABASE_URL`. Otherwise, restore a dump into an empty database:
   `DATABASE_URL=... RESTORE_CONFIRM=<database name> infrastructure/scripts/restore.sh <dump>`
   The script refuses to run unless `RESTORE_CONFIRM` matches the target database name.
3. Run the `migrate` job if the dump predates the current release.
4. Start `api`, check `/health`, then start `worker`. The outbox resumes delivering any undelivered events.

Uploaded files live in object storage. Enable bucket versioning and cross-region replication there; they are not part of database dumps.

**Targets:** RPO of 5 minutes with point-in-time recovery (24 hours from dumps alone); RTO of 1 hour.

## Runbooks

**Notifications are not being delivered.** Check `/admin/queues` for the `notifications` queue. If jobs are failing, open one to see the provider error (expired WhatsApp token, SMS DLT template mismatch, SMTP authentication). Fix the credentials; failed jobs retry with backoff, and you can retry them from Bull Board. Owners can also see per-message delivery status in the notification log under **Settings → Notifications**.

**A payment was taken but the invoice still shows due.** Check the Razorpay dashboard's webhook deliveries for `/api/v1/webhooks/razorpay`. A 400 response means the webhook secret does not match the one saved for the account that created the order: the business's own Razorpay card if it uses its own keys, otherwise the platform card (or `RAZORPAY_WEBHOOK_SECRET`). Each payment remembers which key created it, so switching accounts does not break older orders. After fixing it, redeliver the event from Razorpay. Capture is idempotent, so redelivery is safe.

**An integration stopped working after a key change.** Use *Test connection* on the card (platform or business). The **System Health** page shows which source each provider currently uses (platform, server env or mock). A business card marked "Using your own" with wrong keys affects only that business; untick "Use my own account" to fall back to the platform keys.

**Onboarding a client manually.** Super admin → Tenants → **New business**. Choose an email invitation (the owner sets a password; the link is also shown so you can share it on WhatsApp) or a temporary password, which is shown only once. If the owner loses it, use **Reset password** on the tenant page, which also signs them out everywhere. To stop self sign-up, untick it in **Platform settings**; the sign-up page then shows the support contacts instead.

**A tenant reports they cannot sign in.** In the admin console, check the tenant's status and subscription; suspended tenants are blocked. Then check the user's status on the tenant's **Staff** page. Login is rate-limited to 10 attempts per minute per client, so a shared office IP can hit the limit during onboarding.

**Queue backlog keeps growing.** Confirm the worker is running and connected to the same Redis (`REDIS_URL`). Then scale worker replicas. Campaign delivery progress is visible on each campaign's page.

**Database connections are exhausted.** Each API or worker replica opens a Prisma pool (default `num_cpus * 2 + 1`). Set `connection_limit` in `DATABASE_URL`, or put PgBouncer in transaction mode in front of PostgreSQL once replicas × pool size approaches the database's `max_connections`.

**Suspected token theft.** Refresh-token reuse already revokes the affected session family automatically. To force sign-out, disable the user (staff) or block the customer. Platform admins can suspend a whole tenant. For a platform-wide incident, rotate `JWT_ACCESS_SECRET` and revoke all refresh tokens:
`UPDATE refresh_tokens SET "revokedAt" = now() WHERE "revokedAt" IS NULL;`
