import type { Database } from './database';
import { verifyMigrations } from './migrations';
import { verifyCardIngressRole } from './permissions';
import { CardInboxStore } from './card-inbox';
import { CardIngressConfigurationError, createCardIngress } from './card-ingress-http';
import { cardServiceDatabase } from './card-service-database';
import { closeHttpService, drainOnShutdown } from './http-shutdown';

async function start() {
  if (process.env.NODE_ENV === 'production') throw new CardIngressConfigurationError('Sandbox card ingress is disabled in production.');
  const port = Number(process.env.AQUA_CARD_INGRESS_PORT ?? 3004);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CardIngressConfigurationError('AQUA_CARD_INGRESS_PORT must be a valid port.');
  let keys: Record<string, string>;
  try { keys = JSON.parse(process.env.AQUA_CARD_WEBHOOK_KEYS ?? '') as Record<string, string>; }
  catch { throw new CardIngressConfigurationError('Set AQUA_CARD_WEBHOOK_KEYS to a JSON map of explicitly configured sandbox signing keys.'); }
  process.umask(0o077);
  let database: Database | undefined;
  let app: ReturnType<typeof createCardIngress> | undefined;
  try {
    database = await cardServiceDatabase('ingress');
    app = createCardIngress(new CardInboxStore(database), { keys });
    await verifyMigrations(database);
    await verifyCardIngressRole(database);
    await app.listen({ host: process.env.AQUA_CARD_INGRESS_HOST ?? '127.0.0.1', port });
  } catch (error) {
    await closeHttpService(app, database);
    throw error;
  }
  drainOnShutdown(app, database);
}

start().catch((error: unknown) => {
  if (error instanceof CardIngressConfigurationError) console.error(error.message);
  else console.error('Card ingress could not start. Check migrations, INGRESS_DATABASE_URL, the restricted ingress role and sandbox configuration.');
  process.exitCode = 1;
});
