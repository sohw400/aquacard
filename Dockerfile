ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --chmod=0644 package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build:server && npm run build:connected

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    AQUA_HOST=0.0.0.0 \
    AQUA_PORT=3001 \
    AQUA_STATIC_DIR=/app/dist
COPY --chmod=0644 package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./dist
RUN find dist-server dist -type d -exec chmod 0755 {} + && find dist-server dist -type f -exec chmod 0644 {} +
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.AQUA_PORT||'3001')+'/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist-server/index.js"]
