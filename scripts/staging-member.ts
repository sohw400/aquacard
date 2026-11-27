import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthService } from '../server/auth';
import { CardApplicationStore } from '../server/card-applications';
import { CardPaymentStore } from '../server/card-payments';
import type { Database } from '../server/database';
import { assertPrivateStagingPath, LocalStagingError, openLocalStagingOperator } from './staging-operator';
import { LedgerError } from '../server/errors';
import { LedgerStore } from '../server/ledger';
import { verifyMigrations } from '../server/migrations';
import { applyReserve } from '../server/reserve';
import { RewardsStore } from '../server/rewards';
import { approveTestCustomer } from '../server/test-customer-access';

const fixtureEmail = 'qa-member@example.test';
const purchaseId = 'staging-member-v1-purchase';
const captureId = 'staging-member-v1-capture';
type Credentials = { email: string; tag: string; password: string };

async function credentialsFor(path: string, accountExists: boolean): Promise<Credentials> {
  try {
    await assertPrivateStagingPath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (accountExists) throw new LocalStagingError('This member exists. Restore its original private member.json before continuing.');
    const initial = {
      email: fixtureEmail, tag: 'stageqa' + randomBytes(5).toString('hex'),
      password: 'Aa1!' + randomBytes(24).toString('base64url'),
    };
    const temp = path + '.' + randomUUID();
    try {
      await writeFile(temp, JSON.stringify(initial) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
    return initial;
  }
  const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!saved || typeof saved !== 'object' || !('email' in saved) || saved.email !== fixtureEmail ||
      !('tag' in saved) || typeof saved.tag !== 'string' || !/^stageqa[0-9a-f]{10}$/.test(saved.tag) ||
      !('password' in saved) || typeof saved.password !== 'string' || saved.password.length < 24) {
    throw new LocalStagingError('Invalid staging member credential file.');
  }
  return { email: fixtureEmail, tag: saved.tag, password: saved.password };
}

async function provision(owner: Database, app: Database, issuance: Database, credentialsPath: string) {
  const ledger = new LedgerStore(app);
  const existing = await ledger.getUserByEmail(fixtureEmail);
  const credentials = await credentialsFor(credentialsPath, Boolean(existing));
  if (existing && existing.tag !== credentials.tag) throw new LocalStagingError('The fixture email is owned by another member.');

  // A committed capture is the last step. A later invocation must preserve subsequent
  // spending, card locks, reward preferences and all operator changes to this account.
  const done = await owner.query<{ user_id: string }>(
    "SELECT user_id FROM card_payment_events WHERE event_id=$1 AND payment_id=$2 AND kind='capture' AND result IS NOT NULL",
    [captureId, purchaseId]);
  if (done.rowCount) {
    if (!existing || done.rows[0].user_id !== existing.id) throw new LocalStagingError('The staging payment belongs to another member.');
    return;
  }

  const auth = new AuthService(ledger);
  // Resume an interrupted signup only after proving ownership of the original login.
  const session = existing
    ? await auth.login(credentials, 'staging-member-provision')
    : await auth.signup({ ...credentials, name: '스테이징 회원' }, 'staging-member-provision');
  await auth.logout(session.token);
  const userId = session.user.id;
  await approveTestCustomer(owner, userId);
  const applications = new CardApplicationStore(app);
  const provider = new CardApplicationStore(issuance);
  const submitted = await applications.submit({ userId, form: 'virtual', idempotencyKey: 'staging-member-v1-application' });
  const approved = await provider.providerEvent({ applicationId: submitted.id, expectedVersion: submitted.version,
    eventId: 'staging-member-v1-approve', action: 'approve' });
  const issued = await provider.providerEvent({ applicationId: approved.id, expectedVersion: approved.version,
    eventId: 'staging-member-v1-issue', action: 'issue' });
  await applications.activate({ userId, applicationId: issued.id, expectedVersion: issued.version,
    idempotencyKey: 'staging-member-v1-activate' });

  const rewards = new RewardsStore(owner);
  await rewards.fundBudget({ amountWon: 50_000, idempotencyKey: 'staging-member-v1-budget' });
  await rewards.setProgram({ enabled: true, idempotencyKey: 'staging-member-v1-rewards' });
  await ledger.creditSandbox({ userId, amountWon: 1_000_000, idempotencyKey: 'staging-member-v1-credit' });
  await applyReserve(app, userId, 'staging-member-v1-reserve', { kind: 'in', amountWon: 300_000 });
  const cards = new CardPaymentStore(app);
  await cards.apply({ kind: 'authorize', eventId: 'staging-member-v1-auth', paymentId: purchaseId, userId,
    merchantName: '성수서점', amountWon: 21_800 });
  await cards.apply({ kind: 'capture', eventId: captureId, paymentId: purchaseId, userId,
    finalCapture: true, amountWon: 21_800 });
}

async function run() {
  if (process.argv.length !== 2) throw new LocalStagingError('Usage: npm run staging:member');
  const operator = await openLocalStagingOperator();
  const owner = operator.database('MIGRATION_DATABASE_URL');
  const app = operator.database('DATABASE_URL');
  const issuance = operator.database('ISSUANCE_DATABASE_URL');
  const credentialsPath = join(operator.dir, 'member.json');
  try {
    await verifyMigrations(owner);
    // Serialize credential creation and the complete fixture across parallel setup commands.
    const lock = await owner.pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended('aqua-local-staging-member-v1', 0))");
      await provision(owner, app, issuance, credentialsPath);
    } finally { lock.release(true); }
  } finally { await Promise.all([owner.close(), app.close(), issuance.close()]); }
  console.log(`Staging member ready. Login details: ${credentialsPath}`);
}

run().catch((error: unknown) => {
  // Never print provider/driver error bodies, including connection strings or credentials.
  if (error instanceof LedgerError) {
    console.error(`Staging member setup failed (${error.code}).`);
    process.exitCode = 1;
    return;
  }
  const message = error instanceof LocalStagingError ? error.message : 'Check staging database readiness, credentials, roles and migrations.';
  console.error(message);
  process.exitCode = 1;
});
