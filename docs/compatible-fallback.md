# Compatible fallback for the connected sandbox

The current migration history extends revision `3f11f799b1550f9c7936cba5e451069e808f684b`. The original API image checks its migration history at startup and will refuse the newer database. Build a paired fallback image before promoting the candidate. It packages the previous connected client and API, that release’s dependencies, and the candidate image’s actual SQL files. The build requires the pinned Git revision locally. Both releases retain their checksum and production role checks.

```sh
bash scripts/build-fallback-image.sh aqua-card-server:candidate aqua-card-server:compatible
bash scripts/fallback-drill.sh aqua-card-server:candidate aqua-card-server:compatible
```

The drill starts a fresh ephemeral PostgreSQL instance and runs both images as restricted users with production TLS verification against it. A current worker settles a pending partial capture and refund while the previous API serves reads. The drill then restarts the candidate and verifies the same session, balance, hold, settlement and duplicate receipts. It never contacts a configured service or registry for payment activity. Record the candidate and compatible fallback image digests from the release registry together with the successful drill output.

## Preparing an environment

1. Provision a dedicated ordinary PostgreSQL login named `aqua_fallback_api_015` with a distinct secret, no role memberships, no object ownership and no pre-existing grants. Apply migrations using the candidate image and its normal deployment process.
2. Run the paired fallback image’s `node dist-server/fallback-provision.js` once with `NODE_ENV=production`, the correct `DATABASE_SCHEMA`, trusted `DATABASE_CA_FILE`, the candidate database owner in `MIGRATION_DATABASE_URL` and the dedicated login in `DATABASE_URL`. It verifies migration history, installs the previous API’s allowlist for that login, and verifies the resulting permissions. Keep the owner credential scoped to this provisioning job.
3. Start the fallback web service with only its own database login, the normal HTTPS origin, TLS trust and static serving settings. Check `/api/health`, the web assets and an authenticated account using a synthetic member before directing traffic. Retain the candidate workers, queue consumers and migrations. Evaluate any newer features and coordinate customer communication before switching all web traffic.
4. During fallback an existing session can view the previous balance and activity screens and sign out. New sessions and other POST requests return HTTP 503 with a retry interval. Reserve and other newer screens resume with the candidate. The current workers continue processing accepted events. Switch web traffic back after the candidate passes the same checks with its original API role. Record both image digests, timestamps, reason, checks and worker evidence.

This repository exercises a sandbox release candidate. A Seoul staging drill with the actual roles, secrets, task definitions, ingress and deployment routing is still required before release.
