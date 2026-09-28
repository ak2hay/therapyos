#!/bin/sh
# Proves a backup is restorable: restores it into a throwaway database on the same server, compares row
# counts of key tables with the source, then drops the throwaway database. Never touches the source.
#
#   DATABASE_URL=postgresql://user:pass@host:5432/therapyos ./restore-test.sh [dump-file]
#
# Without a dump file it takes a fresh backup first (via backup.sh). The role needs CREATEDB.
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
HERE=$(cd "$(dirname "$0")" && pwd)
URL="${DATABASE_URL%%\?*}"
SERVER="${URL%/*}"
SCRATCH="therapyos_restore_check_$(date -u +%Y%m%d%H%M%S)"
FILE="${1:-}"

if [ -z "$FILE" ]; then
  FILE=$("$HERE/backup.sh" "${TMPDIR:-/tmp}/therapyos-restore-test")
fi

cleanup() { psql "$SERVER/postgres" -qc "DROP DATABASE IF EXISTS \"$SCRATCH\"" > /dev/null; }
trap cleanup EXIT

psql "$SERVER/postgres" -qc "CREATE DATABASE \"$SCRATCH\"" > /dev/null
DATABASE_URL="$SERVER/$SCRATCH" RESTORE_CONFIRM="$SCRATCH" "$HERE/restore.sh" "$FILE" > /dev/null

COUNTS="select 'tenants', count(*) from tenants
  union all select 'customers', count(*) from customers
  union all select 'appointments', count(*) from appointments
  union all select 'invoices', count(*) from invoices
  union all select 'payments', count(*) from payments
  union all select 'audit_logs', count(*) from audit_logs
  union all select 'migrations', count(*) from _prisma_migrations order by 1"

SOURCE=$(psql "$URL" -Atc "$COUNTS")
RESTORED=$(psql "$SERVER/$SCRATCH" -Atc "$COUNTS")

echo "$RESTORED" | sed 's/|/: /'
if [ "$SOURCE" != "$RESTORED" ]; then
  echo "Row counts differ between source and restored copy (expected if writes happened after the dump):" >&2
  echo "$SOURCE" >&2
  exit 1
fi
echo "Restore test passed: $FILE restored into $SCRATCH and matched the source."
