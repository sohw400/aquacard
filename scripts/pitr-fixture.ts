import assert from 'node:assert/strict';
import type { SandboxCardEvent } from '../shared/api';
import { CardPaymentStore } from '../server/card-payments';
import { Database } from '../server/database';
import { IssuerOutboxStore } from '../server/issuer-outbox';
import { LedgerStore } from '../server/ledger';
import { verifyMigrations } from '../server/migrations';
import {
  verifyApplicationRole, verifyAuthMailRole, verifyCardDispatcherRole, verifyCardIngressRole,
  verifyCardOperationsRole, verifyCardWorkerRole, verifyMonitorRole,
} from '../server/permissions';
import { reconcileRewards } from '../server/reward-reconciliation';
import { approveTestCustomer } from '../server/test-customer-access';

const phase = process.argv[2];
assert.ok(process.argv.length === 3 && ['seed', 'before', 'after', 'verify'].includes(phase), 'Usage: pitr-fixture.ts seed|before|after|verify');
assert.ok(process.env.NODE_ENV === 'test' && process.env.DATABASE_SCHEMA === 'aqua', 'Requires the disposable test environment.');

const databaseName = 'aqua_pitr_drill';
function drillUrl(variable: string, user: string): URL {
  const raw = process.env[variable];
  assert.ok(raw && URL.canParse(raw), `Missing or invalid ${variable}.`);
  const url = new URL(raw);
  assert.ok(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.port &&
    url.pathname === '/' + databaseName && url.username === user && !url.search && !url.hash,
  `Expected the restricted local PITR drill URL for ${variable}.`);
  return url;
}

const application = drillUrl('DATABASE_URL', 'aqua_app');
async function withRole(variable: string, user: string, work: (db: Database) => Promise<void>) {
  const url = drillUrl(variable, user);
  assert.equal(url.host, application.host, 'All roles must connect to the same drill cluster.');
  const db = new Database({ connectionString: url.toString(), schema: 'aqua', maxConnections: 1 });
  try {
    const identity = await db.query('SELECT current_database() AS db, current_user AS role, current_schema() AS schema, pg_is_in_recovery() AS recovering');
    assert.deepEqual(identity.rows, [{ db: databaseName, role: user, schema: 'aqua', recovering: false }]);
    await work(db);
  } finally { await db.close(); }
}

const userId = 'pitr-member';
const purchase = { userId, paymentId: 'pitr-purchase' };
const authorized: SandboxCardEvent = { ...purchase, kind: 'authorize', eventId: 'original-auth', amountWon: 100, merchantName: '복구 시험 서점' };
const captured: SandboxCardEvent = { ...purchase, kind: 'capture', eventId: 'before-capture', amountWon: 80, finalCapture: true };
const refunded: SandboxCardEvent = { ...purchase, kind: 'refund', eventId: 'before-refund', amountWon: 30 };
const lateRefund: SandboxCardEvent = { ...purchase, kind: 'refund', eventId: 'after-refund', amountWon: 10 };
const lateHold: SandboxCardEvent = { userId, paymentId: 'pitr-late-purchase', kind: 'authorize', eventId: 'after-auth', amountWon: 20, merchantName: '복구 시험 식당' };
const resumed: SandboxCardEvent = { ...purchase, kind: 'refund', eventId: 'restored-refund', amountWon: 5 };
const atTarget = [authorized, captured, refunded];
const clock = { now: () => Date.UTC(2026, 10, 26) }; // Synthetic business date; PostgreSQL supplies the actual WAL commit times.

async function checkState(db: Database, events: SandboxCardEvent[], available: number, held: number, settlement: number) {
  const snapshot = await new LedgerStore(db, clock).snapshot(userId);
  assert.equal(snapshot.access.canTransact, true);
  assert.equal(snapshot.balanceWon, available);
  assert.equal(snapshot.heldBalanceWon, held);
  assert.deepEqual(snapshot.cardPayments.map((p) => p.id).sort(), [...new Set(events.map((e) => e.paymentId))].sort());
  const recorded = await db.query<{ event_id: string }>('SELECT event_id FROM card_payment_events');
  assert.deepEqual(recorded.rows.map((row) => row.event_id).sort(), events.map((event) => event.eventId).sort());
  const balance = await db.query("SELECT balance_won FROM ledger_accounts WHERE id = 'system:card_settlement'");
  assert.deepEqual(balance.rows, [{ balance_won: String(settlement) }]);
  const report = await reconcileRewards(db);
  assert.equal(report.findingCount, '0');
  return snapshot;
}

await withRole('DATABASE_URL', 'aqua_app', async (db) => {
  await verifyMigrations(db);
  await verifyApplicationRole(db);
  const ledger = new LedgerStore(db, clock);
  const cards = new CardPaymentStore(db, clock);

  switch (phase) {
    case 'seed':
      await ledger.createUser({ id: userId, email: 'pitr@example.test', name: '복구 시험', tag: 'pitr',
        passwordHash: 'synthetic-test-only', createdAt: clock.now() });
      await withRole('MIGRATION_DATABASE_URL', 'aqua', async (owner) => {
        await approveTestCustomer(owner, userId);
        await new IssuerOutboxStore(owner, clock).register({ userId, providerCardId: 'sandbox-card-pitr', initialStatus: 'active' });
      });
      await ledger.creditSandbox({ userId, amountWon: 1_000, idempotencyKey: 'pitr-credit' });
      await cards.apply(authorized);
      await checkState(db, [authorized], 900, 100, 0);
      break;
    case 'before':
      await cards.apply(captured);
      await cards.apply(refunded);
      await checkState(db, atTarget, 950, 0, 50);
      console.log('Before target: captured 80, refunded 30, settlement 50 TEST_KRW.');
      break;
    case 'after':
      await cards.apply(lateRefund);
      await cards.apply(lateHold);
      await checkState(db, [...atTarget, lateRefund, lateHold], 940, 20, 40);
      console.log('After target on source: two additional events committed, available 940, held 20, settlement 40 TEST_KRW.');
      break;
    case 'verify': {
      const restored = await checkState(db, atTarget, 950, 0, 50);
      for (const [variable, user, verify] of [
        ['INGRESS_DATABASE_URL', 'aqua_ingress', verifyCardIngressRole],
        ['WORKER_DATABASE_URL', 'aqua_worker', verifyCardWorkerRole],
        ['DISPATCHER_DATABASE_URL', 'aqua_dispatcher', verifyCardDispatcherRole],
        ['OPERATIONS_DATABASE_URL', 'aqua_operations', verifyCardOperationsRole],
        ['AUTH_MAIL_DATABASE_URL', 'aqua_auth_mail', verifyAuthMailRole],
        ['MONITOR_DATABASE_URL', 'aqua_monitor', verifyMonitorRole],
      ] as const) await withRole(variable, user, verify);

      for (const event of atTarget) await cards.apply(event);
      assert.deepEqual(await ledger.snapshot(userId), restored);
      const first = await cards.apply(resumed);
      assert.equal(first.payment.refundedWon, 35);
      assert.deepEqual(await cards.apply(resumed), first);
      await checkState(db, [...atTarget, resumed], 955, 0, 45);
      console.log('Recovered target: 3 original events, 950 available, no later refund or hold. New refund of 5 replayed; settlement 45 TEST_KRW.');
    }
  }
});
