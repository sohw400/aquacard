import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from './database';
import { CardPaymentStore } from './card-payments';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerError, LedgerStore } from './ledger';
import { createTestDatabase } from './test-support';
import type { CardEventResult, SandboxCardEvent } from '../shared/api';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 19, 3);
const PAYMENT = 'pay-main-0001';
const AUTHORIZATION = 'evt-authorize-0001';

async function fixture(t: TestContext) {
  const base = await createTestDatabase();
  const peers: Database[] = [];
  let now = NOW;
  const options = { now: () => now };
  const createStores = (database: Database) => ({ database, ledger: new LedgerStore(database, options), cards: new CardPaymentStore(database, options) });
  const primary = createStores(base.database);
  t.after(async () => { try { await Promise.all(peers.map((database) => database.close())); } finally { await base.cleanup(); } });
  return {
    ...primary,
    peer() {
      const database = new Database({ connectionString: base.connectionString, schema: base.schema, maxConnections: 3 });
      peers.push(database);
      return createStores(database);
    },
    advance(milliseconds: number) { now += milliseconds; },
  };
}

async function member(ledger: LedgerStore, id: string) {
  const user = await ledger.createUser({ id, email: `${id}@example.test`, name: `${id} 회원`, tag: id,
    passwordHash: `test-only:${id}`, createdAt: NOW - 60 * DAY });
  await new IssuerOutboxStore(ledger.database, { now: () => NOW }).register({ userId: id, providerCardId: `sandbox-card-${id}`, initialStatus: 'active' });
  return user;
}
function fund(ledger: LedgerStore, userId: string, amountWon: number, idempotencyKey = `seed-${userId}`) {
  return ledger.creditSandbox({ userId, amountWon, idempotencyKey });
}
function authorize(changes: Partial<Extract<SandboxCardEvent, { kind: 'authorize' }>> = {}): SandboxCardEvent {
  return { kind: 'authorize', eventId: AUTHORIZATION, paymentId: PAYMENT, userId: 'alice', amountWon: 10_000, merchantName: '서울 문구점', ...changes };
}
function capture(eventId: string, amountWon: number, finalCapture = false, paymentId = PAYMENT, userId = 'alice'): SandboxCardEvent {
  return { kind: 'capture', eventId, paymentId, userId, amountWon, finalCapture };
}
function reverse(eventId = 'evt-reverse-0001', paymentId = PAYMENT, userId = 'alice'): SandboxCardEvent {
  return { kind: 'reverse', eventId, paymentId, userId };
}
function refund(eventId: string, amountWon: number, paymentId = PAYMENT, userId = 'alice'): SandboxCardEvent {
  return { kind: 'refund', eventId, paymentId, userId, amountWon };
}
async function rejected(run: () => Promise<unknown>, status?: number | number[]): Promise<LedgerError> {
  let captured: LedgerError | undefined;
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof LedgerError, '카드 명령 실패는 정규화된 LedgerError여야 한다');
    if (status !== undefined) assert.ok((Array.isArray(status) ? status : [status]).includes(error.status), `예상하지 않은 오류 상태 ${error.status}`);
    captured = error;
    return true;
  });
  return captured!;
}
async function fingerprint(database: Database) {
  const [accounts, journals, payments, events] = await Promise.all([
    database.query('SELECT * FROM ledger_accounts ORDER BY id'),
    database.query('SELECT * FROM journals ORDER BY id'),
    database.query('SELECT * FROM card_payments ORDER BY id'),
    database.query('SELECT * FROM card_payment_events ORDER BY event_id'),
  ]);
  return { accounts: accounts.rows, journals: journals.rows, payments: payments.rows, events: events.rows };
}
async function assertAccounting(database: Database) {
  const entries = await database.query(`SELECT journal_id, currency, COUNT(*) AS legs, SUM(amount_won) AS total
    FROM journal_entries GROUP BY journal_id, currency`);
  for (const entry of entries.rows) {
    assert.equal(entry.currency, 'TEST_KRW');
    assert.equal(Number(entry.legs), 2);
    assert.equal(BigInt(entry.total), 0n);
  }
  const accounts = await database.query(`SELECT a.id, a.balance_won,
    COALESCE(SUM(e.amount_won), 0)::text AS from_history
    FROM ledger_accounts a LEFT JOIN journal_entries e ON e.account_id = a.id
    GROUP BY a.id ORDER BY a.id`);
  for (const account of accounts.rows) assert.equal(BigInt(account.balance_won), BigInt(account.from_history), `계정 ${account.id}의 잔액과 불변 전표가 일치해야 한다`);
  assert.equal(accounts.rows.reduce((total, account) => total + BigInt(account.balance_won), 0n), 0n);
  const invalid = await database.query(`SELECT id FROM card_payments WHERE
    authorized_won <> held_won + captured_won + released_won OR
    held_won < 0 OR captured_won < 0 OR released_won < 0 OR refunded_won < 0 OR refunded_won > captured_won`);
  assert.deepEqual(invalid.rows, []);
  const held = await database.query(`SELECT u.id, COALESCE(a.balance_won, 0)::text AS ledger_held,
    COALESCE((SELECT SUM(p.held_won) FROM card_payments p WHERE p.user_id = u.id), 0)::text AS payment_held
    FROM users u LEFT JOIN ledger_accounts a ON a.id = 'hold:' || u.id`);
  for (const row of held.rows) assert.equal(BigInt(row.ledger_held), BigInt(row.payment_held));
}
function resultBalance(result: CardEventResult) {
  return { spend: result.balanceWon, held: result.heldBalanceWon, total: result.totalBalanceWon };
}
function assertRaceRejections(results: PromiseSettledResult<unknown>[]) {
  for (const result of results) if (result.status === 'rejected') {
    assert.ok(result.reason instanceof LedgerError, '경합 실패가 DB 오류나 교착으로 노출되면 안 된다');
    assert.equal(result.reason.status, 409);
  }
}

