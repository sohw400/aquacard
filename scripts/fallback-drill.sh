#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
[[ $# == 2 ]] || { echo 'Usage: fallback-drill.sh CURRENT_IMAGE FALLBACK_IMAGE' >&2; exit 2; }
candidate=$(docker image inspect --format '{{.Id}}' "$1")
fallback=$(docker image inspect --format '{{.Id}}' "$2")
paired=$(docker image inspect --format '{{index .Config.Labels "io.aquacard.fallback.schema-image-id"}}' "$fallback")
[[ "$paired" == "$candidate" ]] || { echo 'Fallback was not built for this exact candidate.' >&2; exit 1; }
pg_image=$(docker compose --env-file /dev/null -f compose.yaml config --images postgres)
scratch=$(mktemp -d)
cleanup() {
  local result=$?
  trap - EXIT
  for cid in api db; do
    if [[ -s "$scratch/$cid" ]]; then docker rm --force --volumes "$(<"$scratch/$cid")" >/dev/null || result=1; fi
  done
  if [[ -s "$scratch/network" ]]; then docker network rm "$(<"$scratch/network")" >/dev/null || result=1; fi
  rm -rf -- "$scratch"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
network=$(docker network create "aqua-fallback-$(basename "$scratch")")
echo "$network" > "$scratch/network"
admin_password=$(openssl rand -hex 24)
fallback_password=$(openssl rand -hex 24)
POSTGRES_PASSWORD="$admin_password" docker run --detach --cidfile "$scratch/db" --tmpfs /var/lib/postgresql \
  --network "$network" --network-alias fallback-db --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=aqua --env POSTGRES_PASSWORD --env POSTGRES_DB=aqua_fallback "$pg_image" >/dev/null
db=$(<"$scratch/db")
for ((attempt=0;attempt<60;attempt++)); do
  if docker exec "$db" pg_isready -q -h 127.0.0.1 -U aqua -d aqua_fallback; then break; fi
  sleep 1
done
psql=(docker exec -i "$db" psql -X -q -v ON_ERROR_STOP=1 -U aqua -d aqua_fallback)
"${psql[@]}" < docker/postgres-init.sql
"${psql[@]}" <<< "CREATE ROLE aqua_fallback_api_015 LOGIN PASSWORD '$fallback_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;"
docker exec -i --user postgres "$db" sh -eu <<'TLS'
umask 077
mkdir "$PGDATA/fallback-tls"
cd "$PGDATA/fallback-tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Fallback drill' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' \
  -keyout ca.key -out ca.pem 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=fallback-db' -keyout server.key -out server.csr 2>/dev/null
cat > server.ext <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:fallback-db
EXT
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -set_serial 1 -days 1 \
  -extfile server.ext -out server.pem 2>/dev/null
rm -f ca.key server.csr
TLS
docker exec --user postgres "$db" sh -c 'cat "$PGDATA/fallback-tls/ca.pem"' > "$scratch/ca.pem"
chmod 0444 "$scratch/ca.pem"
"${psql[@]}" -c "ALTER SYSTEM SET ssl_cert_file = 'fallback-tls/server.pem'" \
  -c "ALTER SYSTEM SET ssl_key_file = 'fallback-tls/server.key'" -c 'ALTER SYSTEM SET ssl = on' -c 'SELECT pg_reload_conf()' >/dev/null
for ((attempt=0;attempt<10;attempt++)); do
  [[ $("${psql[@]}" -Atc 'SHOW ssl') == on ]] && break
  sleep 1
done
[[ $("${psql[@]}" -Atc 'SHOW ssl') == on ]]
address=fallback-db:5432/aqua_fallback
admin_url="postgresql://aqua:$admin_password@$address"
app_url="postgresql://aqua_app:aqua_app_local_only@$address"
worker_url="postgresql://aqua_worker:aqua_worker_local_only@$address"
fallback_url="postgresql://aqua_fallback_api_015:$fallback_password@$address"
runtime=(--network "$network" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m --cap-drop ALL --security-opt no-new-privileges
  --mount "type=bind,src=$scratch/ca.pem,dst=/run/aqua-ca.pem,readonly" -e DATABASE_CA_FILE=/run/aqua-ca.pem
  -e NODE_ENV=production -e DATABASE_SCHEMA=aqua)
http=(-e AQUA_HOST=0.0.0.0 -e AQUA_PORT=3001 -e AQUA_ALLOWED_ORIGINS=https://fallback.example.test)
MIGRATION_DATABASE_URL="$admin_url" docker run --rm "${runtime[@]}" -e MIGRATION_DATABASE_URL \
  -e DATABASE_RUNTIME_ROLE=aqua_app -e DATABASE_WORKER_ROLE=aqua_worker -e DATABASE_INGRESS_ROLE=aqua_ingress \
  "$candidate" node dist-server/migrate.js
MIGRATION_DATABASE_URL="$admin_url" DATABASE_URL="$fallback_url" docker run --rm "${runtime[@]}" \
  -e MIGRATION_DATABASE_URL -e DATABASE_URL "$fallback" node dist-server/fallback-provision.js

# A runtime role containing newer grants must fail the historical verifier.
if DATABASE_URL="$app_url" timeout 15s docker run --rm "${runtime[@]}" "${http[@]}" -e DATABASE_URL "$fallback" > "$scratch/wrong-role.log" 2>&1; then
  echo 'Fallback unexpectedly accepted the current runtime role.' >&2; exit 1
else
  rc=$?
  [[ $rc == 1 ]] && rg -q 'cannot execute private ledger helper functions' "$scratch/wrong-role.log" || { cat "$scratch/wrong-role.log" >&2; exit 1; }
fi

start_api() {
  DATABASE_URL="$2" docker run --detach --cidfile "$scratch/api" "${runtime[@]}" "${http[@]}" \
    --publish 127.0.0.1::3001 --env DATABASE_URL "$1" >/dev/null
  local id
  id=$(<"$scratch/api")
  local binding
  binding=$(docker port "$id" 3001/tcp)
  [[ "$binding" =~ ^127\.0\.0\.1:[0-9]+$ ]] || return 1
  api_address="http://$binding"
  for ((i=0;i<30;i++)); do
    if curl --silent --fail "$api_address/api/health" >/dev/null && curl --silent --fail "$api_address/" >/dev/null; then return 0; fi
    [[ $(docker inspect --format '{{.State.Running}}' "$id") == true ]] || break
    sleep 1
  done
  docker logs --tail 20 "$id" >&2; return 1
}
stop_api() {
  docker stop --time 10 "$(<"$scratch/api")" >/dev/null
  docker rm --volumes "$(<"$scratch/api")" >/dev/null
  rm -f "$scratch/api"
}
host_binding=$(docker port "$db" 5432/tcp)
[[ "$host_binding" =~ ^127\.0\.0\.1:[0-9]+$ ]]
host_db="$host_binding/aqua_fallback"
fixture() {
  NODE_ENV=test DATABASE_URL="postgresql://aqua_app:aqua_app_local_only@$host_db" \
    MIGRATION_DATABASE_URL="postgresql://aqua:$admin_password@$host_db" INGRESS_DATABASE_URL="postgresql://aqua_ingress:aqua_ingress_local_only@$host_db" \
    node --import tsx scripts/fallback-fixture.ts "$1" "$api_address" "$scratch/session.json"
}
start_api "$candidate" "$app_url"
fixture seed
stop_api
start_api "$fallback" "$fallback_url"
fixture held
for event in capture refund; do
  WORKER_DATABASE_URL="$worker_url" docker run --rm "${runtime[@]}" -e WORKER_DATABASE_URL "$candidate" node dist-server/card-worker.js --once
done
fixture settled
stop_api
start_api "$candidate" "$app_url"
fixture resumed
echo "Fallback verified for candidate $candidate and fallback $fallback."
