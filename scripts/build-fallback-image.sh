#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
[[ $# == 2 ]] || { echo 'Usage: build-fallback-image.sh CURRENT_IMAGE FALLBACK_TAG' >&2; exit 2; }
prior=3f11f799b1550f9c7936cba5e451069e808f684b
current=$(docker image inspect --format '{{.Id}}' "$1")
scratch=$(mktemp -d)
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -s "$scratch/candidate.id" ]]; then docker rm --volumes "$(<"$scratch/candidate.id")" >/dev/null || result=1; fi
  rm -rf -- "$scratch"
  exit "$result"
}
trap cleanup EXIT
mkdir "$scratch/src"
git archive "$prior" | tar -x -C "$scratch/src"
docker create --cidfile "$scratch/candidate.id" "$current" >/dev/null
cd "$scratch/src"
docker cp "$(<"$scratch/candidate.id"):/app/dist-server/migrations" fallback-migrations
for sql in server/migrations/*.sql; do cmp "$sql" "fallback-migrations/${sql##*/}"; done
# All old migrations must be an exact prefix, including names, of the new release.
node --input-type=module <<'JS'
import { readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const names = path => readdirSync(path).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
const previous = names('server/migrations');
const current = names('fallback-migrations');
assert(current.length > previous.length && previous.length === 15);
assert.deepEqual(current.slice(0,previous.length), previous);
JS
repo="$OLDPWD"
patch --batch --forward --fuzz=0 -p1 < "$repo/docker/fallback/read-only.patch"
cp "$repo/docker/fallback/provision.ts" server/fallback-provision.ts
node_image=$(sed -n 's/^ARG NODE_IMAGE=//p' Dockerfile)
[[ "$node_image" =~ @sha256:[a-f0-9]{64}$ ]] || exit 1
cp "$repo/docker/fallback/overlay.Dockerfile" Dockerfile
# Preserve the current candidate's DB certificate bundle, including intentionally absent bundles.
args=(--load --build-arg "NODE_IMAGE=$node_image" --build-arg "FALLBACK_APP_REVISION=$prior" --build-arg "FALLBACK_SCHEMA_IMAGE=$current")
ca_hash=$(docker run --rm --read-only --network none --entrypoint node "$current" --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFileSync } from "node:fs";
  try { console.log(createHash("sha256").update(readFileSync("/etc/aqua/rds-ca.pem")).digest("hex")); }
  catch (error) { if (error.code !== "ENOENT") throw error; console.log("absent"); }
')
if [[ "$ca_hash" != absent ]]; then
  [[ "$ca_hash" =~ ^[0-9a-f]{64}$ ]] || exit 1
  docker cp "$(<"$scratch/candidate.id"):/etc/aqua/rds-ca.pem" "$scratch/rds-ca.pem"
  read -r actual _ < <(sha256sum "$scratch/rds-ca.pem")
  [[ "$actual" == "$ca_hash" ]] || exit 1
  args+=(--secret "id=rds_ca,src=$scratch/rds-ca.pem" --no-cache-filter historical)
fi
if [[ -n ${AQUA_BUILD_NPM_CA_FILE:-} ]]; then args+=(--secret "id=npm_ca,src=$AQUA_BUILD_NPM_CA_FILE"); fi
docker buildx build "${args[@]}" --target compatible-fallback --tag "$2" .
