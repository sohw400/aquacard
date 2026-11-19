import { approveTestCustomer } from './test-customer-access';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from './database';
import { LedgerError, LedgerStore } from './ledger';
import { CardPaymentStore } from './card-payments';
import { IssuerOutboxStore } from './issuer-outbox';
import { RewardsStore } from './rewards';
import { createTestDatabase } from './test-support';
import type { CardEventResult, CardPaymentRecord, RewardsSnapshot, SandboxCardEvent } from '../shared/api';

const NOW = Date.UTC(2026, 10, 19, 3);
const DAY = 86_400_000;

async function fixture(t: TestContext, initial = NOW) {
  const base = await createTestDatabase();
  let now = initial;
  let sequence = 0;
  const peers: Database[] = [];
  const options = { now: () => now };
  const stores = (database: Database) => ({ database, ledger: new LedgerStore(database, options), cards: new CardPaymentStore(database, options), rewards: new RewardsStore(database, options) });
  const main = stores(base.database);
  for (const id of ['alice', 'bobby']) {
    await main.ledger.createUser({ id, email: `${id}@example.test`, name: `${id} 회원`, tag: id, passwordHash: 'test-only', createdAt: NOW - 60 * DAY });
    await approveTestCustomer(main.ledger.database, id);
    await new IssuerOutboxStore(base.database, options).register({ userId: id, providerCardId: `sandbox-card-${id}`, initialStatus: 'active' });
  }
  t.after(async () => { try { await Promise.all(peers.map((database) => database.close())); } finally { await base.cleanup(); } });
  const key = (prefix: string) => `${prefix}-${++sequence}`;
  return {
    ...main, key,
    setTime(value: number) { now = value; },
    peer() { const database = new Database({ connectionString: base.connectionString, schema: base.schema, maxConnections: 3 }); peers.push(database); return stores(database); },
    async activate(amountWon = 50_000) {
      await main.rewards.fundBudget({ amountWon, idempotencyKey: key('budget') });
      await main.rewards.setProgram({ enabled: true, idempotencyKey: key('enable') });
    },
    fund(amountWon: number, userId = 'alice') { return main.ledger.creditSandbox({ userId, amountWon, idempotencyKey: key('principal') }); },
    grant(amountWon: number, userId = 'alice') { return main.rewards.grant({ userId, amountWon, idempotencyKey: key('grant') }); },
    async preference(useFirst: boolean, userId = 'alice') {
      const current = await main.rewards.snapshot(userId);
      return main.rewards.setPreference({ userId, useFirst, expectedVersion: current.preferenceVersion, idempotencyKey: key('preference') });
    },
  };
}

function authorize(paymentId: string, amountWon: number, userId = 'alice'): SandboxCardEvent {
  return { kind: 'authorize', eventId: `authorize-${paymentId}`, paymentId, userId, amountWon, merchantName: '리워드 검증 가맹점' };
}
function capture(paymentId: string, amountWon: number, finalCapture = true, eventId = `capture-${paymentId}`, userId = 'alice'): SandboxCardEvent {
  return { kind: 'capture', eventId, paymentId, userId, amountWon, finalCapture };
}
function reverse(paymentId: string, eventId = `reverse-${paymentId}`, userId = 'alice'): SandboxCardEvent {
  return { kind: 'reverse', eventId, paymentId, userId };
}
function refund(paymentId: string, amountWon: number, eventId = `refund-${paymentId}`, userId = 'alice'): SandboxCardEvent {
  return { kind: 'refund', eventId, paymentId, userId, amountWon };
}
async function failure(action: () => Promise<unknown>, allowed: number[] = [409]) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof LedgerError, '업무상 거절은 정규화한 LedgerError여야 한다');
    assert.ok(allowed.includes(error.status), `예상하지 않은 상태 ${error.status}`);
    return true;
  });
}
function funded(result: CardEventResult) {
  assert.ok(result.payment.funding, '새 리워드 정책의 결제는 승인 재원 구성을 보존해야 한다');
  return result.payment.funding;
}
function cashback(payment: CardPaymentRecord) {
  assert.ok(payment.cashback, '활성 정책의 페이백 스냅샷이 필요하다');
  return payment.cashback;
}
async function settlement(database: Database): Promise<bigint> {
  const row = (await database.query('SELECT balance_won FROM ledger_accounts WHERE id = $1', ['system:card_settlement'])).rows[0];
  return BigInt(row.balance_won);
}
async function companyCash(database: Database): Promise<bigint> {
  const result = await database.query(`SELECT COALESCE(SUM(balance_won), 0)::text AS total FROM ledger_accounts
    WHERE id = ANY($1::text[])`, [['system:reward_budget', 'system:reward_backing', 'system:reward_cashback_reserved']]);
  return BigInt(result.rows[0].total);
}
async function assertRewardHistory(database: Database, snapshot: RewardsSnapshot, userId = 'alice') {
  // The public history is paginated. Reconcile the complete immutable journal instead.
  const { rows: [totals] } = await database.query(`SELECT
    COALESCE(SUM(available_delta_won), 0)::text AS available,
    COALESCE(SUM(held_delta_won), 0)::text AS held,
    COALESCE(SUM(adjustment_delta_won), 0)::text AS adjustment
    FROM reward_journals WHERE user_id = $1`, [userId]);
  assert.equal(BigInt(totals.available), BigInt(snapshot.availableWon));
  assert.equal(BigInt(totals.held), BigInt(snapshot.heldWon));
  assert.equal(BigInt(totals.adjustment), BigInt(snapshot.adjustmentDueWon));
  const entries = await database.query(`SELECT journal_id, currency, SUM(amount_won)::text AS net
    FROM reward_entries GROUP BY journal_id, currency`);
  for (const row of entries.rows) { assert.equal(row.currency, 'TEST_AQUA_REWARD'); assert.equal(BigInt(row.net), 0n); }
}
async function assertMoneyBalanced(database: Database) {
  const journals = await database.query('SELECT journal_id, currency, SUM(amount_won)::text AS net FROM journal_entries GROUP BY journal_id, currency');
  for (const row of journals.rows) { assert.equal(row.currency, 'TEST_KRW'); assert.equal(BigInt(row.net), 0n); }
  const accounts = await database.query('SELECT SUM(balance_won)::text AS total FROM ledger_accounts');
  assert.equal(BigInt(accounts.rows[0].total), 0n);
}
async function makeDebt100(f: Awaited<ReturnType<typeof fixture>>) {
  await f.activate(); await f.fund(10_000);
  await f.cards.apply(authorize('debt-origin', 10_000));
  await f.cards.apply(capture('debt-origin', 10_000));
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 100);
  await f.cards.apply(authorize('spent-origin-cashback', 100));
  await f.cards.apply(capture('spent-origin-cashback', 100));
  await f.cards.apply(refund('debt-origin', 10_000));
  const rewards = await f.rewards.snapshot('alice');
  assert.equal(rewards.availableWon, 0);
  assert.equal(rewards.adjustmentDueWon, 100);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 10_000);
}

