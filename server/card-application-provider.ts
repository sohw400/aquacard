import { CardApplicationStore, type ApplicationProviderEvent } from './card-applications';
import { cardServiceDatabase } from './card-service-database';
import { LedgerError } from './errors';
import { verifyMigrations } from './migrations';
import { verifyIssuanceRole } from './permissions';

const usage = 'Usage: server:issuance -- <application-uuid> <version> <event-id> <approve|decline|issue|dispatch|deliver> [ELIGIBILITY|DETAILS_REQUIRED]';
async function run() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  if (process.env.NODE_ENV === 'production') throw new Error('Sandbox only.');
  const [id, version, eventId, action, reason] = args;
  if (!/^[0-9a-f-]{36}$/.test(id ?? '') || !/^[1-6]$/.test(version ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventId ?? '')
    || !['approve','decline','issue','dispatch','deliver'].includes(action)
    || (action === 'decline' ? (args.length !== 5 || !['ELIGIBILITY','DETAILS_REQUIRED'].includes(reason)) : args.length !== 4)) {
    console.error(usage); process.exitCode = 1; return;
  }
  const database = await cardServiceDatabase('issuance');
  try {
    await verifyMigrations(database);
    await verifyIssuanceRole(database);
    const command: ApplicationProviderEvent = {
      applicationId:id, expectedVersion:Number(version), eventId, action:action as ApplicationProviderEvent['action'],
    };
    if (action === 'decline') command.reason = reason as ApplicationProviderEvent['reason'];
    console.log(JSON.stringify(await new CardApplicationStore(database).providerEvent(command)));
  } finally { await database.close(); }
}
run().catch((error: unknown) => {
  console.error(error instanceof LedgerError ? error.code : 'SANDBOX_ISSUANCE_UNAVAILABLE');
  process.exitCode = 1;
});
