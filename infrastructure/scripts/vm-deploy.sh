#!/usr/bin/env bash
# Deploys the API + worker on a shared VM from a source tarball.
# Usage (as root on the VM): vm-deploy.sh /tmp/therapyos-src.tgz
# Env overrides: PUBLIC_API_URL, APP_URL, CORS_ORIGINS (only used when .env is first created).
set -euo pipefail

TARBALL=${1:?usage: vm-deploy.sh <source tarball>}
ROOT=/opt/therapyos
PUBLIC_API_URL=${PUBLIC_API_URL:-https://therapyos-api.95-135-254-46.sslip.io}

mkdir -p "$ROOT"
cd "$ROOT"

rm -rf src.new
mkdir src.new
tar -xzf "$TARBALL" -C src.new
rm -rf src.old
[ -d src ] && mv src src.old
mv src.new src
cp src/infrastructure/docker/docker-compose.vm.yml docker-compose.yml

if [ ! -f .env ]; then
  rnd() { openssl rand -hex "$1"; }
  PG_PASS=$(rnd 16)
  cat > .env <<EOF
NODE_ENV=development
PORT=4000
API_HOST_PORT=4100
APP_URL=${APP_URL:-$PUBLIC_API_URL}
API_URL=$PUBLIC_API_URL
CORS_ORIGINS=${CORS_ORIGINS:-$PUBLIC_API_URL}
TRUST_PROXY=1

POSTGRES_PASSWORD=$PG_PASS
DATABASE_URL=postgresql://therapyos:$PG_PASS@postgres:5432/therapyos?schema=public&connection_limit=10
REDIS_URL=redis://redis:6379

JWT_ACCESS_SECRET=$(rnd 32)
JWT_ACCESS_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
RUN_WORKER_IN_API=false

STORAGE_DRIVER=local
EMAIL_PROVIDER=mock
SMS_PROVIDER=mock
WHATSAPP_PROVIDER=mock
PAYMENT_PROVIDER=mock
LLM_PROVIDER=mock
LOG_LEVEL=info

API_DOCS_ENABLED=true
METRICS_TOKEN=$(rnd 16)
BULL_BOARD_USER=admin
BULL_BOARD_PASSWORD=$(rnd 8)

PLATFORM_ADMIN_EMAIL=admin@rkyves.com
PLATFORM_ADMIN_PASSWORD=Rk-$(rnd 6)
EOF
  chmod 600 .env
  echo "Created $ROOT/.env with generated secrets"
fi

# Integration secrets saved from the admin console are encrypted with this key. Losing or changing it
# makes every saved key unreadable, so it is generated once and backed up outside the app directory.
if ! grep -q '^SETTINGS_ENCRYPTION_KEY=' .env; then
  printf '\nSETTINGS_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
  echo "Added SETTINGS_ENCRYPTION_KEY to $ROOT/.env"
fi
KEY_BACKUP=/root/.therapyos-settings-encryption-key
if [ ! -f "$KEY_BACKUP" ]; then
  grep '^SETTINGS_ENCRYPTION_KEY=' .env > "$KEY_BACKUP"
  chmod 400 "$KEY_BACKUP"
  echo "Backed up the encryption key to $KEY_BACKUP"
fi

docker compose build migrate
docker compose up -d --remove-orphans

echo "Waiting for API health..."
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:4100/health >/dev/null 2>&1; then echo "API healthy"; break; fi
  sleep 3
done
curl -fsS http://127.0.0.1:4100/health || { docker compose logs --tail 80 api; exit 1; }
echo

if [ ! -f .seeded ]; then
  echo "Seeding platform + demo data..."
  docker compose run --rm --no-deps -e DISABLE_WORKERS=true api node dist/seed/seed.js
  touch .seeded
fi

rm -rf src.old
docker compose ps