test('승인은 TEST_KRW를 spend에서 hold로 옮기고 회원 송금에서 보류액을 제외한다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await member(f.ledger, 'bobby');
  await fund(f.ledger, 'alice', 20_000);
  const authorized = await f.cards.apply(authorize({ amountWon: 12_000 }));
  assert.deepEqual(resultBalance(authorized), { spend: 8_000, held: 12_000, total: 20_000 });
  assert.deepEqual(authorized.payment, { id: PAYMENT, merchantName: '서울 문구점', status: 'authorized', authorizedWon: 12_000,
    heldWon: 12_000, capturedWon: 0, releasedWon: 0, refundedWon: 0, createdAt: NOW, updatedAt: NOW });
  const snapshot = await f.ledger.snapshot('alice');
  assert.equal(snapshot.balanceWon, 8_000);
  assert.equal(snapshot.heldBalanceWon, 12_000);
  assert.equal(snapshot.totalBalanceWon, 20_000);
  assert.equal(snapshot.limits.available, 8_000);
  assert.deepEqual(snapshot.cardPayments, [authorized.payment]);
  await rejected(() => f.ledger.transfer({ senderId: 'alice', recipientTag: 'bobby', amountWon: 9_000, idempotencyKey: 'send-held-money' }), 409);
  await f.ledger.transfer({ senderId: 'alice', recipientTag: 'bobby', amountWon: 8_000, idempotencyKey: 'send-available-money' });
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 0);
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 12_000);
  assert.equal((await f.ledger.snapshot('bobby')).balanceWon, 8_000);
  assert.deepEqual((await f.ledger.snapshot('bobby')).cardPayments, []);
  await assertAccounting(f.database);
});