test('같은 예산·리워드 발행 요청이 두 연결에서 겹쳐도 한 번만 전기되고 중지 후에도 최초 응답을 재생한다', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const peer = f.peer();
  const budgetInput = { amountWon: 1_000, idempotencyKey: 'identical-budget' };
  const fundedResults = await Promise.all([f.rewards.fundBudget(budgetInput), peer.rewards.fundBudget(budgetInput)]);
  assert.deepEqual(fundedResults[0], fundedResults[1]);
  assert.equal(await companyCash(f.database), 1_000n);
  await f.rewards.setProgram({ enabled: true, idempotencyKey: 'enable-idempotent-program' });
  const grantInput = { userId: 'alice', amountWon: 700, idempotencyKey: 'identical-grant' };
  const grants = await Promise.all([f.rewards.grant(grantInput), peer.rewards.grant(grantInput)]);
  assert.deepEqual(grants[0], grants[1]);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 700);
  assert.equal(await companyCash(f.database), 1_000n);
  const commands = await f.database.query("SELECT kind, COUNT(*)::int AS count FROM reward_commands WHERE kind IN ('fund_budget','grant') GROUP BY kind ORDER BY kind");
  assert.deepEqual(commands.rows, [{ kind: 'fund_budget', count: 1 }, { kind: 'grant', count: 1 }]);
  const cash = await f.database.query("SELECT COUNT(*)::int AS count FROM journals WHERE kind='reward_funding'");
  assert.equal(cash.rows[0].count, 2, '예산 충전과 리워드 뒷받침에 현금 전기가 각각 하나여야 한다');
  const pointGrants = await f.database.query("SELECT COUNT(*)::int AS count FROM reward_journals WHERE kind='grant'");
  assert.equal(pointGrants.rows[0].count, 1);
  await f.rewards.setProgram({ enabled: false, idempotencyKey: 'disable-idempotent-program' });
  await failure(() => f.rewards.grant({ userId: 'alice', amountWon: 1, idempotencyKey: 'new-grant-while-disabled' }));
  assert.deepEqual(await peer.rewards.grant(grantInput), grants[0]);
  assert.deepEqual(await peer.rewards.fundBudget(budgetInput), fundedResults[0]);
  const snapshot = await f.rewards.snapshot('alice');
  assert.equal(snapshot.availableWon, 700);
  assert.equal(snapshot.programActive, false);
  await assertRewardHistory(f.database, snapshot);
  await assertMoneyBalanced(f.database);
});

test('프로그램은 기본 비활성이며 이전 현금 승인에는 나중에 프로그램을 켜도 페이백이 생기지 않는다', async (t) => {
  const f = await fixture(t);
  const initial = await f.rewards.snapshot('alice');
  assert.equal(initial.programActive, false);
  assert.equal(initial.availableWon, 0);
  assert.equal(initial.heldWon, 0);
  assert.equal(initial.adjustmentDueWon, 0);
  await f.fund(20_000);
  await f.rewards.fundBudget({ amountWon: 10_000, idempotencyKey: 'inactive-budget' });
  const legacy = authorize('legacy-before-enable', 10_000);
  const original = await f.cards.apply(legacy);
  await f.rewards.setProgram({ enabled: true, idempotencyKey: 'later-enable' });
  const closed = await f.cards.apply(capture('legacy-before-enable', 10_000));
  assert.equal(closed.payment.cashback?.awardedWon ?? 0, 0);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 0);
  assert.deepEqual(await f.peer().cards.apply(legacy), original);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 10_000);
});

