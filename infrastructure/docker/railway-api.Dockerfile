# Single-stage API image for Railway (demo / small deployments).
# Railway rejects BuildKit cache mounts without its own id prefix, and the slim runtime stage of
# api.Dockerfile has no Prisma CLI, so this image keeps dev dependencies and applies migrations on start.
# Select it in Railway with the service variable RAILWAY_DOCKERFILE_PATH=infrastructure/docker/railway-api.Dockerfile

FROM node:22-alpine
RUN apk add --no-cache openssl libc6-compat tini \
 && corepack enable
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter "@therapyos/api..."
RUN pnpm --filter "@therapyos/api..." run build

WORKDIR /repo/apps/api
RUN mkdir -p uploads
ENV NODE_ENV=development PORT=4000
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
