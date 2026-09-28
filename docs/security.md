# Security

This document maps the controls built into TherapyOS to the pre-production checklist in section 95 of the architecture specification, and lists what the operator of each environment still has to provide.

Legend: **Built** = implemented and covered by automated tests; **Operator** = deployment responsibility, with the product support described.

## Checklist status

| Item | Status | How |
| --- | --- | --- |
| HTTPS | Operator | Terminate TLS at the load balancer or ingress. Helmet sends `Strict-Transport-Security`, the refresh cookie is `Secure` in production, and `TRUST_PROXY` makes the API use the real client IP for rate limits and audit logs. |
| Secrets manager | Operator | All secrets come from environment variables validated at boot (`apps/api/src/config/env.ts`). Inject them from AWS Secrets Manager, GCP Secret Manager, Vault or Kubernetes secrets. `.dockerignore` keeps `.env` files out of images. Production refuses a JWT secret shorter than 32 characters. |
| Database encryption | Operator + Built | Use a managed PostgreSQL with encryption at rest and `sslmode=require` in `DATABASE_URL`. In the application, passwords are hashed with Argon2id, and refresh tokens and API keys are stored only as SHA-256 hashes. The raw API key is shown once, at creation. |
| Tenant isolation tests | Built | A Prisma extension adds `tenantId` to every query on tenant-owned models. `apps/api/test/tenant-isolation.e2e-spec.ts` proves over HTTP that another business cannot read, update, delete, search, book into or open the queue of foreign records. It also checks that customer-app tokens see only their own invoices and appointments, and that API keys are confined to their business, scopes and revocation. |
| RBAC tests | Built | `apps/api/test/rbac.e2e-spec.ts` covers denied and allowed actions for owner, HQ, branch manager, area manager, receptionist, therapist and accountant. It also covers branch scoping, missing, malformed and tampered tokens, and separation between staff, customer and platform-admin tokens. `src/common/rbac-matrix.spec.ts` checks the role templates themselves. |
| Rate limiting | Built | A Redis-backed throttler shared by all API instances allows 300 requests/min per client by default. Stricter per-route limits apply to staff and customer login and OTP verification (10/min), registration, OTP sending, platform-admin login and public booking (5/min), token refresh (30/min), guest feedback and the AI assistant (20/min). Tested in `security.e2e-spec.ts`. |
| Input validation | Built | Every body and query is parsed by a shared Zod schema (`packages/validation`). Unknown fields are stripped, and failures return `400 VALIDATION_FAILED` with field details. |
| SQL injection protection | Built | All queries go through Prisma with bound parameters. Raw SQL uses tagged templates only, with column names coming from code constants. Search text is matched literally, because `%`, `_` and `\` are escaped centrally in the Prisma extension. Tested with injection-style search strings. |
| XSS protection | Built | The API returns JSON only. React escapes all rendered values, and user-generated HTML is never rendered. Invoice and report PDFs are generated server-side with PDFKit. CSV and Excel exports neutralise spreadsheet formulas (`=`, `+`, `-`, `@`) to prevent formula injection. |
| Secure cookies/tokens | Built | Access tokens last 15 minutes and are held in memory. Refresh tokens are rotated on every use. Reusing one revokes the whole token family (`TOKEN_REUSED`). The web refresh cookie is `HttpOnly`, `SameSite=Lax` and `Secure` in production. The mobile apps keep tokens in the platform keystore. Staff, customer, signup and platform-admin tokens have distinct audiences and cannot be used interchangeably. |
| Webhook verification | Built | Razorpay payment and subscription webhooks are verified with HMAC-SHA256 over the raw body using a constant-time comparison. Unsigned or forged events get `400 WEBHOOK_SIGNATURE_INVALID`. Capturing a payment is idempotent: it runs under a per-invoice lock and is applied exactly once, whether the client callback or the webhook arrives first. |
| Audit logging | Built | Sensitive changes are written to `audit_logs` with user, tenant, IP, user agent, old and new values. These include customer changes, invoices and voids, refunds, price overrides, settings, roles, users, API keys, subscriptions, exports and platform-admin actions. Owners and HQ can browse them at `/audit-logs`. |
| Backup | Operator + Built | Enable automated snapshots and point-in-time recovery on the managed database. `infrastructure/scripts/backup.sh` adds portable logical dumps with checksum, archive verification, retention and optional S3 upload. |
| Restore test | Built | `infrastructure/scripts/restore-test.sh` restores a dump into a throwaway database, compares row counts of key tables with the source, and drops it. Run it on a schedule (see [operations](operations.md#backups-and-restore)). |
| Dependency scanning | Built | CI runs `pnpm audit --audit-level high`. Enable Dependabot or Renovate on the repository for update PRs. |
| Container scanning | Built | CI builds both production images and fails on unfixed critical or high vulnerabilities (Trivy). Images run as the unprivileged `node` user on Alpine, with `tini` as PID 1. |
| Production access control | Operator + Built | Platform-admin accounts are separate from tenant users, live on a separate console and have their actions audited. In production, Swagger UI is off unless `API_DOCS_ENABLED=true` (publish the spec from `pnpm --filter @therapyos/api openapi:export` instead). The queue dashboard is off unless `BULL_BOARD_PASSWORD` is set, and `/metrics` can require `METRICS_TOKEN`. Restrict database and Redis to the private network and grant cloud-console access through SSO with MFA. |

## Further controls

- **CSRF.** API calls authenticate with a bearer header, not cookies. The only cookie-authenticated endpoint, token refresh, is a `POST` protected by `SameSite=Lax`.
- **CORS.** Only origins in `CORS_ORIGINS` are allowed; any localhost origin is accepted only outside production. The web app calls the API through its own `/api/v1` proxy, so browsers never need cross-origin access in the standard setup.
- **Security headers.** Helmet is enabled on the API, and the web app sets `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy`. `X-Powered-By` is removed from both.
- **Data minimisation.** Roles without `customer.contact.view` see masked phone numbers and emails. Customers can be anonymised on request, which is audited. Marketing and WhatsApp consent changes are recorded with their source.
- **Error handling.** Errors never expose stack traces or SQL. Unexpected errors are reported to Sentry, and every response carries a request ID (from `X-Request-Id` or generated). The same ID appears in logs and audit entries.
- **Audit redaction.** Values whose keys look like passwords, tokens, secrets, hashes or OTPs are replaced with `[REDACTED]` before they are stored in the audit log.
- **Uploads.** Uploads are limited to 5 MB and stored under tenant-prefixed, random keys. Only image types are accepted for files that are publicly viewable (logos, branding, product images, avatars), and only those purposes can be downloaded without authentication. SVGs are served with a restrictive Content-Security-Policy so embedded scripts cannot run.

## Reporting a vulnerability

Email security@rkyves.com with steps to reproduce. Please do not open a public issue.