test('리워드 3000과 원금 7000의 결제는 가맹점에 10000을 반영하고 페이백 70만 별도 발행한다', async (t) => {
  const f = await fixture(t);
  await f.activate(10_000); await f.fund(7_000); await f.grant(3_000);
  const approved = await f.cards.apply(authorize('mixed-funding', 10_000));
  assert.equal(funded(approved).principal.authorizedWon, 7_000);
  assert.equal(funded(approved).rewards.authorizedWon, 3_000);
  const pending = await f.ledger.snapshot('alice');
  assert.deepEqual([pending.balanceWon, pending.heldBalanceWon, pending.totalBalanceWon], [0, 7_000, 7_000]);
  assert.deepEqual([pending.rewards.availableWon, pending.rewards.heldWon], [0, 3_000]);
  assert.equal(pending.rewards.cashback.pendingWon, 70);
  const closed = await f.cards.apply(capture('mixed-funding', 10_000));
  assert.equal(cashback(closed.payment).awardedWon, 70);
  const current = await f.ledger.snapshot('alice');
  assert.deepEqual([current.balanceWon, current.heldBalanceWon, current.totalBalanceWon], [0, 0, 0]);
  assert.deepEqual([current.rewards.availableWon, current.rewards.heldWon], [70, 0]);
  assert.equal(await settlement(f.database), 10_000n);
  assert.equal(await companyCash(f.database), 7_000n, '리워드 사용분 3000은 고객 원금 추가 차감 대신 회사 현금에서 지급한다');
  assert.equal(current.rewards.cashback.confirmedWon, 70);
  await assertRewardHistory(f.database, current.rewards);
  await assertMoneyBalanced(f.database);
});

test('리워드는 회원 송금용 원금이 아니며 리워드 전용 결제에는 다시 페이백이 붙지 않는다', async (t) => {
  const f = await fixture(t);
  await f.activate(2_000); await f.grant(1_000);
  await failure(() => f.ledger.transfer({ senderId: 'alice', recipientTag: 'bobby', amountWon: 1_000, idempotencyKey: 'no-reward-transfer' }));
  assert.equal((await f.ledger.snapshot('bobby')).balanceWon, 0);
  const approved = await f.cards.apply(authorize('rewards-only', 1_000));
  assert.equal(funded(approved).principal.authorizedWon, 0);
  assert.equal(funded(approved).rewards.authorizedWon, 1_000);
  const closed = await f.cards.apply(capture('rewards-only', 1_000));
  assert.equal(cashback(closed.payment).awardedWon, 0);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 0);
  assert.equal((await f.ledger.snapshot('alice')).totalBalanceWon, 0);
  assert.equal(await settlement(f.database), 1_000n);
  assert.equal(await companyCash(f.database), 1_000n);
  await assertMoneyBalanced(f.database);
});

test('승인 후 설정과 사용 가능 리워드가 바뀌어도 원래 보류한 재원을 다시 배분하지 않는다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(7_000); await f.grant(3_000);
  await f.cards.apply(authorize('frozen-sources', 10_000));
  await f.preference(false);
  await f.grant(500);
  const closed = await f.cards.apply(capture('frozen-sources', 10_000));
  assert.equal(funded(closed).principal.capturedWon, 7_000);
  assert.equal(funded(closed).rewards.capturedWon, 3_000);
  assert.equal(cashback(closed.payment).awardedWon, 70);
  const rewards = await f.rewards.snapshot('alice');
  assert.equal(rewards.useFirst, false);
  assert.equal(rewards.availableWon, 570);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 0);
  await assertRewardHistory(f.database, rewards);
  await f.cards.apply(refund('frozen-sources', 10_000));
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 3_500, '사용을 꺼도 원래 리워드와 추가 지급분을 원금으로 바꾸지 않는다');
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 7_000);
});

test('리워드 우선 사용을 끄고 승인한 결제는 나중에 켜도 원금 결제로 확정된다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(10_000); await f.grant(3_000);
  await f.preference(false);
  await f.cards.apply(authorize('frozen-principal-only', 10_000));
  await f.preference(true);
  const closed = await f.cards.apply(capture('frozen-principal-only', 10_000));
  assert.equal(funded(closed).principal.capturedWon, 10_000);
  assert.equal(funded(closed).rewards.capturedWon, 0);
  assert.equal(cashback(closed.payment).awardedWon, 100);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 3_100);
});

test('201원 승인에 리워드 101원과 원금 100원을 보류하면 부분 매입의 누적 분배가 고정된다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(100); await f.grant(101);
  await f.cards.apply(authorize('fractional-captures', 201));
  const first = await f.cards.apply(capture('fractional-captures', 100, false, 'fractional-capture-one'));
  assert.deepEqual([funded(first).rewards.capturedWon, funded(first).principal.capturedWon], [50, 50]);
  assert.deepEqual([funded(first).rewards.heldWon, funded(first).principal.heldWon], [51, 50]);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 0, '잔여 보류가 있으면 페이백은 아직 쓸 수 없다');
  const last = await f.cards.apply(capture('fractional-captures', 101, true, 'fractional-capture-final'));
  assert.deepEqual([funded(last).rewards.capturedWon, funded(last).principal.capturedWon], [101, 100]);
  assert.equal(cashback(last.payment).awardedWon, 1);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 1);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 0);
  await assertMoneyBalanced(f.database);
});

