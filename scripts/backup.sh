#!/usr/bin/env bash
# RukwaRide database backup / off-site sync / restore-drill.
#
# The prod compose already runs a `backup` container (nightly pg_dump, 30-day
# retention) into a local volume. This script adds the two things a local dump
# alone does not give you: an OFF-SITE copy, and PROOF that a dump actually
# restores (a backup you have never restored is not a backup).
#
#   scripts/backup.sh dump             # pg_dump | gzip -> $BACKUP_DIR, prune, optional off-site
#   scripts/backup.sh verify           # restore the latest dump into a scratch DB and diff row counts
#   scripts/backup.sh restore <file> [<target_db>]   # restore a dump into a (scratch) DB
#   scripts/backup.sh list             # list local dumps
#
# Config (env, with dev-friendly defaults):
#   PG_CONTAINER   docker container running postgres      (default: rukwaride-postgres)
#   PG_USER        postgres role                          (default: rukwaride)
#   PG_DB          database name                          (default: rukwaride)
#   BACKUP_DIR     where dumps are written                (default: ./backups)
#   RETENTION_DAYS prune dumps older than N days          (default: 30)
#   RCLONE_REMOTE  rclone target for off-site sync, e.g.  remote:rukwaride-backups (default: unset -> skipped)
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-rukwaride-postgres}"
PG_USER="${PG_USER:-rukwaride}"
PG_DB="${PG_DB:-rukwaride}"
BACKUP_DIR="${BACKUP_DIR:-$(cd "$(dirname "$0")/.." && pwd)/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

psql_in()   { docker exec -i  "$PG_CONTAINER" psql   -U "$PG_USER" "$@"; }
dump_out()  { docker exec     "$PG_CONTAINER" pg_dump -U "$PG_USER" "$PG_DB"; }

require_container() {
  docker exec "$PG_CONTAINER" true 2>/dev/null ||
    { echo "ERROR: postgres container '$PG_CONTAINER' not running (set PG_CONTAINER)"; exit 1; }
}

cmd_dump() {
  require_container
  mkdir -p "$BACKUP_DIR/daily"
  local f="$BACKUP_DIR/daily/${PG_DB}-$(date -u +%Y%m%d-%H%M%S).sql.gz"
  echo "==> dumping $PG_DB from $PG_CONTAINER -> $f"
  dump_out | gzip > "$f"
  # Fail loudly on an empty/short dump rather than silently "succeeding".
  local sz; sz=$(stat -c %s "$f")
  [ "$sz" -gt 1000 ] || { echo "ERROR: dump looks truncated ($sz bytes)"; exit 1; }
  echo "    wrote $(du -h "$f" | cut -f1)"

  echo "==> pruning dumps older than ${RETENTION_DAYS}d"
  find "$BACKUP_DIR/daily" -name "${PG_DB}-*.sql.gz" -mtime "+${RETENTION_DAYS}" -print -delete || true

  if [ -n "$RCLONE_REMOTE" ]; then
    command -v rclone >/dev/null || { echo "ERROR: RCLONE_REMOTE set but rclone not installed"; exit 1; }
    echo "==> off-site sync -> $RCLONE_REMOTE"
    rclone sync "$BACKUP_DIR/daily" "$RCLONE_REMOTE" --immutable
  else
    echo "    (RCLONE_REMOTE unset — off-site sync skipped; set it in the backup cron for real DR)"
  fi
  echo "$f"
}

latest_dump() { ls -1t "$BACKUP_DIR"/daily/"${PG_DB}"-*.sql.gz 2>/dev/null | head -1; }

cmd_restore() {
  require_container
  local file="${1:?usage: restore <file.sql.gz> [target_db]}"
  local target="${2:-${PG_DB}_restore_test}"
  [ -f "$file" ] || { echo "ERROR: no such dump: $file"; exit 1; }
  [ "$target" = "$PG_DB" ] && { echo "REFUSING to restore over the live DB '$PG_DB' — pick a scratch name"; exit 1; }

  echo "==> (re)creating scratch DB '$target'"
  psql_in -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$target\";" -c "CREATE DATABASE \"$target\";" >/dev/null
  echo "==> restoring $file -> $target"
  gunzip -c "$file" | psql_in -d "$target" -v ON_ERROR_STOP=1 -q >/dev/null
  echo "    restored."
}

# Restore the latest dump into a scratch DB and compare row counts of key tables
# against the live DB. Non-destructive to the live DB; drops the scratch DB after.
cmd_verify() {
  require_container
  local file; file="$(latest_dump)"
  [ -n "$file" ] || { echo "ERROR: no dumps in $BACKUP_DIR/daily — run 'dump' first"; exit 1; }
  local target="${PG_DB}_restore_test"
  cmd_restore "$file" "$target"

  echo "==> row-count parity (live vs restored)"
  local tables=(User DriverProfile Vehicle Trip Landmark FareConfig NotificationTemplate LedgerEntry)
  local ok=1
  for t in "${tables[@]}"; do
    local live rest
    live=$(psql_in -d "$PG_DB"  -t -A -c "SELECT count(*) FROM \"$t\";")
    rest=$(psql_in -d "$target" -t -A -c "SELECT count(*) FROM \"$t\";")
    if [ "$live" = "$rest" ]; then printf "    %-22s %6s  == %-6s  OK\n" "$t" "$live" "$rest"
    else                          printf "    %-22s %6s  != %-6s  MISMATCH\n" "$t" "$live" "$rest"; ok=0; fi
  done

  echo "==> dropping scratch DB '$target'"
  psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$target\";" >/dev/null
  [ "$ok" = 1 ] && echo "RESULT: restore drill PASSED — backup is restorable." \
                || { echo "RESULT: restore drill FAILED — counts diverged."; exit 1; }
}

cmd_list() { ls -lh "$BACKUP_DIR"/daily/"${PG_DB}"-*.sql.gz 2>/dev/null || echo "(no dumps in $BACKUP_DIR/daily)"; }

case "${1:-}" in
  dump)    cmd_dump ;;
  verify)  cmd_verify ;;
  restore) shift; cmd_restore "$@" ;;
  list)    cmd_list ;;
  *) echo "usage: $0 {dump|verify|restore <file> [db]|list}"; exit 2 ;;
esac
