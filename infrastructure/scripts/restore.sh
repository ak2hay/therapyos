#!/bin/sh
# Restores a backup produced by backup.sh into the database in DATABASE_URL, replacing its contents.
#
#   DATABASE_URL=postgresql://user:pass@host:5432/therapyos_staging RESTORE_CONFIRM=therapyos_staging \
#     ./restore.sh backups/therapyos-20260101T000000Z.dump
#
# RESTORE_CONFIRM must equal the target database name - a guard against restoring over the wrong database.
set -eu

FILE="${1:?usage: restore.sh <dump-file>}"
: "${DATABASE_URL:?DATABASE_URL is required}"
URL="${DATABASE_URL%%\?*}"
DB_NAME="${URL##*/}"

if [ "${RESTORE_CONFIRM:-}" != "$DB_NAME" ]; then
  echo "Refusing to restore: set RESTORE_CONFIRM=$DB_NAME to overwrite database '$DB_NAME'." >&2
  exit 2
fi

if [ -f "$FILE.sha256" ]; then
  (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" > /dev/null)
else
  echo "Warning: no checksum file next to $FILE; skipping integrity check." >&2
fi

pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error --dbname="$URL" "$FILE"
echo "Restored $FILE into $DB_NAME"