test('큰 NUMERIC 나눗셈이 반올림되는 경우에도 4503599627370496원 리워드의 정확한 몫을 사용한다', async (t) => {
  const f = await fixture(t);
  await f.activate(4_503_599_627_370_496);
  await f.fund(4_503_599_627_370_495); await f.grant(4_503_599_627_370_496);
  await f.rewards.setProgram({ enabled: false, idempotencyKey: 'isolate-exact-division' });
  await f.cards.apply(authorize('numeric-division-boundary', 9_007_199_254_740_991));
  // Exact quotient is ...494 with a remainder very close to the denominator.
  // PostgreSQL NUMERIC division may round it to ...495 before floor is applied.
  const partial = await f.cards.apply(capture('numeric-division-boundary', 9_007_199_254_740_989, false, 'numeric-boundary-capture'));
  assert.deepEqual([funded(partial).rewards.capturedWon, funded(partial).principal.capturedWon], [4_503_599_627_370_494, 4_503_599_627_370_495]);
  assert.deepEqual([funded(partial).rewards.heldWon, funded(partial).principal.heldWon], [2, 0]);
  await f.cards.apply(reverse('numeric-division-boundary'));
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 2);
  const returned = await f.cards.apply(refund('numeric-division-boundary', 9_007_199_254_740_989, 'numeric-boundary-refund'));
  assert.deepEqual([funded(returned).rewards.refundedWon, funded(returned).principal.refundedWon], [4_503_599_627_370_494, 4_503_599_627_370_495]);
  const restored = await f.ledger.snapshot('alice');
  assert.equal(restored.balanceWon, 4_503_599_627_370_495);
  assert.equal(restored.rewards.availableWon, 4_503_599_627_370_496);
  assert.equal(restored.rewards.adjustmentDueWon, 0);
  await assertRewardHistory(f.database, restored.rewards);
  await assertMoneyBalanced(f.database);
});

test('최대 안전 정수 승인도 큰 곱셈의 나머지를 잃지 않고 매입·환불 재원을 끝까지 보존한다', async (t) => {
  const f = await fixture(t);
  const authorized = 9_007_199_254_740_991;
  const reward = 4_503_599_627_370_495;
  const principal = 4_503_599_627_370_496;
  await f.activate(4_503_599_627_380_495);
  await f.fund(principal); await f.grant(reward);
  const approved = await f.cards.apply(authorize('safe-integer-split', authorized));
  assert.deepEqual([funded(approved).rewards.authorizedWon, funded(approved).principal.authorizedWon], [reward, principal]);
  assert.equal(cashback(approved.payment).pendingWon, 10_000);
  const almost = await f.cards.apply(capture('safe-integer-split', 9_007_199_254_740_989, false, 'safe-capture-almost'));
  assert.deepEqual([funded(almost).rewards.capturedWon, funded(almost).principal.capturedWon], [4_503_599_627_370_494, 4_503_599_627_370_495]);
  assert.deepEqual([funded(almost).rewards.heldWon, funded(almost).principal.heldWon], [1, 1]);
  const closed = await f.cards.apply(capture('safe-integer-split', 2, true, 'safe-capture-final'));
  assert.deepEqual([funded(closed).rewards.capturedWon, funded(closed).principal.capturedWon], [reward, principal]);
  assert.equal(cashback(closed.payment).awardedWon, 10_000);
  const partial = await f.cards.apply(refund('safe-integer-split', 9_007_199_254_740_989, 'safe-refund-almost'));
  assert.deepEqual([funded(partial).rewards.refundedWon, funded(partial).principal.refundedWon], [4_503_599_627_370_494, 4_503_599_627_370_495]);
  assert.equal(cashback(partial.payment).reversedWon, 9_999);
  await f.cards.apply(refund('safe-integer-split', 2, 'safe-refund-final'));
  const restored = await f.ledger.snapshot('alice');
  assert.equal(restored.balanceWon, principal);
  assert.equal(restored.rewards.availableWon, reward);
  assert.equal(restored.rewards.adjustmentDueWon, 0);
  assert.equal(restored.rewards.cashback.confirmedWon, 0);
  await assertRewardHistory(f.database, restored.rewards);
  await assertMoneyBalanced(f.database);
});

test('100원·100원·1원 환불의 리워드 증분은 50·50·1이고 원금 증분은 50·50·0이다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(100); await f.grant(101);
  await f.cards.apply(authorize('fractional-refunds', 201));
  await f.cards.apply(capture('fractional-refunds', 201));
  const checkpoints = [
    { amount: 100, rewardRefund: 50, principalRefund: 50, reversed: 0, available: 51 },
    { amount: 100, rewardRefund: 100, principalRefund: 100, reversed: 1, available: 100 },
    { amount: 1, rewardRefund: 101, principalRefund: 100, reversed: 1, available: 101 },
  ];
  for (const [index, checkpoint] of checkpoints.entries()) {
    const event = refund('fractional-refunds', checkpoint.amount, `fractional-refund-${index}`);
    const result = await f.cards.apply(event);
    assert.equal(funded(result).rewards.refundedWon, checkpoint.rewardRefund);
    assert.equal(funded(result).principal.refundedWon, checkpoint.principalRefund);
    assert.equal(cashback(result.payment).reversedWon, checkpoint.reversed);
    assert.equal((await f.rewards.snapshot('alice')).availableWon, checkpoint.available);
    assert.equal((await f.ledger.snapshot('alice')).balanceWon, checkpoint.principalRefund);
    const before = await f.rewards.snapshot('alice');
    assert.deepEqual(await f.peer().cards.apply(event), result);
    assert.deepEqual(await f.rewards.snapshot('alice'), before);
  }
  assert.equal((await f.rewards.snapshot('alice')).cashback.confirmedWon, 0);
  await assertRewardHistory(f.database, await f.rewards.snapshot('alice'));
  await assertMoneyBalanced(f.database);
});

