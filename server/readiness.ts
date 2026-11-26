import type { Database } from './database';
import { releaseMigrationManifest } from './migrations';

export const livenessSchema = {
  type: 'object', additionalProperties: false, required: ['status'],
  properties: { status: { type: 'string', enum: ['ok'] } },
};

const probeTimeout = 2_000;
const privileges = {
  api: `has_table_privilege(current_user, 'ledger_accounts', 'SELECT')
    AND has_table_privilege(current_user, 'journals', 'INSERT')
    AND has_function_privilege(current_user, 'customer_require_active(text[])', 'EXECUTE')`,
  ingress: `has_function_privilege(current_user, 'enqueue_sandbox_card_event(jsonb,bigint)', 'EXECUTE')`,
};

/** Recheck routing prerequisites with the service's own connection, without writing test records. */
export function createReadinessProbe(database: Database, service: keyof typeof privileges): () => Promise<boolean> {
  const text = `SELECT NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off'
    AND (SELECT jsonb_object_agg(name, checksum) FILTER (WHERE left(name, 3) <= $2) = $1::jsonb
      AND count(*) = count(DISTINCT left(name, 3))
      AND bool_and(name ~ '^[0-9]{3}_[a-z0-9_]+[.]sql$' AND checksum ~ '^[0-9a-f]{64}$')
      FROM schema_migrations)
    AND ${privileges[service]} AS ready`;
  let manifest: Awaited<ReturnType<typeof releaseMigrationManifest>> | undefined;
  let inFlight: Promise<boolean> | undefined;
  async function check() {
    manifest ??= await releaseMigrationManifest();
    // pg applies query_timeout after checkout. On expiry pool.query discards the connection.
    const query = { text, values: [manifest.checksums, manifest.lastVersion], query_timeout: probeTimeout };
    return (await database.pool.query<{ ready: boolean }>(query)).rows[0]?.ready === true;
  }
  return () => {
    if (inFlight) return inFlight;
    let timer: NodeJS.Timeout;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), probeTimeout);
      timer.unref();
    });
    const completion = check().catch(() => false).finally(() => {
      clearTimeout(timer);
      inFlight = undefined;
    });
    // The HTTP deadline includes waiting for a pool slot. Keep sharing a timed-out result
    // until pg frees the slot, so a burst of probes cannot fill the checkout queue.
    inFlight = Promise.race([completion, deadline]);
    return inFlight;
  };
}
