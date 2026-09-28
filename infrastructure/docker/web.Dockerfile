# syntax=docker/dockerfile:1.7
# Build from the repository root:
#   docker build -f infrastructure/docker/web.Dockerfile --build-arg API_URL=http://api:4000 -t therapyos-web .
# API_URL is baked in at build time (Next.js resolves the /api/v1 rewrite during `next build`).

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat && corepack enable
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo

FROM base AS build
ARG API_URL=http://api:4000
ARG NEXT_PUBLIC_WS_URL
ENV API_URL=$API_URL NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL NEXT_OUTPUT=standalone
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@therapyos/web..."
RUN pnpm --filter "@therapyos/web..." run build && mkdir -p apps/web/public

FROM base AS runtime
ARG API_URL=http://api:4000
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 API_URL=$API_URL
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
