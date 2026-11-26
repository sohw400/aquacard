import assert from 'node:assert/strict';
import test from 'node:test';
import type { SandboxCardEvent } from '../shared/api';
import { CardPaymentStore } from './card-payments';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerStore } from './ledger';
import { reconcileRewards } from './reward-reconciliation';
import { approveTestCustomer } from './test-customer-access';
import { createTestDatabase } from './test-support';

test('concurrent customer card purchases conserve settlement and replay refunds under load', async (t) => {
  const fixture = await createTestDatabase();
  t.after(fixture.cleanup);
  const { database } = fixture;
  const ledger = new LedgerStore(database);
  const issuer = new IssuerOutboxStore(database);
  const cards = new CardPaymentStore(database);
  const members = Array.from({ length: 8 }, (_, index) => `load${index}`);
  const purchases = 4;
  const funding = 5_000;
  for (const id of members) {
    await ledger.createUser({ id, tag: id, email: `${id}@example.test`, name: id,
      passwordHash: 'synthetic-test-only', createdAt: Date.now() });
    await approveTestCustomer(database, id);
    await issuer.register({ userId: id, providerCardId: `sandbox-card-${id}`, initialStatus: 'active' });
    await ledger.creditSandbox({ userId: id, amountWon: funding, idempotencyKey: `fund-${id}` });
  }

  const latencies: number[] = [];
  async function apply(event: SandboxCardEvent) {
    const start = performance.now();
    const receipt = await cards.apply(event);
    latencies.push(performance.now() - start);
    return receipt;
  }
  const started = performance.now();
  const completed = await Promise.allSettled(members.map(async (userId) => {
    for (let index = 0; index < purchases; index++) {
      const paymentId = `${userId}-purchase-${index}`;
      const key = { paymentId, userId };
      await apply({ ...key, kind: 'authorize', eventId: paymentId + '-auth', amountWon: 120, merchantName: '테스트 가맹점' });
      await apply({ ...key, kind: 'capture', eventId: paymentId + '-capture', amountWon: 100, finalCapture: true });
      const refund: SandboxCardEvent = { ...key, kind: 'refund', eventId: paymentId + '-refund', amountWon: 30 };
      const first = await apply(refund);
      assert.deepEqual(await apply(refund), first);
    }
  }));
  const elapsedMs = Math.round(performance.now() - started);
  for (const result of completed) if (result.status === 'rejected') throw result.reason;
  const payments = members.length * purchases;
  const netPerPurchase = 70;
  for (const member of members) {
    const account = await ledger.snapshot(member);
    assert.equal(account.balanceWon, funding - purchases * netPerPurchase);
    assert.equal(account.heldBalanceWon, 0);
    assert.equal(account.cardPayments.length, purchases);
  }
  const settlement = await database.query("SELECT balance_won FROM ledger_accounts WHERE id = 'system:card_settlement'");
  assert.equal(settlement.rows[0].balance_won, String(payments * netPerPurchase));
  const report = await reconcileRewards(database);
  assert.equal(report.counts.cardPayments, String(payments));
  assert.equal(report.counts.cardPaymentEvents, String(3 * payments));
  assert.equal(report.findingCount, '0');

  latencies.sort((a, b) => a - b);
  const p95Ms = Math.ceil(latencies[Math.ceil(latencies.length * 0.95) - 1]);
  t.diagnostic(`Concurrent customers ${members.length}, commands ${latencies.length}, elapsed ${elapsedMs} ms, p95 ${p95Ms} ms (store call including replay).`);
});
