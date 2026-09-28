# syntax=docker/dockerfile:1.7
# Build from the repository root:
#   docker build -f infrastructure/docker/api.Dockerfile -t therapyos-api .
# Targets: `runtime` (default, API or worker) and `migrate` (one-off `prisma migrate deploy` / seed job).

FROM node:22-alpine AS base
RUN apk add --no-cache openssl libc6-compat tini \
 && corepack enable
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@therapyos/api..."
RUN pnpm --filter "@therapyos/api..." run build

FROM build AS migrate
WORKDIR /repo/apps/api
CMD ["npx", "prisma", "migrate", "deploy"]

FROM build AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter "@therapyos/api..." \
 && pnpm --filter @therapyos/api exec node -e "require('@prisma/client')"

FROM base AS runtime
ENV NODE_ENV=production PORT=4000
COPY --from=prod-deps --chown=node:node /repo /repo
RUN install -d -o node -g node /repo/apps/api/uploads
WORKDIR /repo/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Run the background worker from the same image with: command ["node", "dist/worker.js"]
CMD ["node", "dist/main.js"]
