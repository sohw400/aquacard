import assert from 'node:assert/strict';
import type { AccountSnapshot, SandboxCardEvent } from '../shared/api';
import { CardPaymentStore } from '../server/card-payments';
import { Database } from '../server/database';
import { IssuerOutboxStore } from '../server/issuer-outbox';
import { LedgerStore } from '../server/ledger';
import { verifyMigrations } from '../server/migrations';
import {
  verifyApplicationRole, verifyAuthMailRole, verifyCardDispatcherRole,
  verifyCardIngressRole, verifyCardOperationsRole, verifyCardWorkerRole, verifyMonitorRole, verifySettlementRole, verifyFundingRole, verifyCorrectionRole, verifyIssuanceRole, verifySettlementCaseRole, verifyAuthMailFeedbackRole, verifyAuthorizationSimulatorRole,
} from '../server/permissions';
import { reconcileRewards } from '../server/reward-reconciliation';
import { RewardsStore } from '../server/rewards';
import { approveTestCustomer } from '../server/test-customer-access';

const phase = process.argv[2];
assert.ok(process.argv.length === 3 && (phase === 'seed' || phase === 'verify'), 'Usage: recovery-fixture.ts seed|verify');
assert.ok(process.env.NODE_ENV === 'test' && process.env.DATABASE_SCHEMA === 'aqua', 'Requires the isolated test schema.');
const databaseName = phase === 'seed' ? 'aqua_recovery_source' : 'aqua_recovery_restored';

async function withRole(variable: string, work: (db: Database) => Promise<void>) {
  const raw = process.env[variable];
  assert.ok(raw && process.env.DATABASE_URL, `Missing ${variable} for the recovery drill.`);
  const url = new URL(raw);
  assert.ok(url.hostname === '127.0.0.1' && url.host === new URL(process.env.DATABASE_URL).host
    && url.pathname === '/' + databaseName, `Expected ${variable} to identify the disposable drill database.`);
  const db = new Database({ connectionString: raw, schema: 'aqua', maxConnections: 1 });
  try {
    const { rows } = await db.query('SELECT current_database() AS db, current_user AS role, current_schema() AS schema');
    assert.deepEqual(rows, [{ db: databaseName, role: decodeURIComponent(url.username), schema: 'aqua' }]);
    await work(db);
  } finally { await db.close(); }
}

const userId = 'recovery-member';
const paid = { paymentId: 'recovery-purchase', userId };
const held = { paymentId: 'recovery-hold', userId };
const credit = { userId, amountWon: 1_000, idempotencyKey: 'recovery-credit' };
const events: SandboxCardEvent[] = [
  { ...paid, kind: 'authorize', eventId: 'purchase-auth', amountWon: 100, merchantName: '체험 서점' },
  { ...paid, kind: 'capture', eventId: 'purchase-capture', amountWon: 100, finalCapture: true },
  { ...paid, kind: 'refund', eventId: 'purchase-refund', amountWon: 30 },
  { ...held, kind: 'authorize', eventId: 'hold-auth', amountWon: 75, merchantName: '체험 식당' },
];
const finishHold: SandboxCardEvent = { ...held, kind: 'capture', eventId: 'hold-capture', amountWon: 50, finalCapture: true };
const now = Date.UTC(2025, 10, 26);
const clock = { now: () => now };

async function seed(ledger: LedgerStore, cards: CardPaymentStore) {
  await ledger.createUser({ id: userId, email: 'recovery@example.test', name: '복원 체험', tag: 'recovery',
    passwordHash: 'synthetic-test-only', createdAt: now });
  await withRole('MIGRATION_DATABASE_URL', async (owner) => {
    await approveTestCustomer(owner, userId);
    await new IssuerOutboxStore(owner, clock).register({ userId, providerCardId: 'sandbox-card-recovery', initialStatus: 'active' });
    const rewards = new RewardsStore(owner, clock);
    await rewards.fundBudget({ amountWon: 1_000, idempotencyKey: 'recovery-budget' });
    await rewards.setProgram({ enabled: true, idempotencyKey: 'recovery-program' });
    await rewards.grant({ userId, amountWon: 40, idempotencyKey: 'recovery-rewards' });
  });
  await ledger.creditSandbox(credit);
  for (const event of events) await cards.apply(event);
}