test('환불 뒤 매입액이 늘어도 환불 재원의 분모는 최초 승인액이며 이전 복원액이 줄지 않는다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(2); await f.grant(3);
  await f.cards.apply(authorize('fixed-denominator', 5));
  const first = await f.cards.apply(capture('fixed-denominator', 2, false, 'small-capture-one'));
  assert.deepEqual([funded(first).rewards.capturedWon, funded(first).principal.capturedWon], [1, 1]);
  const returned = await f.cards.apply(refund('fixed-denominator', 2));
  assert.deepEqual([funded(returned).rewards.refundedWon, funded(returned).principal.refundedWon], [1, 1]);
  const closed = await f.cards.apply(capture('fixed-denominator', 1, true, 'small-capture-final'));
  assert.deepEqual([funded(closed).rewards.capturedWon, funded(closed).principal.capturedWon], [1, 2]);
  assert.deepEqual([funded(closed).rewards.refundedWon, funded(closed).principal.refundedWon], [1, 1]);
  assert.equal(funded(closed).rewards.releasedWon, 2);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 3);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 1);
  assert.equal(cashback(closed.payment).awardedWon, 0);
  await assertRewardHistory(f.database, await f.rewards.snapshot('alice'));
});

test('확정 전 환불을 뺀 원금 7200원을 기준으로 72원을 지급하고 이후 환불 1000원에는 8원만 회수한다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(8_000); await f.grant(2_000);
  await f.cards.apply(authorize('closure-baseline', 10_000));
  await f.cards.apply(capture('closure-baseline', 5_000, false, 'baseline-first-capture'));
  await f.cards.apply(refund('closure-baseline', 1_000, 'baseline-early-refund'));
  const beforeClose = await f.rewards.snapshot('alice');
  assert.equal(beforeClose.availableWon, 200);
  assert.equal(beforeClose.cashback.confirmedWon, 0);
  const closed = await f.cards.apply(capture('closure-baseline', 5_000, true, 'baseline-final-capture'));
  assert.equal(cashback(closed.payment).awardedWon, 72);
  assert.equal(cashback(closed.payment).reversedWon, 0);
  assert.equal(cashback(closed.payment).pendingWon, 0);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 272);
  const after = await f.cards.apply(refund('closure-baseline', 1_000, 'baseline-later-refund'));
  assert.equal(funded(after).principal.refundedWon, 1_600);
  assert.equal(cashback(after.payment).awardedWon, 72);
  assert.equal(cashback(after.payment).reversedWon, 8);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 464);
  assert.equal((await f.rewards.snapshot('alice')).cashback.confirmedWon, 64);
  await f.cards.apply(refund('closure-baseline', 8_000, 'baseline-final-refund'));
  const final = await f.ledger.snapshot('alice');
  assert.equal(final.balanceWon, 8_000);
  assert.equal(final.rewards.availableWon, 2_000);
  assert.equal(final.rewards.adjustmentDueWon, 0);
  assert.equal(final.rewards.cashback.confirmedWon, 0);
  await assertRewardHistory(f.database, final.rewards);
  await assertMoneyBalanced(f.database);
});

test('1원씩 100회 매입해도 종결 때 페이백 1원을 한 번만 지급한다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(100);
  await f.cards.apply(authorize('many-tiny-captures', 100));
  for (let index = 1; index < 100; index += 1) {
    await f.cards.apply(capture('many-tiny-captures', 1, false, `tiny-capture-${index}`));
  }
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 0);
  const finalEvent = capture('many-tiny-captures', 1, true, 'tiny-capture-final');
  const completed = await f.cards.apply(finalEvent);
  assert.equal(cashback(completed.payment).awardedWon, 1);
  assert.deepEqual(await f.peer().cards.apply(finalEvent), completed);
  const snapshot = await f.rewards.snapshot('alice');
  assert.equal(snapshot.availableWon, 1);
  assert.equal(snapshot.history.filter((entry) => entry.kind === 'cashback').length, 1);
  await assertRewardHistory(f.database, snapshot);
});

test('부분 매입 후 취소도 보류 종결 시점의 실제 원금에만 페이백을 지급한다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(10_000);
  await f.cards.apply(authorize('reverse-closes-cashback', 10_000));
  await f.cards.apply(capture('reverse-closes-cashback', 4_000, false));
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 0);
  const closed = await f.cards.apply(reverse('reverse-closes-cashback'));
  assert.equal(closed.payment.status, 'captured');
  assert.equal(cashback(closed.payment).awardedWon, 40);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 40);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 6_000);
  assert.equal((await f.rewards.snapshot('alice')).cashback.pendingWon, 0);
});

