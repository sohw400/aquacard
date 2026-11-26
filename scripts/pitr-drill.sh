#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

# This drill borrows only the pinned image from Compose. Each run creates fresh
# data directories, loopback ports and a private volume for the base backup and WAL.
pg_image=$(docker compose --env-file /dev/null -f compose.yaml config --images postgres)
scratch=$(mktemp -d)
cidfile="$scratch/cluster.id"
backup_volume=
db=aqua_pitr_drill

remove_cluster() {
  if [[ -s "$cidfile" ]]; then
    docker rm --force --volumes "$(<"$cidfile")" >/dev/null || return 1
    rm -f -- "$cidfile"
  fi
}
cleanup() {
  local status=$?
  trap - EXIT
  remove_cluster || status=1
  if [[ -n "$backup_volume" ]]; then docker volume rm "$backup_volume" >/dev/null || status=1; fi
  rmdir -- "$scratch" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

export NODE_ENV=test DATABASE_SCHEMA=aqua
export DATABASE_RUNTIME_ROLE=aqua_app DATABASE_INGRESS_ROLE=aqua_ingress DATABASE_WORKER_ROLE=aqua_worker
export DATABASE_DISPATCHER_ROLE=aqua_dispatcher DATABASE_OPERATIONS_ROLE=aqua_operations
export DATABASE_AUTH_MAIL_ROLE=aqua_auth_mail DATABASE_MONITOR_ROLE=aqua_monitor
unset DATABASE_CA_FILE DATABASE_POOL_SIZE
admin_password=$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")
backup_volume=$(docker volume create --label aqua.purpose=pitr-drill)

sql() {
  docker exec "$cluster" psql -XAt -v ON_ERROR_STOP=1 -U aqua -d "$db" -c "$1"
}
wait_for_primary() {
  local attempt
  for ((attempt=0; attempt<90; attempt++)); do
    if docker exec "$cluster" pg_isready -q -h 127.0.0.1 -U aqua -d "$db" \
      && [[ $(sql 'SELECT NOT pg_is_in_recovery()' 2>/dev/null) == t ]]; then return 0; fi
    [[ $(docker inspect --format '{{.State.Running}}' "$cluster") == true ]] || break
    sleep 1
  done
  docker logs --tail 25 "$cluster" >&2
  echo 'The disposable PostgreSQL instance exited or did not become a writable primary within 90 seconds.' >&2
  return 1
}
use_cluster() {
  local address binding
  cluster=$(<"$cidfile")
  binding=$(docker port "$cluster" 5432/tcp)
  [[ "$binding" =~ ^127\.0\.0\.1:[0-9]+$ ]] || { echo 'Expected a private drill port.' >&2; return 1; }
  address="$binding/$db"
  export DATABASE_URL="postgresql://aqua_app:aqua_app_local_only@$address"
  export INGRESS_DATABASE_URL="postgresql://aqua_ingress:aqua_ingress_local_only@$address"
  export WORKER_DATABASE_URL="postgresql://aqua_worker:aqua_worker_local_only@$address"
  export DISPATCHER_DATABASE_URL="postgresql://aqua_dispatcher:aqua_dispatcher_local_only@$address"
  export OPERATIONS_DATABASE_URL="postgresql://aqua_operations:aqua_operations_local_only@$address"
  export AUTH_MAIL_DATABASE_URL="postgresql://aqua_auth_mail:aqua_auth_mail_local_only@$address"
  export MONITOR_DATABASE_URL="postgresql://aqua_monitor:aqua_monitor_local_only@$address"
  export MIGRATION_DATABASE_URL="postgresql://aqua:$admin_password@$address"
  wait_for_primary
}
fixture() { node --import tsx scripts/pitr-fixture.ts "$1"; }
monotonic_ms() { node -p 'Number(process.hrtime.bigint()/1000000n)'; }

common=(--detach --cidfile "$cidfile" --tmpfs /var/lib/postgresql --publish 127.0.0.1::5432)
# Publish each completed segment atomically. A retry accepts an existing segment
# only when it contains the same bytes.
archive_command='if test -f /pitr/wal/%f; then cmp -s %p /pitr/wal/%f; else cp %p /pitr/wal/%f.partial && mv /pitr/wal/%f.partial /pitr/wal/%f; fi'
POSTGRES_PASSWORD="$admin_password" docker run "${common[@]}" --env POSTGRES_PASSWORD --env POSTGRES_USER=aqua \
  --env "POSTGRES_DB=$db" --mount "type=volume,src=$backup_volume,dst=/pitr" \
  --entrypoint bash "$pg_image" -ec '
    install -d -o postgres -g postgres -m 0700 /pitr/base /pitr/wal
    exec docker-entrypoint.sh "$@"
  ' -- postgres -c archive_mode=on -c "archive_command=$archive_command" >/dev/null
use_cluster
docker exec -i "$cluster" psql -X -v ON_ERROR_STOP=1 -U aqua -d "$db" < docker/postgres-init.sql >/dev/null
node --import tsx server/migrate.ts
fixture seed

# WAL is intentionally excluded from the base copy. pg_verifybackup independently
# validates the manifest checksums and the WAL needed to make that copy consistent.
docker exec --user postgres "$cluster" pg_basebackup -U aqua --pgdata=/pitr/base \
  --wal-method=none --checkpoint=fast --manifest-checksums=SHA256
docker exec --user postgres "$cluster" pg_verifybackup --exit-on-error --wal-directory=/pitr/wal /pitr/base

fixture before
target_time=$(sql "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US\"+00\"')")
fixture after
# Require the archived segment containing the later committed write, so omitting
# that write on the restored database actually demonstrates a cut at the target.
segment=$(sql 'SELECT pg_walfile_name(pg_current_wal_flush_lsn())')
[[ "$segment" =~ ^[0-9A-F]{24}$ ]] || { echo 'Unexpected WAL segment name.' >&2; exit 1; }
source_system=$(sql 'SELECT system_identifier FROM pg_control_system()')
sql 'SELECT pg_switch_wal()' >/dev/null
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec --user postgres "$cluster" test -s "/pitr/wal/$segment"; then break; fi
  sleep 1
done
docker exec --user postgres "$cluster" test -s "/pitr/wal/$segment"
remove_cluster

started=$(monotonic_ms)
docker run "${common[@]}" --mount "type=volume,src=$backup_volume,dst=/pitr,readonly" \
  --entrypoint bash "$pg_image" -ec '
    install -d -o postgres -g postgres -m 0700 "$PGDATA"
    cp -a /pitr/base/. "$PGDATA/"
    install -o postgres -g postgres -m 0600 /dev/null "$PGDATA/recovery.signal"
    exec docker-entrypoint.sh "$@"
  ' -- postgres -c 'restore_command=cp /pitr/wal/%f %p' -c "recovery_target_time=$target_time" \
    -c recovery_target_timeline=current -c recovery_target_action=promote >/dev/null
use_cluster
ready=$(monotonic_ms)
[[ $(sql 'SELECT system_identifier FROM pg_control_system()') == "$source_system" ]] || { echo 'Physical cluster identity mismatch.' >&2; exit 1; }
recovered_timeline=$(sql 'SELECT left(pg_walfile_name(pg_current_wal_lsn()), 8)')
[[ "$recovered_timeline" != "${segment:0:8}" ]] || { echo 'Recovery did not promote onto a new timeline.' >&2; exit 1; }
unset MIGRATION_DATABASE_URL
fixture verify
completed=$(monotonic_ms)
printf 'Local PostgreSQL PITR to %s: writable primary in %d ms; ledger and resumed transaction verified in %d ms from restore start.\n' \
  "$target_time" "$((ready-started))" "$((completed-started))"