async function checkLedger(db: Database, eventCount: number, settlementWon: number) {
  const result = await reconcileRewards(db);
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
  assert.equal(result.counts.cardPayments, '2');
  assert.equal(result.counts.cardPaymentEvents, String(eventCount));
  const { rows } = await db.query("SELECT balance_won FROM ledger_accounts WHERE id = 'system:card_settlement'");
  assert.deepEqual(rows, [{ balance_won: String(settlementWon) }]);
}

function verifyBackupState(snapshot: AccountSnapshot) {
  assert.equal(snapshot.access.canTransact, true);
  assert.equal(snapshot.balanceWon, 895);
  assert.equal(snapshot.heldBalanceWon, 63);
  assert.equal(snapshot.rewards.availableWon, 0);
  assert.equal(snapshot.rewards.heldWon, 12);
  const purchase = snapshot.cardPayments.find((p) => p.id === paid.paymentId);
  assert.ok(purchase);
  assert.equal(purchase.status, 'partially_refunded');
  assert.equal(purchase.capturedWon, 100);
  assert.equal(purchase.refundedWon, 30);
  assert.equal(purchase.funding?.principal.refundedWon, 18);
  assert.equal(purchase.funding?.rewards.refundedWon, 12);
  const pending = snapshot.cardPayments.find((p) => p.id === held.paymentId);
  assert.ok(pending);
  assert.equal(pending.status, 'authorized');
  assert.equal(pending.heldWon, 75);
}

async function verifyServiceRoles() {
  for (const [variable, verify] of [
    ['INGRESS_DATABASE_URL', verifyCardIngressRole],
    ['WORKER_DATABASE_URL', verifyCardWorkerRole],
    ['DISPATCHER_DATABASE_URL', verifyCardDispatcherRole],
    ['OPERATIONS_DATABASE_URL', verifyCardOperationsRole],
    ['AUTH_MAIL_DATABASE_URL', verifyAuthMailRole],
    ['MONITOR_DATABASE_URL', verifyMonitorRole],
    ['SETTLEMENT_DATABASE_URL', verifySettlementRole],
    ['FUNDING_DATABASE_URL', verifyFundingRole],
    ['CORRECTION_DATABASE_URL', verifyCorrectionRole],
    ['ISSUANCE_DATABASE_URL', verifyIssuanceRole],
    ['AUTHORIZATION_SIMULATOR_DATABASE_URL', verifyAuthorizationSimulatorRole],
    ['AUTH_MAIL_FEEDBACK_DATABASE_URL', verifyAuthMailFeedbackRole],
    ['SETTLEMENT_CASE_DATABASE_URL', verifySettlementCaseRole],
    ['SETTLEMENT_REVIEWER_DATABASE_URL', verifySettlementCaseRole],
  ] as const) await withRole(variable, verify);
}

await withRole('DATABASE_URL', async (db) => {
  await verifyMigrations(db);
  await verifyApplicationRole(db);
  const ledger = new LedgerStore(db, clock);
  const cards = new CardPaymentStore(db, clock);
  if (phase === 'seed') await seed(ledger, cards);
  const saved = await ledger.snapshot(userId);
  verifyBackupState(saved);
  await checkLedger(db, 4, 70);
  if (phase === 'seed') {
    console.log('Source verified: captured 100, refunded 30, pending authorization 75, settlement 70 TEST_KRW.');
    return;
  }

  await verifyServiceRoles();
  await ledger.creditSandbox(credit);
  for (const event of events) await cards.apply(event);
  assert.deepEqual(await ledger.snapshot(userId), saved);
  await checkLedger(db, 4, 70);

  // Final capture consumes 42 principal and 8 reward units. Release the other 25.
  const receipt = await cards.apply(finishHold);
  assert.equal(receipt.payment.status, 'captured');
  assert.equal(receipt.payment.capturedWon, 50);
  assert.equal(receipt.payment.releasedWon, 25);
  assert.deepEqual(await cards.apply(finishHold), receipt);
  const after = await ledger.snapshot(userId);
  assert.equal(after.balanceWon, 916);
  assert.equal(after.heldBalanceWon, 0);
  assert.equal(after.rewards.availableWon, 4);
  assert.equal(after.rewards.heldWon, 0);
  await checkLedger(db, 5, 120);
  console.log('Restored balances, roles and replay verified. Captured 50 of 75; released 25; settlement 120 TEST_KRW.');
});
