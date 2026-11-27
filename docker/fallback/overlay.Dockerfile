# The build script supplies NODE_IMAGE from the pinned historical release.
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS historical
WORKDIR /app
RUN --mount=type=bind,source=.,target=/source,ro \
    --mount=type=secret,id=npm_ca,required=false \
    --mount=type=secret,id=rds_ca,required=false \
    --mount=type=tmpfs,target=/app \
    set -eu; \
    if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    cp -R /source/. /app/; \
    npm ci --no-audit --no-fund; \
    npm run build:server; npm run build:connected; \
    node --input-type=module -e 'import {build} from "esbuild"; await build({entryPoints:["server/fallback-provision.ts"],outfile:"dist-server/fallback-provision.js",bundle:true,packages:"external",platform:"node",target:"node24",format:"esm"})'; \
    npm prune --omit=dev --no-audit --no-fund; \
    mkdir -p /release/app/dist-server/migrations; \
    cp -R node_modules dist package.json package-lock.json /release/app/; \
    cp dist-server/index.js dist-server/fallback-provision.js /release/app/dist-server/; \
    cp fallback-migrations/*.sql /release/app/dist-server/migrations/; \
    chmod -R a+rX /release/app; \
    if [ -s /run/secrets/rds_ca ]; then mkdir -p /release/etc/aqua; install -m 0444 /run/secrets/rds_ca /release/etc/aqua/rds-ca.pem; fi; \
    npm cache clean --force

FROM ${NODE_IMAGE} AS compatible-fallback
WORKDIR /app
ARG FALLBACK_APP_REVISION
ARG FALLBACK_SCHEMA_IMAGE
LABEL io.aquacard.fallback.app-revision=${FALLBACK_APP_REVISION} io.aquacard.fallback.schema-image-id=${FALLBACK_SCHEMA_IMAGE}
ENV NODE_ENV=production AQUA_HOST=0.0.0.0 AQUA_PORT=3001 AQUA_STATIC_DIR=/app/dist
COPY --from=historical /release/ /
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.AQUA_PORT||'3001')+'/api/live',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node","dist-server/index.js"]
