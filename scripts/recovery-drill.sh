#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

# Only the PostgreSQL image is taken from Compose. Never connect to its service or volume.
pg_image=$(docker compose --env-file /dev/null -f compose.yaml config --images postgres)
scratch=$(mktemp -d)
cidfile="$scratch/container.id"
archive="$scratch/aqua.dump"

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
  rm -f -- "$archive" "$scratch/monitor-ca.pem" "$scratch/untrusted-ca.pem"
  rmdir -- "$scratch" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

export NODE_ENV=test DATABASE_SCHEMA=aqua
export DATABASE_SETTLEMENT_ROLE=aqua_settlement
export DATABASE_FUNDING_ROLE=aqua_funding
export DATABASE_CORRECTION_ROLE=aqua_correction
export DATABASE_ISSUANCE_ROLE=aqua_issuance
export DATABASE_AUTHORIZATION_SIMULATOR_ROLE=aqua_authorizer
export DATABASE_AUTH_MAIL_FEEDBACK_ROLE=aqua_feedback
export DATABASE_SETTLEMENT_CASE_ROLES=aqua_case_analyst,aqua_case_reviewer
export DATABASE_RUNTIME_ROLE=aqua_app DATABASE_INGRESS_ROLE=aqua_ingress DATABASE_WORKER_ROLE=aqua_worker
export DATABASE_MONITOR_ROLE=aqua_monitor
export DATABASE_DISPATCHER_ROLE=aqua_dispatcher DATABASE_OPERATIONS_ROLE=aqua_operations DATABASE_AUTH_MAIL_ROLE=aqua_auth_mail
unset DATABASE_CA_FILE DATABASE_POOL_SIZE MIGRATION_DATABASE_URL
admin_password=$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")

start_cluster() {
  local db=$1 binding address attempt
  POSTGRES_PASSWORD="$admin_password" docker run --detach --cidfile "$cidfile" \
    --tmpfs /var/lib/postgresql --publish 127.0.0.1::5432 \
    --env POSTGRES_USER=aqua --env POSTGRES_PASSWORD --env "POSTGRES_DB=$db" "$pg_image" >/dev/null
  cluster=$(<"$cidfile")
  for ((attempt=0; attempt<60; attempt++)); do
    if docker exec "$cluster" pg_isready -q -h 127.0.0.1 -U aqua -d "$db"; then break; fi
    [[ $(docker inspect --format '{{.State.Running}}' "$cluster") == true ]] || break
    sleep 1
  done
  docker exec "$cluster" pg_isready -h 127.0.0.1 -U aqua -d "$db"
  docker exec -i "$cluster" psql -X -v ON_ERROR_STOP=1 -U aqua -d "$db" < docker/postgres-init.sql >/dev/null
  binding=$(docker port "$cluster" 5432/tcp)
  [[ "$binding" =~ ^127\.0\.0\.1:[0-9]+$ ]] || { echo 'Expected a private loopback port for the recovery drill.' >&2; return 1; }
  address="$binding/$db"
  export DATABASE_URL="postgresql://aqua_app:aqua_app_local_only@$address"
  export INGRESS_DATABASE_URL="postgresql://aqua_ingress:aqua_ingress_local_only@$address"
  export WORKER_DATABASE_URL="postgresql://aqua_worker:aqua_worker_local_only@$address"
  export DISPATCHER_DATABASE_URL="postgresql://aqua_dispatcher:aqua_dispatcher_local_only@$address"
  export OPERATIONS_DATABASE_URL="postgresql://aqua_operations:aqua_operations_local_only@$address"
  export SETTLEMENT_DATABASE_URL="postgresql://aqua_settlement:aqua_settlement_local_only@$address"
  export FUNDING_DATABASE_URL="postgresql://aqua_funding:aqua_funding_local_only@$address"
  export CORRECTION_DATABASE_URL="postgresql://aqua_correction:aqua_correction_local_only@$address"
  export ISSUANCE_DATABASE_URL="postgresql://aqua_issuance:aqua_issuance_local_only@$address"
  export AUTHORIZATION_SIMULATOR_DATABASE_URL="postgresql://aqua_authorizer:aqua_authorizer_local_only@$address"
  export AUTH_MAIL_FEEDBACK_DATABASE_URL="postgresql://aqua_feedback:aqua_feedback_local_only@$address"
  export SETTLEMENT_CASE_DATABASE_URL="postgresql://aqua_case_analyst:aqua_case_analyst_local_only@$address"
  export SETTLEMENT_REVIEWER_DATABASE_URL="postgresql://aqua_case_reviewer:aqua_case_reviewer_local_only@$address"
  export MONITOR_DATABASE_URL="postgresql://aqua_monitor:aqua_monitor_local_only@$address"
  export AUTH_MAIL_DATABASE_URL="postgresql://aqua_auth_mail:aqua_auth_mail_local_only@$address"
  owner_url="postgresql://aqua:$admin_password@$address"
}