test('동시 부분 매입은 페이백을 한 번 확정하고 동시 환불은 같은 66원을 두 번 회수하지 않는다', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(6_667); await f.grant(3_333);
  await f.cards.apply(authorize('concurrent-close-refund', 10_000));
  const peer = f.peer();
  const events = [
    capture('concurrent-close-refund', 5_000, false, 'concurrent-capture-one'),
    capture('concurrent-close-refund', 5_000, false, 'concurrent-capture-two'),
  ];
  const captures = await Promise.all([f.cards.apply(events[0]), peer.cards.apply(events[1])]);
  assert.deepEqual(captures.map((result) => result.payment.capturedWon).sort((a, b) => a - b), [5_000, 10_000]);
  const closed = (await f.ledger.snapshot('alice')).cardPayments.find((payment) => payment.id === 'concurrent-close-refund')!;
  assert.equal(cashback(closed).awardedWon, 66);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 66);
  await Promise.all([
    f.cards.apply(refund('concurrent-close-refund', 5_000, 'concurrent-refund-one')),
    peer.cards.apply(refund('concurrent-close-refund', 5_000, 'concurrent-refund-two')),
  ]);
  const restored = await f.ledger.snapshot('alice');
  const refunded = restored.cardPayments.find((payment) => payment.id === 'concurrent-close-refund')!;
  assert.equal(cashback(refunded).awardedWon, 66);
  assert.equal(cashback(refunded).reversedWon, 66);
  assert.equal(restored.balanceWon, 6_667);
  assert.equal(restored.rewards.availableWon, 3_333);
  assert.equal(restored.rewards.adjustmentDueWon, 0);
  const awards = await f.database.query("SELECT COUNT(*)::int AS count FROM reward_journals WHERE payment_id=$1 AND kind='cashback'", ['concurrent-close-refund']);
  assert.equal(awards.rows[0].count, 1);
  for (const [index, event] of events.entries()) assert.deepEqual(await peer.cards.apply(event), captures[index], '나중에 환불해도 각 최초 매입 응답을 그대로 재생한다');
  await assertRewardHistory(f.database, restored.rewards);
  await assertMoneyBalanced(f.database);
});

test('월 한도가 100원 남았을 때 동시 승인이 페이백 예산을 100원 이상 예약하지 않는다', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.activate(30_000); await f.fund(1_100_000); await f.preference(false);
  await f.cards.apply(authorize('month-seed-one', 500_000)); await f.cards.apply(capture('month-seed-one', 500_000));
  await f.cards.apply(authorize('month-seed-two', 490_000)); await f.cards.apply(capture('month-seed-two', 490_000));
  assert.equal((await f.rewards.snapshot('alice')).cashback.confirmedWon, 9_900);
  const peer = f.peer();
  const results = await Promise.all([f.cards.apply(authorize('month-race-a', 20_000)), peer.cards.apply(authorize('month-race-b', 20_000))]);
  assert.equal(results.reduce((sum, result) => sum + cashback(result.payment).pendingWon, 0), 100);
  const reserved = await f.rewards.snapshot('alice');
  assert.equal(reserved.cashback.pendingWon, 100);
  assert.equal(reserved.cashback.remainingWon, 0);
  const winner = results.find((result) => cashback(result.payment).pendingWon === 100)!;
  const loser = results.find((result) => cashback(result.payment).pendingWon === 0)!;
  await f.cards.apply(capture(winner.payment.id, 5_000, true));
  await f.cards.apply(capture(loser.payment.id, 20_000, true));
  assert.equal((await f.rewards.snapshot('alice')).cashback.confirmedWon, 9_950);
  assert.equal((await f.rewards.snapshot('alice')).cashback.remainingWon, 50);
  await f.cards.apply(authorize('month-released-slot', 5_000)); await f.cards.apply(capture('month-released-slot', 5_000));
  assert.equal((await f.rewards.snapshot('alice')).cashback.confirmedWon, 10_000);
  assert.equal((await f.rewards.snapshot('alice')).cashback.remainingWon, 0);
  await assertMoneyBalanced(f.database);
});

test('회사 예산 100원은 서로 다른 회원의 동시 페이백 약정으로 중복 배정되지 않는다', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.activate(100); await f.fund(10_000); await f.fund(10_000, 'bobby');
  const peer = f.peer();
  const promised = await Promise.allSettled([f.cards.apply(authorize('budget-alice', 10_000)), peer.cards.apply(authorize('budget-bobby', 10_000, 'bobby'))]);
  assert.equal(promised.filter((result) => result.status === 'fulfilled').length, 1);
  const denied = promised.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(denied.reason instanceof LedgerError);
  assert.equal(denied.reason.status, 503, '회사 예산 부족을 고객 잔액 부족으로 분류하지 않는다');
  assert.equal(denied.reason.code, 'REWARD_BUDGET_UNAVAILABLE');
  const winner = promised.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<CardEventResult>;
  assert.equal(cashback(winner.value.payment).pendingWon, 100);
  const winnerUser = promised[0].status === 'fulfilled' ? 'alice' : 'bobby';
  const loserUser = winnerUser === 'alice' ? 'bobby' : 'alice';
  const untouched = await f.ledger.snapshot(loserUser);
  assert.equal(untouched.balanceWon, 10_000);
  assert.equal(untouched.heldBalanceWon, 0);
  assert.equal(untouched.cardPayments.length, 0, '예산 거절은 부분 승인이나 고객 보류를 남기지 않는다');
  await f.cards.apply(capture(winner.value.payment.id, 10_000, true, `capture-${winner.value.payment.id}`, winnerUser));
  const alice = await f.rewards.snapshot('alice'); const bob = await f.rewards.snapshot('bobby');
  assert.equal(alice.availableWon + bob.availableWon, 100);
  assert.equal(alice.cashback.confirmedWon + bob.cashback.confirmedWon, 100);
  await failure(() => f.grant(1), [503]);
  await assertMoneyBalanced(f.database);
});