test('전체 승인 취소는 원금을 한 번만 반환하고 반복 이벤트는 원래 응답을 재생한다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 20_000);
  await f.cards.apply(authorize());
  const event = reverse();
  const cancelled = await f.cards.apply(event);
  assert.equal(cancelled.payment.status, 'cancelled');
  assert.equal(cancelled.payment.releasedWon, 10_000);
  assert.deepEqual(resultBalance(cancelled), { spend: 20_000, held: 0, total: 20_000 });
  const before = await fingerprint(f.database);
  assert.deepEqual(await f.peer().cards.apply(event), cancelled);
  assert.deepEqual(await fingerprint(f.database), before);
  await rejected(() => f.cards.apply(reverse('new-reverse-after-closed')), 409);
  await rejected(() => f.cards.apply(capture('capture-after-cancel', 1, true)), 409);
  assert.deepEqual(await fingerprint(f.database), before);
  await assertAccounting(f.database);
});

test('여러 부분 매입 후 finalCapture는 잔여 보류만 해제하며 부분 환불의 누적 상한을 지킨다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 50_000);
  await f.cards.apply(authorize());
  f.advance(1_000);
  const first = await f.cards.apply(capture('capture-part-one', 4_000));
  assert.equal(first.payment.status, 'partially_captured');
  assert.deepEqual(resultBalance(first), { spend: 40_000, held: 6_000, total: 46_000 });
  f.advance(1_000);
  const final = await f.cards.apply(capture('capture-part-final', 3_000, true));
  assert.equal(final.payment.status, 'captured');
  assert.equal(final.payment.capturedWon, 7_000);
  assert.equal(final.payment.releasedWon, 3_000);
  assert.equal(final.payment.heldWon, 0);
  assert.deepEqual(resultBalance(final), { spend: 43_000, held: 0, total: 43_000 });
  const partial = await f.cards.apply(refund('refund-part-one', 2_000));
  assert.equal(partial.payment.status, 'partially_refunded');
  assert.deepEqual(resultBalance(partial), { spend: 45_000, held: 0, total: 45_000 });
  const complete = await f.cards.apply(refund('refund-part-final', 5_000));
  assert.equal(complete.payment.status, 'refunded');
  assert.equal(complete.payment.refundedWon, 7_000);
  assert.deepEqual(resultBalance(complete), { spend: 50_000, held: 0, total: 50_000 });
  const before = await fingerprint(f.database);
  await rejected(() => f.cards.apply(refund('refund-over-captured', 1)), 409);
  assert.deepEqual(await fingerprint(f.database), before);
  await assertAccounting(f.database);
});

test('부분 매입 뒤 취소는 미매입 보류만 풀고 이미 매입한 금액은 환불로만 돌려준다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 50_000);
  await f.cards.apply(authorize());
  await f.cards.apply(capture('capture-before-reverse', 4_000));
  const reversed = await f.cards.apply(reverse());
  assert.equal(reversed.payment.status, 'captured');
  assert.equal(reversed.payment.capturedWon, 4_000);
  assert.equal(reversed.payment.releasedWon, 6_000);
  assert.deepEqual(resultBalance(reversed), { spend: 46_000, held: 0, total: 46_000 });
  await rejected(() => f.cards.apply(reverse('reverse-after-partial-close')), 409);
  await rejected(() => f.cards.apply(capture('capture-after-partial-close', 1)), 409);
  assert.deepEqual(resultBalance(await f.cards.apply(refund('refund-captured-part', 4_000))), { spend: 50_000, held: 0, total: 50_000 });
  await assertAccounting(f.database);
});

test('보류가 남아 있는 부분 매입도 환불할 수 있고 이후 매입·취소가 잔액을 보존한다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 20_000);
  await f.cards.apply(authorize());
  await f.cards.apply(capture('capture-before-early-refund', 4_000));
  const early = await f.cards.apply(refund('refund-while-held', 4_000));
  assert.equal(early.payment.status, 'partially_refunded');
  assert.equal(early.payment.heldWon, 6_000);
  assert.deepEqual(resultBalance(early), { spend: 14_000, held: 6_000, total: 20_000 });
  const later = await f.cards.apply(capture('capture-after-early-refund', 2_000, true));
  assert.equal(later.payment.capturedWon, 6_000);
  assert.equal(later.payment.refundedWon, 4_000);
  assert.equal(later.payment.releasedWon, 4_000);
  assert.deepEqual(resultBalance(later), { spend: 18_000, held: 0, total: 18_000 });
  assert.deepEqual(resultBalance(await f.cards.apply(refund('refund-remaining-captured', 2_000))), { spend: 20_000, held: 0, total: 20_000 });
  await assertAccounting(f.database);
});

