#!/bin/sh
# Logical PostgreSQL backup (pg_dump custom format) with checksum, archive verification and retention.
#
#   DATABASE_URL=postgresql://user:pass@host:5432/therapyos ./backup.sh [output-dir]
#
# Optional env:
#   BACKUP_DIR              default output directory (default ./backups)
#   BACKUP_RETENTION_DAYS   delete local dumps older than this (default 14)
#   BACKUP_S3_URI           e.g. s3://my-bucket/therapyos/ - uploads dump + checksum with the AWS CLI
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
OUT_DIR="${1:-${BACKUP_DIR:-./backups}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
# libpq rejects Prisma-only query parameters such as ?schema=public
URL="${DATABASE_URL%%\?*}"

mkdir -p "$OUT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$OUT_DIR/therapyos-$STAMP.dump"

pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$FILE.partial" "$URL"
mv "$FILE.partial" "$FILE"
pg_restore --list "$FILE" > /dev/null
(cd "$OUT_DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256")

if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp "$FILE" "$BACKUP_S3_URI" --only-show-errors
  aws s3 cp "$FILE.sha256" "$BACKUP_S3_URI" --only-show-errors
fi

find "$OUT_DIR" -maxdepth 1 -name 'therapyos-*.dump*' -mtime +"$RETENTION_DAYS" -exec rm -f {} +

echo "$FILE"