test('예산을 전부 뒷받침에 쓴 리워드는 보류·매입을 거쳐도 새 발행 가능 예산으로 되살아나지 않는다', async (t) => {
  const f = await fixture(t);
  await f.activate(1_000); await f.grant(1_000);
  await failure(() => f.grant(1), [503]);
  await f.cards.apply(authorize('backing-fully-held', 1_000));
  await failure(() => f.grant(1), [503]);
  await f.cards.apply(capture('backing-fully-held', 1_000));
  assert.equal(await companyCash(f.database), 0n);
  assert.equal(await settlement(f.database), 1_000n);
  await failure(() => f.grant(1), [503]);
  const snapshot = await f.ledger.snapshot('alice');
  assert.equal(snapshot.totalBalanceWon, 0);
  assert.equal(snapshot.rewards.availableWon, 0);
});

for (const [label, before, after, oldMonth, newMonth] of [
  ['월 경계', Date.UTC(2026, 10, 30, 14, 59, 59, 999), Date.UTC(2026, 10, 30, 15), '2026-11', '2026-12'],
  ['연도 경계', Date.UTC(2026, 11, 31, 14, 59, 59, 999), Date.UTC(2026, 11, 31, 15), '2026-12', '2027-01'],
] as const) test(`한국 ${label} 이후 매입·환불해도 페이백은 원승인월에 남는다`, async (t) => {
  const f = await fixture(t, before);
  await f.activate(); await f.fund(40_000); await f.preference(false);
  await f.cards.apply(authorize('old-month', 10_000));
  assert.equal((await f.rewards.snapshot('alice')).cashback.month, oldMonth);
  f.setTime(after);
  const start = await f.rewards.snapshot('alice');
  assert.equal(start.cashback.month, newMonth);
  assert.equal(start.cashback.pendingWon, 0);
  assert.equal(start.cashback.remainingWon, 10_000);
  const oldClosed = await f.cards.apply(capture('old-month', 10_000));
  assert.equal(cashback(oldClosed.payment).month, oldMonth);
  assert.equal((await f.rewards.snapshot('alice')).cashback.confirmedWon, 0);
  await f.cards.apply(authorize('new-month', 20_000)); await f.cards.apply(capture('new-month', 20_000));
  const currentSummary = (await f.rewards.snapshot('alice')).cashback;
  assert.equal(currentSummary.confirmedWon, 200);
  assert.equal(currentSummary.remainingWon, 9_800);
  await f.cards.apply(refund('old-month', 4_000, 'old-partial-refund'));
  assert.deepEqual((await f.rewards.snapshot('alice')).cashback, currentSummary);
  await f.cards.apply(refund('old-month', 6_000, 'old-final-refund'));
  assert.deepEqual((await f.rewards.snapshot('alice')).cashback, currentSummary);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 200);
});

test('이미 사용한 페이백의 회수는 원금을 깎지 않고 미래 페이백 150원 중 100원을 상계한다', async (t) => {
  const f = await fixture(t);
  await makeDebt100(f);
  await f.fund(5_000);
  await f.cards.apply(authorize('benefit-after-debt', 15_000));
  const closed = await f.cards.apply(capture('benefit-after-debt', 15_000));
  assert.equal(cashback(closed.payment).awardedWon, 150);
  assert.equal(cashback(closed.payment).offsetWon, 100);
  const rewards = await f.rewards.snapshot('alice');
  assert.deepEqual([rewards.availableWon, rewards.adjustmentDueWon], [50, 0]);
  assert.equal(rewards.cashback.confirmedWon, 150, '발생한 페이백과 실제 늘어난 리워드 50원을 구분한다');
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 0, '새 15000원 결제 외에 회수 명목의 원금 차감은 없다');
  await assertRewardHistory(f.database, rewards);
  await assertMoneyBalanced(f.database);
});

test('보류 중인 리워드를 취소로 돌려받아도 먼저 조정 미수액을 상계해 회수를 우회하지 못한다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(10_000);
  await f.cards.apply(authorize('held-debt-origin', 10_000)); await f.cards.apply(capture('held-debt-origin', 10_000));
  await f.cards.apply(authorize('held-before-clawback', 100));
  await f.cards.apply(refund('held-debt-origin', 10_000));
  const held = await f.rewards.snapshot('alice');
  assert.deepEqual([held.availableWon, held.heldWon, held.adjustmentDueWon], [0, 100, 100]);
  await f.cards.apply(reverse('held-before-clawback'));
  const released = await f.rewards.snapshot('alice');
  assert.deepEqual([released.availableWon, released.heldWon, released.adjustmentDueWon], [0, 0, 0]);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 10_000);
  await assertRewardHistory(f.database, released);
});