test('동일 이벤트는 처리 시각·후속 거래·재연결과 무관하게 최초 결과를 재생한다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 20_000);
  const original = await f.cards.apply(authorize());
  await f.cards.apply(capture('capture-after-original-result', 7_000, true));
  await fund(f.ledger, 'alice', 1_000, 'later-funding');
  f.advance(DAY);
  const peer = f.peer();
  const before = await fingerprint(f.database);
  const reordered: SandboxCardEvent = { merchantName: ' 서울 문구점 ', userId: 'alice', paymentId: PAYMENT,
    amountWon: 10_000, kind: 'authorize', eventId: AUTHORIZATION };
  assert.deepEqual(await peer.cards.apply(reordered), original);
  assert.deepEqual(await fingerprint(f.database), before);
  const current = await peer.ledger.snapshot('alice');
  assert.equal(current.balanceWon, 14_000);
  assert.equal(current.cardPayments[0].status, 'captured');
  assert.equal(original.payment.status, 'authorized');
  await assertAccounting(f.database);
});

test('글로벌 이벤트 ID는 다른 금액·결제·회원·종류에 재사용할 수 없다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await member(f.ledger, 'bobby');
  await fund(f.ledger, 'alice', 30_000); await fund(f.ledger, 'bobby', 30_000);
  await f.cards.apply(authorize());
  const before = await fingerprint(f.database);
  for (const changed of [authorize({ amountWon: 9_999 }), authorize({ paymentId: 'another-payment' }),
    authorize({ userId: 'bobby' }), capture(AUTHORIZATION, 1), authorize({ merchantName: '다른 가맹점' })]) {
    await rejected(() => f.peer().cards.apply(changed), 409);
  }
  await rejected(() => f.cards.apply(authorize({ eventId: 'another-authorize-same-payment' })), 409);
  await rejected(() => f.cards.apply(authorize({ eventId: 'other-owner-same-payment', userId: 'bobby' })), [403, 404, 409]);
  assert.deepEqual(await fingerprint(f.database), before);
});

test('결제 소유자가 아닌 회원은 매입·취소·환불을 적용하거나 자신의 조회에 노출할 수 없다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await member(f.ledger, 'bobby');
  await fund(f.ledger, 'alice', 20_000);
  await f.cards.apply(authorize());
  await f.cards.apply(capture('owner-capture', 4_000));
  const before = await fingerprint(f.database);
  for (const event of [capture('other-owner-capture', 1, false, PAYMENT, 'bobby'),
    reverse('other-owner-reverse', PAYMENT, 'bobby'), refund('other-owner-refund', 1, PAYMENT, 'bobby')]) {
    await rejected(() => f.cards.apply(event), [403, 404, 409]);
  }
  assert.deepEqual(await fingerprint(f.database), before);
  assert.deepEqual((await f.ledger.snapshot('bobby')).cardPayments, []);
  assert.equal((await f.ledger.snapshot('alice')).cardPayments.length, 1);
});

test('잘못된 순서나 잔액 부족은 이벤트를 소비하지 않아 원인이 해결되면 같은 ID로 재시도한다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice');
  const initial = await fingerprint(f.database);
  const pendingCapture = capture('capture-before-authorization', 3_000, true);
  await rejected(() => f.cards.apply(pendingCapture), [404, 409]);
  await rejected(() => f.cards.apply(authorize()), 409);
  assert.deepEqual(await fingerprint(f.database), initial);
  await fund(f.ledger, 'alice', 10_000);
  await f.cards.apply(authorize());
  const pendingRefund = refund('refund-before-capture', 2_000);
  const before = await fingerprint(f.database);
  await rejected(() => f.cards.apply(pendingRefund), 409);
  assert.deepEqual(await fingerprint(f.database), before);
  await f.cards.apply(pendingCapture);
  const refunded = await f.cards.apply(pendingRefund);
  assert.equal(refunded.payment.refundedWon, 2_000);
  assert.deepEqual(resultBalance(refunded), { spend: 9_000, held: 0, total: 9_000 });
  await assertAccounting(f.database);
});

