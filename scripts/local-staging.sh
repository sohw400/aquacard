#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
action=${1:-status}
case "$action" in up|down|status) ;; *) echo 'Use up, down or status.' >&2; exit 2;; esac
root=$(pwd -P)
export STAGE_DIR="${AQUA_STAGING_DIR:-$root/data/local-staging}"
mkdir -p "$STAGE_DIR"
STAGE_DIR=$(cd "$STAGE_DIR" && pwd -P)
# Reject shared or foreign state directories before putting any credentials there.
node -e 'const s=require("node:fs").lstatSync(process.env.STAGE_DIR); if(!s.isDirectory() || s.uid!==process.getuid() || (s.mode&0o077))throw Error("Use a private mode 0700 staging directory");'
exec 8>"$STAGE_DIR/stack.lock"
flock -w 180 8 || { echo 'Staging is busy.' >&2; exit 1; }
stage_id=$(node -e 'console.log(require("node:crypto").createHash("sha256").update(process.env.STAGE_DIR).digest("hex").slice(0,12))')
project="aqua-staging-$stage_id"
export STAGE_NODE_USER="$(id -u):$(id -g)"
if [[ "$(id -u)" == 0 ]]; then STAGE_NODE_USER=1000:1000; fi
export STAGE_RELEASE="$STAGE_DIR/unused" STAGE_DEPENDENCIES="$STAGE_DIR/unused"
compose=(docker compose --env-file /dev/null --project-name "$project" --file "$root/compose.staging.yaml")
config=(node scripts/local-staging-config.mjs)
if [[ -f "$STAGE_DIR/release.id" ]]; then
  read -r previous < "$STAGE_DIR/release.id"; STAGE_RELEASE="$STAGE_DIR/releases/$previous"
fi
if [[ -f "$STAGE_DIR/deps.id" ]]; then
  read -r previous < "$STAGE_DIR/deps.id"; STAGE_DEPENDENCIES="$STAGE_DIR/deps/$previous/node_modules"
fi
if [[ "$action" != up ]]; then
  if [[ ! -f "$STAGE_DIR/api.env" ]]; then echo 'Staging has not been initialized.'; exit 0; fi
  if [[ -s "$STAGE_DIR/preview-origin" ]]; then compose+=(--file "$STAGE_DIR/preview.json"); fi
  if [[ "$action" == down ]]; then "${compose[@]}" down; else "${compose[@]}" ps; fi
  exit
fi

# Each path here is a private mktemp directory created by this invocation.
scratch=()
cleanup_scratch() {
  for path in "${scratch[@]}"; do
    if [[ -d "$path" ]]; then rm -rf -- "$path"; fi
  done
}
trap cleanup_scratch EXIT
preview=""
if [[ -f "$STAGE_DIR/preview-origin" ]]; then preview=$(<"$STAGE_DIR/preview-origin"); fi
export STAGE_PREVIEW="${AQUA_STAGING_PREVIEW_ORIGIN-$preview}"
"${config[@]}" configure
if [[ -n "$STAGE_PREVIEW" ]]; then
  echo '{"services":{"edge":{"ports":["0.0.0.0:3000:8080"]}}}' >"$STAGE_DIR/preview.json"
  compose+=(--file "$STAGE_DIR/preview.json")
fi

