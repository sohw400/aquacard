#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
[[ $# == 1 && -n "$1" ]] || { echo 'Usage: staging-bootstrap-smoke.sh EXISTING_SERVER_IMAGE' >&2; exit 2; }
image=$(docker image inspect --format '{{.Id}}' "$1")
pg_image=$(docker compose --env-file /dev/null -f compose.yaml config --images postgres)
scratch=$(mktemp -d)
network=
export DATABASE_HOST=aqua-fixture.fake.ap-northeast-2.rds.amazonaws.com

cleanup() {
  local status=$? file cid
  trap - EXIT
  for file in "$scratch/app.cid" "$scratch/db.cid"; do
    if [[ -s "$file" ]]; then
      cid=$(<"$file")
      if docker container inspect "$cid" >/dev/null 2>&1; then docker rm -fv "$cid" >/dev/null || status=1; fi
    fi
  done
  if [[ -n "$network" ]]; then docker network rm "$network" >/dev/null || status=1; fi
  rm -f -- "$scratch/app.cid" "$scratch/db.cid" "$scratch/ca.pem" "$scratch/response"
  rmdir -- "$scratch" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

network=$(docker network create --internal "aqua-bootstrap-$(openssl rand -hex 8)")
POSTGRES_PASSWORD=$(openssl rand -hex 32)
export POSTGRES_PASSWORD
# Only the local setup socket trusts the fixture administrator. The private
# network accepts authenticated TLS connections for the two application roles.
docker run --pull=never --detach --cidfile "$scratch/db.cid" --network "$network" --network-alias "$DATABASE_HOST" \
  --tmpfs /var/lib/postgresql --tmpfs /run/aqua-fixture --env DATABASE_HOST --env POSTGRES_PASSWORD \
  --entrypoint bash "$pg_image" -ec '
    umask 077
    cd /run/aqua-fixture
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=Aqua-Fixture-CA \
      -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign \
      -keyout ca.key -out ca.pem 2>/dev/null
    openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$DATABASE_HOST" \
      -keyout server.key -out server.csr 2>/dev/null
    openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -set_serial 1 -days 1 \
      -extfile <(printf "%s\n" "basicConstraints=critical,CA:FALSE" "extendedKeyUsage=serverAuth" "subjectAltName=DNS:$DATABASE_HOST") \
      -out server.pem 2>/dev/null
    rm ca.key server.csr
    printf "%s\n" "local all all trust" "hostssl aqua aqua_admin,aqua_monitor all scram-sha-256" > hba.conf
    chown postgres:postgres server.key server.pem hba.conf
    umask 022
    exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/run/aqua-fixture/server.pem \
      -c ssl_key_file=/run/aqua-fixture/server.key -c hba_file=/run/aqua-fixture/hba.conf
  ' >/dev/null
unset POSTGRES_PASSWORD
db=$(<"$scratch/db.cid")
for ((attempt=0; attempt<60; attempt++)); do
  # The entrypoint's temporary initialization server only listens on a Unix socket.
  if docker exec "$db" pg_isready -q -h 127.0.0.1; then break; fi
  [[ $(docker inspect --format '{{.State.Running}}' "$db") == true ]] || break
  sleep 1
done
if ! docker exec "$db" pg_isready -h 127.0.0.1; then
  docker logs --tail 25 "$db" >&2
  exit 1
fi
docker exec "$db" cat /run/aqua-fixture/ca.pem > "$scratch/ca.pem"
chmod 0444 "$scratch/ca.pem"

AQUA_FIXTURE_ADMIN_PASSWORD="$(openssl rand -hex 24):@%24/"
monitor_password="$(openssl rand -hex 24)?@%27/"
export AQUA_FIXTURE_ADMIN_PASSWORD
docker exec -i --env AQUA_FIXTURE_ADMIN_PASSWORD "$db" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
\getenv admin_password AQUA_FIXTURE_ADMIN_PASSWORD
CREATE ROLE aqua_admin LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'admin_password';
CREATE DATABASE aqua OWNER aqua_admin;
\connect aqua
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
printf -v AQUA_STAGING_DB_ADMIN_JSON '{"username":"aqua_admin","password":"%s"}' "$AQUA_FIXTURE_ADMIN_PASSWORD"
unset AQUA_FIXTURE_ADMIN_PASSWORD
printf -v MONITOR_DATABASE_SECRET '{"username":"aqua_monitor","password":"%s","dbname":"aqua","host":"%s","port":5432}' "$monitor_password" "$DATABASE_HOST"
unset monitor_password
export AQUA_STAGING_DB_ADMIN_JSON MONITOR_DATABASE_SECRET

run_job() {
  local entry=$1; shift
  rm -f -- "$scratch/app.cid"
  timeout --kill-after=5s 90s docker run --pull=never --rm --cidfile "$scratch/app.cid" --network "$network" \
    --read-only --no-healthcheck --cap-drop ALL --security-opt no-new-privileges --user node \
    --mount "type=bind,src=$scratch/ca.pem,dst=/etc/aqua/rds-ca.pem,readonly" \
    --env NODE_ENV=production --env DATABASE_SCHEMA=aqua --env DATABASE_CA_FILE=/etc/aqua/rds-ca.pem \
    --env MONITOR_DATABASE_SECRET "$@" "$image" node "dist-server/$entry.js"
}
bootstrap() {
  run_job staging-bootstrap --env DATABASE_HOST --env DATABASE_NAME=aqua --env AQUA_STAGING_DB_ADMIN_JSON
}
monitor_identity() {
  docker exec "$db" psql -XAt -v ON_ERROR_STOP=1 -U postgres -d aqua -c \
    "SELECT oid::text || ':' || md5(rolpassword) FROM pg_authid WHERE rolname='aqua_monitor' AND rolcanlogin"
}

bootstrap > "$scratch/response"
[[ $(<"$scratch/response") == '{"stagingMonitorBootstrap":"complete"}' ]]
identity=$(monitor_identity)
[[ -n "$identity" ]]
bootstrap > "$scratch/response"
[[ $(<"$scratch/response") == '{"stagingMonitorBootstrap":"complete"}' ]]
[[ $(monitor_identity) == "$identity" ]]

# A conflicting secret must fail and leave the original monitor login usable.
wrong_secret='{"username":"aqua_monitor","password":"unrelated-password","dbname":"aqua","host":"aqua-fixture.fake.ap-northeast-2.rds.amazonaws.com","port":5432}'
if MONITOR_DATABASE_SECRET="$wrong_secret" bootstrap > "$scratch/response" 2>&1; then
  echo 'Bootstrap accepted a conflicting monitor credential.' >&2; exit 1
else
  [[ $? == 1 && $(<"$scratch/response") == '{"stagingMonitorBootstrap":"failed"}' ]]
fi
[[ $(monitor_identity) == "$identity" ]]
run_job operations-monitor --env AQUA_MONITOR_ENVIRONMENT=bootstrap-smoke > "$scratch/response"
node --input-type=module - "$scratch/response" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(result.Environment, 'bootstrap-smoke');
assert.equal(result.MonitorHealthy, 1);
assert.equal(result.LedgerFindings, 0);
assert.deepEqual(result.failedChecks, []);
for (const queue of ['CardInbox', 'IssuerOutbox', 'AuthMail']) assert.equal(result[queue + 'DueCount'], 0);
JS
echo 'Compiled staging bootstrap initialized PostgreSQL over TLS, preserved the login on retry and rejected conflicting credentials. The isolated monitor completed with zero findings.'