test('잘못된 금액과 이벤트 입력은 DB 상태를 바꾸지 않고 1원 카드 결제는 지원한다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 10_000);
  const before = await fingerprint(f.database);
  for (const [index, amountWon] of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000'].entries()) {
    await rejected(() => f.cards.apply(authorize({ eventId: `bad-amount-${index}`, amountWon: amountWon as number })), 400);
  }
  const invalid: unknown[] = [null, {}, { ...authorize(), eventId: '' }, { ...authorize(), paymentId: '' },
    { ...authorize(), userId: '' }, { ...authorize(), merchantName: '   ' }, { ...authorize(), kind: 'vendor_webhook' }];
  for (const event of invalid) await rejected(() => f.cards.apply(event as SandboxCardEvent), 400);
  assert.deepEqual(await fingerprint(f.database), before);
  await f.cards.apply(authorize({ amountWon: 1 }));
  assert.deepEqual(resultBalance(await f.cards.apply(capture('one-won-capture', 1, true))), { spend: 9_999, held: 0, total: 9_999 });
  assert.deepEqual(resultBalance(await f.cards.apply(refund('one-won-refund', 1))), { spend: 10_000, held: 0, total: 10_000 });
  await assertAccounting(f.database);
});

test('매입·환불의 금액 상한과 finalCapture 타입을 서버에서 검사한다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 20_000);
  await f.cards.apply(authorize());
  const before = await fingerprint(f.database);
  for (const [index, amount] of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].entries()) {
    await rejected(() => f.cards.apply(capture(`invalid-capture-${index}`, amount)), 400);
    await rejected(() => f.cards.apply(refund(`invalid-refund-${index}`, amount)), 400);
  }
  await rejected(() => f.cards.apply({ ...capture('invalid-final-type', 1), finalCapture: 'false' } as unknown as SandboxCardEvent), 400);
  await rejected(() => f.cards.apply(capture('capture-over-held', 10_001)), 409);
  assert.deepEqual(await fingerprint(f.database), before);
  await assertAccounting(f.database);
});

test('별도 연결의 회원 송금과 카드 승인은 같은 사용 가능 잔액을 이중 지출하지 못한다', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await member(f.ledger, 'bobby'); await fund(f.ledger, 'alice', 10_000);
  const peer = f.peer();
  const outcomes = await Promise.allSettled([
    f.cards.apply(authorize({ amountWon: 7_000 })),
    peer.ledger.transfer({ senderId: 'alice', recipientTag: 'bobby', amountWon: 7_000, idempotencyKey: 'competing-member-send' }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(failed.reason instanceof LedgerError);
  assert.equal(failed.reason.status, 409);
  const alice = await f.ledger.snapshot('alice'); const bob = await f.ledger.snapshot('bobby');
  assert.equal(alice.balanceWon, 3_000);
  assert.equal(alice.totalBalanceWon + bob.totalBalanceWon, 10_000);
  assert.equal(alice.heldBalanceWon + bob.balanceWon, 7_000);
  await assertAccounting(f.database);
});

test('별도 연결에서 같은 승인 이벤트를 동시에 보내도 보류와 최초 응답은 하나다', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 30_000);
  const peer = f.peer();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? peer.cards : f.cards).apply(authorize())));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 10_000);
  assert.equal(Number((await f.database.query('SELECT COUNT(*) AS total FROM card_payment_events')).rows[0].total), 1);
  assert.equal(Number((await f.database.query("SELECT COUNT(*) AS total FROM journals WHERE kind = 'card_authorize'")).rows[0].total), 1);
  await assertAccounting(f.database);
});