test('결제에 쓴 리워드의 환불도 미수 조정을 먼저 상계하고 원금으로 바꾸지 않는다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(10_000);
  await f.cards.apply(authorize('refund-debt-origin', 10_000)); await f.cards.apply(capture('refund-debt-origin', 10_000));
  await f.cards.apply(authorize('spent-cashback-for-debt', 100)); await f.cards.apply(capture('spent-cashback-for-debt', 100));
  await f.grant(100);
  await f.cards.apply(authorize('refundable-operator-points', 100)); await f.cards.apply(capture('refundable-operator-points', 100));
  await f.cards.apply(refund('refund-debt-origin', 10_000));
  assert.equal((await f.rewards.snapshot('alice')).adjustmentDueWon, 100);
  const returned = await f.cards.apply(refund('refundable-operator-points', 100));
  assert.equal(funded(returned).rewards.refundedWon, 100);
  const rewards = await f.rewards.snapshot('alice');
  assert.deepEqual([rewards.availableWon, rewards.adjustmentDueWon], [0, 0]);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 10_000);
  await assertRewardHistory(f.database, rewards);
});

test('두 연결의 미래 보상 80원씩은 조정 100원을 한 번 상계하고 60원만 사용 가능하게 한다', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await makeDebt100(f);
  const peer = f.peer();
  const results = await Promise.all([
    f.rewards.grant({ userId: 'alice', amountWon: 80, idempotencyKey: 'future-credit-a' }),
    peer.rewards.grant({ userId: 'alice', amountWon: 80, idempotencyKey: 'future-credit-b' }),
  ]);
  assert.equal(results.reduce((sum, item) => sum + item.offsetWon, 0), 100);
  const current = await f.rewards.snapshot('alice');
  assert.deepEqual([current.availableWon, current.adjustmentDueWon], [60, 0]);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 10_000);
  await assertRewardHistory(f.database, current);
  await assertMoneyBalanced(f.database);
});

test('다른 회원의 동시 리워드 발행도 공통 회사 예산을 초과하지 못한다', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.activate(100);
  const peer = f.peer();
  const results = await Promise.allSettled([
    f.rewards.grant({ userId: 'alice', amountWon: 80, idempotencyKey: 'grant-budget-a' }),
    peer.rewards.grant({ userId: 'bobby', amountWon: 80, idempotencyKey: 'grant-budget-b' }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const denied = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
  assert.ok(denied.reason instanceof LedgerError);
  assert.equal(denied.reason.status, 503);
  assert.equal(denied.reason.code, 'REWARD_BUDGET_UNAVAILABLE');
  assert.equal((await f.rewards.snapshot('alice')).availableWon + (await f.rewards.snapshot('bobby')).availableWon, 80);
  assert.equal(await companyCash(f.database), 100n);
});

test('리워드를 사용하는 동시 승인은 같은 100원을 두 번 보류하지 못한다', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.grant(100);
  const peer = f.peer();
  const results = await Promise.allSettled([f.cards.apply(authorize('points-race-a', 80)), peer.cards.apply(authorize('points-race-b', 80))]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const denied = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
  assert.ok(denied.reason instanceof LedgerError);
  assert.equal(denied.reason.status, 409);
  const snapshot = await f.ledger.snapshot('alice');
  assert.deepEqual([snapshot.rewards.availableWon, snapshot.rewards.heldWon], [20, 80]);
  assert.equal(snapshot.heldBalanceWon, 0);
  assert.equal(snapshot.totalBalanceWon, 0);
  await assertRewardHistory(f.database, snapshot.rewards);
});

test('프로그램 중지는 기존 약정을 깨지 않고 발행된 리워드 사용은 계속 허용한다', async (t) => {
  const f = await fixture(t);
  await f.activate(); await f.fund(7_000); await f.grant(3_000);
  await f.cards.apply(authorize('promised-before-disable', 10_000));
  await f.rewards.setProgram({ enabled: false, idempotencyKey: 'disable-program' });
  await failure(() => f.grant(1), [409]);
  const closed = await f.cards.apply(capture('promised-before-disable', 10_000));
  assert.equal(cashback(closed.payment).awardedWon, 70);
  assert.equal(cashback(closed.payment).rateBps, 100);
  assert.equal((await f.rewards.snapshot('alice')).programActive, false);
  const redemption = await f.cards.apply(authorize('redeem-while-disabled', 70));
  assert.equal(funded(redemption).rewards.authorizedWon, 70);
  const redeemed = await f.cards.apply(capture('redeem-while-disabled', 70));
  assert.equal(cashback(redeemed.payment).rateBps, 0);
  assert.equal(cashback(redeemed.payment).awardedWon, 0);
  assert.equal((await f.rewards.snapshot('alice')).availableWon, 0);
  assert.equal((await f.ledger.snapshot('alice')).totalBalanceWon, 0);
  await assertMoneyBalanced(f.database);
});