start_cluster aqua_recovery_source
MIGRATION_DATABASE_URL="$owner_url" node --import tsx server/migrate.ts
MIGRATION_DATABASE_URL="$owner_url" node --import tsx scripts/recovery-fixture.ts seed
docker exec "$cluster" pg_dump -U aqua --format=custom --dbname=aqua_recovery_source > "$archive"
remove_cluster

start_cluster aqua_recovery_restored
# Restore dependencies, owners, ACLs and data together. Global roles were bootstrapped in the fresh cluster.
docker exec -i "$cluster" pg_restore -U aqua --single-transaction --exit-on-error \
  --dbname=aqua_recovery_restored < "$archive"
node --import tsx scripts/recovery-fixture.ts verify
# Reconcile the independent, normalized example against the restored ledger.
node --import tsx server/reconcile-issuer-statement.ts docs/examples/issuer-statement.json
node --import tsx server/reconcile-bank-settlement.ts docs/examples/issuer-statement.json \
  docs/examples/settlement-advice.json docs/examples/bank-statement.json

# Generate the short-lived certificates as postgres on this container's tmpfs.
# Only the two public trust anchors are copied out. PostgreSQL checks key modes.
docker exec -i --user postgres "$cluster" sh -eu <<'TLS'
umask 077
mkdir "$PGDATA/drill-tls"
cd "$PGDATA/drill-tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Aqua recovery CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' \
  -keyout ca.key -out ca.pem 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout server.key -out server.csr 2>/dev/null
cat > server.ext <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost
EXT
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -set_serial 1 -days 1 \
  -extfile server.ext -out server.pem 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Unrelated recovery CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' \
  -keyout /dev/null -out unrelated.pem 2>/dev/null
rm -f ca.key server.csr
TLS
docker exec --user postgres "$cluster" sh -c 'cat "$PGDATA/drill-tls/ca.pem"' > "$scratch/monitor-ca.pem"
docker exec --user postgres "$cluster" sh -c 'cat "$PGDATA/drill-tls/unrelated.pem"' > "$scratch/untrusted-ca.pem"
docker exec "$cluster" psql -X -v ON_ERROR_STOP=1 -U aqua -d aqua_recovery_restored \
  -c "ALTER SYSTEM SET ssl_cert_file = 'drill-tls/server.pem'" \
  -c "ALTER SYSTEM SET ssl_key_file = 'drill-tls/server.key'" \
  -c 'ALTER SYSTEM SET ssl = on' -c 'SELECT pg_reload_conf()' >/dev/null
for ((attempt=0; attempt<10; attempt++)); do
  active=$(docker exec "$cluster" psql -XAt -U aqua -d aqua_recovery_restored -c 'SHOW ssl')
  [[ "$active" == on ]] && break
  sleep 1
done
[[ "$active" == on ]] || { echo 'The restored PostgreSQL instance did not enable TLS.' >&2; exit 1; }
node scripts/recovery-monitor-tls.mjs "$scratch/monitor-ca.pem" "$scratch/untrusted-ca.pem"