test('다른 ID의 동시 승인은 한도를 넘지 않고 같은 ID의 다른 payload는 하나만 성공한다', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 10_000);
  const peer = f.peer();
  const results = await Promise.allSettled([
    f.cards.apply(authorize({ amountWon: 7_000 })),
    peer.cards.apply(authorize({ eventId: 'other-authorization', paymentId: 'other-payment', amountWon: 7_000 })),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assertRaceRejections(results);
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 7_000);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 3_000);
  await fund(f.ledger, 'alice', 20_000, 'more-funds-for-conflict');
  const conflict = await Promise.allSettled([
    f.cards.apply(authorize({ eventId: 'same-racing-id', paymentId: 'racing-payment', amountWon: 1_000 })),
    peer.cards.apply(authorize({ eventId: 'same-racing-id', paymentId: 'racing-payment', amountWon: 2_000 })),
  ]);
  assert.equal(conflict.filter((result) => result.status === 'fulfilled').length, 1);
  const denied = conflict.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(denied.reason instanceof LedgerError);
  assert.equal(denied.reason.status, 409);
  await assertAccounting(f.database);
});

test('매입 이벤트 중복과 다른 ID의 경합이 승인액 이상을 매입하지 않는다', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 20_000); await f.cards.apply(authorize());
  const peer = f.peer();
  const firstEvent = capture('duplicated-capture', 4_000);
  const duplicates = await Promise.all([f.cards.apply(firstEvent), peer.cards.apply(firstEvent)]);
  assert.deepEqual(duplicates[0], duplicates[1]);
  const racing = await Promise.allSettled([
    f.cards.apply(capture('capture-competing-a', 4_000)),
    peer.cards.apply(capture('capture-competing-b', 4_000)),
  ]);
  assert.equal(racing.filter((result) => result.status === 'fulfilled').length, 1);
  assertRaceRejections(racing);
  const payment = (await f.ledger.snapshot('alice')).cardPayments[0];
  assert.equal(payment.capturedWon, 8_000);
  assert.equal(payment.heldWon, 2_000);
  assert.equal(payment.refundedWon, 0);
  await assertAccounting(f.database);
});

test('동시 매입과 취소가 같은 보류액을 소비하거나 반환하는 작업을 중복하지 않는다', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 20_000); await f.cards.apply(authorize());
  const peer = f.peer();
  const outcomes = await Promise.allSettled([f.cards.apply(capture('capture-races-reverse', 10_000, true)), peer.cards.apply(reverse())]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assertRaceRejections(outcomes);
  const snapshot = await f.ledger.snapshot('alice'); const payment = snapshot.cardPayments[0];
  assert.equal(snapshot.heldBalanceWon, 0);
  assert.equal(payment.capturedWon + payment.releasedWon, 10_000);
  assert.equal(snapshot.balanceWon, 20_000 - payment.capturedWon);
  assert.ok(payment.status === 'captured' || payment.status === 'cancelled');
  await assertAccounting(f.database);
});