if [[ ! -f "$STAGE_DIR/ca.crt" ]]; then
  # Write the CA certificate last. A failed first attempt can safely try again.
  pki=$(mktemp -d "$STAGE_DIR/.pki.XXXXXXXX")
  scratch+=("$pki")
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 730 -subj '/CN=Aqua local staging CA' \
    -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
    -keyout "$pki/ca.key" -out "$pki/ca.crt" 2>/dev/null
  for service in db web; do
    openssl req -new -newkey rsa:2048 -nodes -subj "/CN=aqua-staging-$service" \
      -keyout "$pki/$service.key" -out "$pki/$service.csr" 2>/dev/null
    names='DNS:localhost,IP:127.0.0.1'
    if [[ "$service" == db ]]; then names+=',DNS:postgres'; fi
    openssl x509 -req -sha256 -days 365 -in "$pki/$service.csr" -CA "$pki/ca.crt" -CAkey "$pki/ca.key" \
      -set_serial "0x$(openssl rand -hex 15)" -extfile <(printf '%s\n' 'basicConstraints=critical,CA:FALSE' \
        'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' "subjectAltName=$names") -out "$pki/$service.crt" 2>/dev/null
    mv "$pki/$service.crt" "$pki/$service.key" "$STAGE_DIR/"
  done
  chmod 0644 "$pki/ca.crt"
  mv "$pki/ca.crt" "$STAGE_DIR/ca.crt"
  # Signing key and intermediate CSRs are needed only while issuing this private pair.
  rm -f -- "$pki/ca.key" "$pki/db.csr" "$pki/web.csr"
  rmdir "$pki"
fi
for cert in ca db web; do
  openssl x509 -in "$STAGE_DIR/$cert.crt" -noout -checkend 60 >/dev/null || { echo "Expired staging $cert certificate." >&2; exit 1; }
done

release=$("${config[@]}" release)
deps=$(sha256sum package-lock.json | cut -d' ' -f1)
mkdir -p "$STAGE_DIR/releases" "$STAGE_DIR/deps" "$STAGE_DIR/mailbox" "$STAGE_DIR/issuer-receipts"
if [[ "$(id -u)" == 0 ]]; then chown 1000:1000 "$STAGE_DIR/mailbox" "$STAGE_DIR/issuer-receipts"; fi
if [[ ! -d "$STAGE_DIR/deps/$deps" ]]; then
  work=$(mktemp -d "$STAGE_DIR/deps/.install.XXXXXXXX")
  scratch+=("$work")
  cp package.json package-lock.json "$work/"
  (umask 022; npm_config_cache="${npm_config_cache:-${TMPDIR:-/tmp}/aqua-staging-npm-$(id -u)}" npm ci --prefix "$work" --omit=dev --no-audit --no-fund)
  mv "$work" "$STAGE_DIR/deps/$deps"
fi
if [[ ! -d "$STAGE_DIR/releases/$release" ]]; then
  work=$(mktemp -d "$STAGE_DIR/releases/.build.XXXXXXXX")
  scratch+=("$work")
  AQUA_SERVER_BUILD_DIR="$work/dist-server" npm run build:server
  npm run build:connected -- --outDir "$work/dist"
  cp package.json "$work/"
  mkdir "$work/node_modules"
  chmod -R a+rX "$work"
  mv "$work" "$STAGE_DIR/releases/$release"
fi
export STAGE_RELEASE="$STAGE_DIR/releases/$release" STAGE_DEPENDENCIES="$STAGE_DIR/deps/$deps/node_modules"
mkdir -p "$STAGE_RELEASE/node_modules"
"${compose[@]}" up -d --wait postgres edge
edge_id=$("${compose[@]}" ps -q edge)
edge_ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$edge_id")
"${config[@]}" configure "$edge_ip"
if [[ -f "$STAGE_DIR/release.id" && "$(<"$STAGE_DIR/release.id")" != "$release" ]]; then
  # Drain the old processes before migrating a persistent schema for a new build.
  "${compose[@]}" stop app mail dispatcher issuer
fi
"${config[@]}" bootstrap
# The host CLI gets only the generated staging settings. Never import repository .env defaults.
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --wait app mail issuer dispatcher
curl --noproxy localhost -fsS --max-time 8 --cacert "$STAGE_DIR/ca.crt" https://localhost:3443/api/health >/dev/null
printf '%s\n' "$release" >"$STAGE_DIR/release.id"
printf '%s\n' "$deps" >"$STAGE_DIR/deps.id"
printf '%s' "$STAGE_PREVIEW" >"$STAGE_DIR/preview-origin"
AQUA_STAGING_DIR="$STAGE_DIR" node --import tsx scripts/staging-member.ts
echo "Staging ready at https://localhost:3443"
if [[ -n "$STAGE_PREVIEW" ]]; then echo "Private preview origin: $STAGE_PREVIEW"; fi
