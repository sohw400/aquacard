
FROM build AS fallback-setup
RUN node --input-type=module -e 'import {build} from "esbuild"; await build({entryPoints:["server/fallback-provision.ts"],outfile:"dist-server/fallback-provision.js",bundle:true,packages:"external",platform:"node",target:"node24",format:"esm"})'

FROM runtime AS compatible-fallback
ARG FALLBACK_APP_REVISION
ARG FALLBACK_SCHEMA_IMAGE
LABEL io.aquacard.fallback.app-revision=${FALLBACK_APP_REVISION} io.aquacard.fallback.schema-image-id=${FALLBACK_SCHEMA_IMAGE}
COPY --from=fallback-setup --chmod=0444 /app/dist-server/fallback-provision.js ./dist-server/
COPY --chmod=0444 fallback-migrations/*.sql ./dist-server/migrations/