test('환불 이벤트 중복과 서로 다른 동시 부분 환불은 매입 누계를 초과하지 못한다', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await fund(f.ledger, 'alice', 20_000); await f.cards.apply(authorize());
  await f.cards.apply(capture('capture-for-refund-races', 10_000, true));
  const peer = f.peer();
  const event = refund('duplicate-refund', 2_000);
  const duplicates = await Promise.all([f.cards.apply(event), peer.cards.apply(event)]);
  assert.deepEqual(duplicates[0], duplicates[1]);
  const outcomes = await Promise.allSettled([
    f.cards.apply(refund('refund-race-a', 5_000)), peer.cards.apply(refund('refund-race-b', 5_000)),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assertRaceRejections(outcomes);
  const snapshot = await f.ledger.snapshot('alice');
  assert.equal(snapshot.cardPayments[0].refundedWon, 7_000);
  assert.equal(snapshot.balanceWon, 17_000);
  await assertAccounting(f.database);
});

test('spend와hold 합계의 정수 상한은 운영자 충전·회원 입금·환불에도 유지된다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await member(f.ledger, 'bobby');
  await fund(f.ledger, 'alice', Number.MAX_SAFE_INTEGER);
  await fund(f.ledger, 'bobby', 1_000);
  await f.cards.apply(authorize({ amountWon: 1 }));
  const before = await fingerprint(f.database);
  await rejected(() => fund(f.ledger, 'alice', 1, 'capacity-credit'), 409);
  await rejected(() => f.ledger.transfer({ senderId: 'bobby', recipientTag: 'alice', amountWon: 1_000, idempotencyKey: 'capacity-transfer' }), 409);
  assert.deepEqual(await fingerprint(f.database), before);
  await f.cards.apply(capture('capacity-capture', 1, true));
  await fund(f.ledger, 'alice', 1, 'restore-capacity');
  const beforeRefund = await fingerprint(f.database);
  await rejected(() => f.cards.apply(refund('refund-over-capacity', 1)), 409);
  assert.deepEqual(await fingerprint(f.database), beforeRefund);
  assert.equal((await f.ledger.snapshot('alice')).totalBalanceWon, Number.MAX_SAFE_INTEGER);
  await assertAccounting(f.database);
});

test('완료 이벤트·카드 상태·전표를 직접 바꾸거나 ON CONFLICT 재삽입으로 재집행할 수 없다', async (t) => {
  const f = await fixture(t);
  await member(f.ledger, 'alice'); await member(f.ledger, 'bobby'); await fund(f.ledger, 'alice', 30_000);
  await f.cards.apply(authorize()); await f.cards.apply(capture('audit-capture', 4_000));
  const before = await fingerprint(f.database);
  const journal = (await f.database.query("SELECT id FROM journals WHERE kind = 'card_authorize'")).rows[0].id as string;
  const skipped = await f.database.query('INSERT INTO journals SELECT * FROM journals WHERE id = $1 ON CONFLICT DO NOTHING', [journal]);
  assert.equal(skipped.rowCount, 0);
  for (const query of [
    "UPDATE journals SET amount_won = amount_won + 1 WHERE kind = 'card_authorize'",
    "DELETE FROM journals WHERE kind = 'card_authorize'", 'TRUNCATE journals',
    "UPDATE card_payment_events SET canonical_input = canonical_input || '{\"amountWon\":1}'::jsonb",
    "UPDATE card_payment_events SET result = result || '{\"balanceWon\":1}'::jsonb",
    'DELETE FROM card_payment_events', 'TRUNCATE card_payment_events',
    'UPDATE card_payments SET held_won = held_won + 1',
    "UPDATE card_payments SET user_id = 'bobby'", 'DELETE FROM card_payments',
    "UPDATE ledger_accounts SET balance_won = balance_won + 1 WHERE id = 'hold:alice'",
  ]) await assert.rejects(() => f.database.query(query));
  const forged = `INSERT INTO journals (id, kind, currency, from_account_id, to_account_id, amount_won,
    sender_id, recipient_id, sender_name, sender_tag, recipient_name, recipient_tag, request_owner_id,
    idempotency_key, request_payload, balance_after_won, created_at, card_payment_id, card_event_id)
    SELECT $2, j.kind, j.currency, j.from_account_id, j.to_account_id, j.amount_won,
    j.sender_id, j.recipient_id, j.sender_name, j.sender_tag, j.recipient_name, j.recipient_tag, j.request_owner_id,
    $3, j.request_payload, a.balance_won - j.amount_won, j.created_at, j.card_payment_id, j.card_event_id
    FROM journals j JOIN ledger_accounts a ON a.id = j.from_account_id WHERE j.id = $1`;
  await assert.rejects(() => f.database.query(forged, [journal, 'forged-card-journal', '$card:forged-journal']));
  assert.deepEqual(await fingerprint(f.database), before);
  await assertAccounting(f.database);
});
