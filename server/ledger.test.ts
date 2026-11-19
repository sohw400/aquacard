import { approveTestCustomer } from './test-customer-access';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from './database';
import { LedgerError, LedgerStore } from './ledger';
import { createTestDatabase } from './test-support';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 3);

async function fixture(t: TestContext, initialNow = NOW) {
  const { database, schema, connectionString, cleanup } = await createTestDatabase();
  let now = initialNow;
  const options = { now: () => now };
  let store = new LedgerStore(database, options);
  const independentDatabases: Database[] = [];
  t.after(async () => {
    try { await Promise.all(independentDatabases.map((connection) => connection.close())); }
    finally { await cleanup(); }
  });
  return {
    database,
    get store() { return store; },
    newStore() { return new LedgerStore(database, options); },
    newIndependentStore() {
      const connection = new Database({ connectionString, schema, maxConnections: 2 });
      independentDatabases.push(connection);
      return new LedgerStore(connection, options);
    },
    reopen() { store = new LedgerStore(database, options); return store; },
    time: {
      set(value: number) { now = value; },
      advance(milliseconds: number) { now += milliseconds; },
    },
  };
}

async function member(store: LedgerStore, id: string, createdAt = NOW - 60 * DAY) {
  const names: Record<string, string> = { alice: '김민수', bob: '이서연', carol: '박지훈' };
  const user = await store.createUser({ id, email: `${id}@example.test`, name: names[id] ?? `${id} 회원`, tag: id,
    passwordHash: `test-password-hash:${id}`, createdAt });
  await approveTestCustomer(store.database, id);
  return user;
}

function fund(store: LedgerStore, userId: string, amountWon: number, idempotencyKey = `seed-${userId}`) {
  return store.creditSandbox({ userId, amountWon, idempotencyKey });
}

function send(store: LedgerStore, senderId: string, recipientTag: string, amountWon: number, idempotencyKey = 'transfer-1') {
  return store.transfer({ senderId, recipientTag, amountWon, idempotencyKey });
}

async function ledgerFailure(run: () => Promise<unknown>, status?: number) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof LedgerError, '원장 실패는 호출자가 처리할 수 있는 LedgerError여야 한다');
    assert.equal(typeof error.code, 'string');
    assert.ok(error.code.length > 0);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test('신규 계정은 잔액 0원이며 공개 스냅샷에 비밀번호 해시를 노출하지 않는다', async (t) => {
  const { store } = await fixture(t);
  const user = await member(store, 'alice');
  assert.equal(user.passwordHash, 'test-password-hash:alice');
  assert.equal((await store.getUserById('alice'))?.id, 'alice');
  assert.equal((await store.getUserByEmail('alice@example.test'))?.id, 'alice');
  assert.equal((await store.getUserByTag('alice'))?.id, 'alice');
  assert.equal(await store.getUserById('missing') == null, true);
  const snapshot = await store.snapshot('alice');
  assert.equal(snapshot.balanceWon, 0);
  assert.deepEqual(snapshot.transactions, []);
  assert.deepEqual(snapshot.user, { id: 'alice', email: 'alice@example.test', name: '김민수', tag: 'alice', createdAt: NOW - 60 * DAY });
  assert.equal(Object.hasOwn(snapshot.user, 'passwordHash'), false);
  assert.equal(JSON.stringify(snapshot).includes('test-password-hash:'), false);
  assert.equal(snapshot.limits.available, 0);
});

test('송금은 사용자 잔액 합계를 보존하고 양쪽에 같은 거래의 관점을 기록한다', async (t) => {
  const { store } = await fixture(t);
  await member(store, 'alice'); await member(store, 'bob');
  const credit = await fund(store, 'alice', 100_000);
  assert.equal(credit.transfer.direction, 'funded');
  assert.equal(credit.balanceWon, 100_000);
  const result = await send(store, 'alice', 'bob', 23_456);
  const sender = await store.snapshot('alice');
  const recipient = await store.snapshot('bob');
  assert.equal(result.balanceWon, 76_544);
  assert.equal(sender.balanceWon + recipient.balanceWon, 100_000);
  const outgoing = sender.transactions.find((item) => item.id === result.transfer.id);
  const incoming = recipient.transactions.find((item) => item.id === result.transfer.id);
  assert.deepEqual(outgoing, { id: result.transfer.id, direction: 'sent', amountWon: 23_456,
    counterpartyName: '이*연', counterpartyTag: 'bob', createdAt: NOW });
  assert.deepEqual(incoming, { id: result.transfer.id, direction: 'received', amountWon: 23_456,
    counterpartyName: '김*수', counterpartyTag: 'alice', createdAt: NOW });
  assert.equal(JSON.stringify(sender).includes('이서연'), false);
  assert.equal(JSON.stringify(recipient).includes('김민수'), false);
  assert.equal(sender.transactions.filter((item) => item.direction === 'funded').length, 1);
  assert.equal(sender.limits.sentToday, 23_456);
  assert.equal(sender.limits.sentMonth, 23_456);
  assert.equal(recipient.limits.sentToday, 0);
});

test('모든 충전·송금은 TEST_KRW로 균형을 맞춰 기록하고 기존 분개를 수정하거나 삭제할 수 없다', async (t) => {
  const { store, database } = await fixture(t);
  await member(store, 'alice'); await member(store, 'bob');
  await fund(store, 'alice', 100_000);
  const sent = await send(store, 'alice', 'bob', 20_000);
  await fund(store, 'bob', 10_000);
  const { rows: entries } = await database.query(`SELECT journal_id, currency, COUNT(*) AS legs, SUM(amount_won) AS net_won
    FROM journal_entries GROUP BY journal_id, currency`);
  assert.equal(entries.length, 3);
  for (const row of entries) {
    assert.equal(row.currency, 'TEST_KRW');
    assert.equal(Number(row.legs), 2);
    assert.equal(Number(row.net_won), 0, `거래 ${row.journal_id}의 차변과 대변 합계가 0이어야 한다`);
  }
  const { rows: accounts } = await database.query('SELECT kind, user_id, currency, balance_won FROM ledger_accounts');
  assert.ok(accounts.every((account) => account.currency === 'TEST_KRW'));
  assert.equal(accounts.reduce((sum, account) => sum + Number(account.balance_won), 0), 0);
  assert.equal(accounts.filter((account) => account.user_id !== null).reduce((sum, account) => sum + Number(account.balance_won), 0), 110_000);
  assert.ok(accounts.some((account) => account.user_id === null && Number(account.balance_won) === -110_000), '샌드박스 충전도 반대 계정에 기록한다');
  const sender = await store.snapshot('alice');
  const recipient = await store.snapshot('bob');
  await assert.rejects(() => database.query('UPDATE journals SET amount_won = amount_won + 1 WHERE id = $1', [sent.transfer.id]));
  await assert.rejects(() => database.query('DELETE FROM journals WHERE id = $1', [sent.transfer.id]));
  // Include dependent private cash plans so the immutable-history trigger is
  // exercised even after the reward migration adds a foreign key to journals.
  await assert.rejects(() => database.query('TRUNCATE journals CASCADE'), (error: unknown) => (error as { code?: string }).code === '55000');
  assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM journals')).rows[0].count), 3);
  assert.deepEqual(await store.snapshot('alice'), sender);
  assert.deepEqual(await store.snapshot('bob'), recipient);
});

test('다른 원장 인스턴스에서도 같은 요청을 한 번만 반영하고 내용이 바뀌면 충돌한다', async (t) => {
  const context = await fixture(t);
  await member(context.store, 'alice'); await member(context.store, 'bob'); await member(context.store, 'carol');
  const credit = await fund(context.store, 'alice', 100_000, 'persistent-credit');
  const sent = await send(context.store, 'alice', 'bob', 20_000, 'persistent-transfer');
  context.time.advance(DAY);
  const store = context.reopen();
  const repeatedCredit = await fund(store, 'alice', 100_000, 'persistent-credit');
  assert.equal(repeatedCredit.transfer.id, credit.transfer.id);
  assert.equal(repeatedCredit.balanceWon, 100_000, '동일 요청은 최초 확정 응답을 보존한다');
  const repeated = await send(store, 'alice', ' @BOB ', 20_000, 'persistent-transfer');
  assert.equal(repeated.transfer.id, sent.transfer.id);
  const sender = await store.snapshot('alice');
  const recipient = await store.snapshot('bob');
  assert.equal(sender.balanceWon, 80_000);
  assert.equal(recipient.balanceWon, 20_000);
  assert.equal(sender.transactions.length, 2);
  assert.equal(recipient.transactions.length, 1);
  assert.equal(sender.limits.sentToday, 0, '이전 거래의 재시도는 오늘 사용량으로 다시 계산하지 않는다');
  await ledgerFailure(() => send(store, 'alice', 'bob', 21_000, 'persistent-transfer'), 409);
  await ledgerFailure(() => send(store, 'alice', 'carol', 20_000, 'persistent-transfer'), 409);
  await ledgerFailure(() => fund(store, 'alice', 101_000, 'persistent-credit'), 409);
  await ledgerFailure(() => send(store, 'alice', 'bob', 20_000, 'persistent-credit'), 409);
  assert.equal((await store.snapshot('alice')).balanceWon, 80_000);
  await fund(store, 'carol', 5_000);
  await send(store, 'carol', 'alice', 5_000, 'later-incoming');
  assert.equal((await send(store, 'alice', 'bob', 20_000, 'persistent-transfer')).balanceWon, 80_000);
  assert.equal((await store.snapshot('alice')).balanceWon, 85_000, '후속 입금이 있어도 원래 응답 재전송은 잔액을 덮어쓰지 않는다');
});

test('요청 키 범위는 보내는 사용자별이며 서로 다른 사용자의 같은 키를 허용한다', async (t) => {
  const { store } = await fixture(t);
  for (const id of ['alice', 'bob', 'carol']) await member(store, id);
  await fund(store, 'alice', 10_000, 'same-seed');
  await fund(store, 'bob', 10_000, 'same-seed');
  const first = await send(store, 'alice', 'carol', 2_000, 'shared-request');
  const second = await send(store, 'bob', 'carol', 3_000, 'shared-request');
  assert.notEqual(first.transfer.id, second.transfer.id);
  assert.equal((await store.snapshot('alice')).balanceWon, 8_000);
  assert.equal((await store.snapshot('bob')).balanceWon, 7_000);
  assert.equal((await store.snapshot('carol')).balanceWon, 5_000);
});

test('잔액 직접 수정과 같은 ID의 분개 재삽입으로 원장 불변성을 우회할 수 없다', async (t) => {
  const { store, database } = await fixture(t);
  await member(store, 'alice'); await member(store, 'bob');
  await fund(store, 'alice', 10_000);
  const result = await send(store, 'alice', 'bob', 1_000);
  const before = await store.snapshot('alice');
  await assert.rejects(() => database.query('UPDATE ledger_accounts SET balance_won = balance_won + 1000 WHERE user_id = $1', ['alice']));
  const duplicateJournal = `INSERT INTO journals (
    id, kind, currency, from_account_id, to_account_id, amount_won, sender_id, recipient_id,
    sender_name, sender_tag, recipient_name, recipient_tag, request_owner_id, idempotency_key,
    request_payload, balance_after_won, created_at)
    SELECT id, kind, currency, from_account_id, to_account_id, amount_won, sender_id, recipient_id,
    sender_name, sender_tag, recipient_name, recipient_tag, request_owner_id, idempotency_key,
    request_payload, balance_after_won - amount_won, created_at FROM journals WHERE id = $1`;
  await assert.rejects(() => database.query(duplicateJournal, [result.transfer.id]),
  (error: unknown) => {
    assert.equal((error as { code?: string }).code, '23505', '기존 분개 ID는 PostgreSQL 고유성 제약으로 보호해야 한다');
    return true;
  });
  const skipped = await database.query(`${duplicateJournal} ON CONFLICT DO NOTHING`, [result.transfer.id]);
  assert.equal(skipped.rowCount, 0);
  assert.deepEqual(await store.snapshot('alice'), before);
  assert.equal((await store.snapshot('bob')).balanceWon, 1_000);
  assert.equal(Number((await database.query('SELECT SUM(balance_won) AS total FROM ledger_accounts')).rows[0].total), 0);
});

test('자기 송금·없는 수신자·잘못된 금액·잔액 부족은 잔액과 내역을 남기지 않는다', async (t) => {
  const { store, database } = await fixture(t);
  await member(store, 'alice'); await member(store, 'bob');
  await fund(store, 'alice', 10_000);
  const before = await store.snapshot('alice');
  const beforeJournals = Number((await database.query('SELECT COUNT(*) AS count FROM journals')).rows[0].count);
  await ledgerFailure(() => send(store, 'alice', 'alice', 1_000, 'self'));
  await ledgerFailure(() => send(store, 'alice', 'unknown', 1_000, 'unknown'));
  await ledgerFailure(() => send(store, 'alice', 'bob', 11_000, 'insufficient'));
  for (const [index, amount] of [0, -1, 999, 1_000.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].entries()) {
    await ledgerFailure(() => send(store, 'alice', 'bob', amount, `bad-amount-${index}`));
    if (amount !== 999) await ledgerFailure(() => fund(store, 'alice', amount, `bad-credit-${index}`));
  }
  assert.deepEqual(await store.snapshot('alice'), before);
  assert.equal((await store.snapshot('bob')).balanceWon, 0);
  assert.deepEqual((await store.snapshot('bob')).transactions, []);
  assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM journals')).rows[0].count), beforeJournals);
});

test('운영자용 샌드박스 충전은 1원 단위를 허용하고 회원 송금 최소 금액은 유지한다', async (t) => {
  const { store } = await fixture(t);
  await member(store, 'alice'); await member(store, 'bob');
  assert.equal((await fund(store, 'alice', 1, 'one-won')).balanceWon, 1);
  await ledgerFailure(() => send(store, 'alice', 'bob', 1, 'too-small-transfer'), 400);
  assert.equal((await fund(store, 'alice', 999, 'remaining-won')).balanceWon, 1_000);
  assert.equal((await send(store, 'alice', 'bob', 1_000, 'minimum-transfer')).balanceWon, 0);
  assert.equal((await store.snapshot('bob')).balanceWon, 1_000);
});

test('실패한 송금은 요청 키를 소비하지 않아 자금 보충 후 동일 요청을 성공시킬 수 있다', async (t) => {
  const { store } = await fixture(t);
  await member(store, 'alice'); await member(store, 'bob');
  await ledgerFailure(() => send(store, 'alice', 'bob', 5_000, 'retry-after-failure'));
  await fund(store, 'alice', 5_000);
  const result = await send(store, 'alice', 'bob', 5_000, 'retry-after-failure');
  assert.equal(result.balanceWon, 0);
  assert.equal((await store.snapshot('bob')).balanceWon, 5_000);
  assert.equal((await store.snapshot('bob')).transactions.length, 1);
});

test('수신자 잔액과 샌드박스 충전의 정수 범위 초과는 전체 거래를 롤백한다', async (t) => {
  const { store } = await fixture(t);
  await member(store, 'alice'); await member(store, 'bob');
  await fund(store, 'alice', 10_000);
  await fund(store, 'bob', Number.MAX_SAFE_INTEGER);
  const sender = await store.snapshot('alice');
  const recipient = await store.snapshot('bob');
  await ledgerFailure(() => send(store, 'alice', 'bob', 1_000, 'recipient-overflow'));
  await ledgerFailure(() => fund(store, 'bob', 1_000, 'funding-overflow'));
  assert.deepEqual(await store.snapshot('alice'), sender);
  assert.deepEqual(await store.snapshot('bob'), recipient);
});

test('가입 첫 30일은 송금 한도를 절반 적용하고 정확히 30일 후 기본 한도로 전환한다', async (t) => {
  const { store, time } = await fixture(t);
  await member(store, 'alice', NOW - 30 * DAY + 1); await member(store, 'bob');
  await fund(store, 'alice', 3_000_000);
  assert.deepEqual((await store.snapshot('alice')).limits, {
    perTransfer: 500_000, daily: 1_000_000, monthly: 2_500_000,
    sentToday: 0, sentMonth: 0, available: 500_000,
  });
  await ledgerFailure(() => send(store, 'alice', 'bob', 500_001, 'new-per-transfer'));
  await send(store, 'alice', 'bob', 500_000, 'new-first');
  await send(store, 'alice', 'bob', 500_000, 'new-second');
  assert.equal((await store.snapshot('alice')).limits.available, 0);
  await ledgerFailure(() => send(store, 'alice', 'bob', 1_000, 'new-day-limit'));
  time.advance(1);
  const mature = (await store.snapshot('alice')).limits;
  assert.equal(mature.perTransfer, 1_000_000);
  assert.equal(mature.daily, 2_000_000);
  assert.equal(mature.monthly, 5_000_000);
  assert.equal(mature.sentToday, 1_000_000);
  assert.equal(mature.available, 1_000_000);
});

test('일 한도는 한국 자정에 초기화되고 같은 달 송금 누계는 유지한다', async (t) => {
  const beforeMidnight = Date.UTC(2026, 10, 16, 14, 59, 59, 999);
  const { store, time } = await fixture(t, beforeMidnight);
  await member(store, 'alice'); await member(store, 'bob');
  await fund(store, 'alice', 10_000_000);
  await send(store, 'alice', 'bob', 1_000_000, 'day-first');
  await send(store, 'alice', 'bob', 1_000_000, 'day-second');
  assert.equal((await store.snapshot('alice')).limits.sentToday, 2_000_000);
  assert.equal((await store.snapshot('alice')).limits.available, 0);
  await ledgerFailure(() => send(store, 'alice', 'bob', 1_000, 'before-midnight-over'));
  time.advance(1);
  assert.deepEqual((await store.snapshot('alice')).limits, {
    perTransfer: 1_000_000, daily: 2_000_000, monthly: 5_000_000,
    sentToday: 0, sentMonth: 2_000_000, available: 1_000_000,
  });
  await send(store, 'alice', 'bob', 1_000_000, 'after-midnight');
  assert.equal((await store.snapshot('alice')).limits.sentToday, 1_000_000);
  assert.equal((await store.snapshot('alice')).limits.sentMonth, 3_000_000);
});

test('월 한도는 한국 월 경계에서 초기화하며 실패한 송금은 누계에 포함하지 않는다', async (t) => {
  const { store, time } = await fixture(t, Date.UTC(2026, 9, 28, 3));
  await member(store, 'alice', Date.UTC(2026, 0, 1)); await member(store, 'bob', Date.UTC(2026, 0, 1));
  await fund(store, 'alice', 10_000_000);
  for (let day = 0; day < 3; day++) {
    time.set(Date.UTC(2026, 9, 28 + day, 3));
    for (let transfer = 0; transfer < (day === 2 ? 1 : 2); transfer++) {
      await send(store, 'alice', 'bob', 1_000_000, `month-${day}-${transfer}`);
    }
  }
  time.set(Date.UTC(2026, 9, 31, 14, 59, 59, 999));
  assert.equal((await store.snapshot('alice')).limits.sentToday, 0);
  assert.equal((await store.snapshot('alice')).limits.sentMonth, 5_000_000);
  assert.equal((await store.snapshot('alice')).limits.available, 0);
  await ledgerFailure(() => send(store, 'alice', 'bob', 1_000, 'month-over'));
  time.advance(1);
  assert.equal((await store.snapshot('alice')).limits.sentMonth, 0);
  assert.equal((await store.snapshot('alice')).limits.available, 1_000_000);
  await send(store, 'alice', 'bob', 1_000, 'new-month');
  assert.equal((await store.snapshot('alice')).limits.sentToday, 1_000);
  assert.equal((await store.snapshot('alice')).limits.sentMonth, 1_000);
});

test('별도 PostgreSQL 연결의 동시 송금은 한 번만 지출하고 초과 출금을 허용하지 않는다', { timeout: 15_000 }, async (t) => {
  const context = await fixture(t);
  for (const id of ['alice', 'bob', 'carol']) await member(context.store, id, 0);
  await fund(context.store, 'alice', 500_000);
  const stores = [context.newStore(), context.newIndependentStore()];
  const results = await Promise.allSettled([
    send(stores[0], 'alice', 'bob', 400_000, 'race-bob'),
    send(stores[1], 'alice', 'carol', 400_000, 'race-carol'),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.ok(rejected.reason instanceof LedgerError);
  assert.equal(rejected.reason.code, 'INSUFFICIENT_FUNDS', '서로 다른 연결의 잔액 검사를 직렬화해야 한다');
  const sender = await context.store.snapshot('alice');
  const recipients = await Promise.all([context.store.snapshot('bob'), context.store.snapshot('carol')]);
  const received = recipients.reduce((total, account) => total + account.balanceWon, 0);
  assert.equal(sender.balanceWon, 100_000);
  assert.equal(received, 400_000);
  assert.equal(sender.balanceWon + received, 500_000);
  assert.equal(sender.transactions.filter((item) => item.direction === 'sent').length, 1);
});

test('서로 다른 연결에서 동시에 재전송한 같은 요청도 하나의 거래로 확정한다', { timeout: 15_000 }, async (t) => {
  const context = await fixture(t);
  await member(context.store, 'alice', 0); await member(context.store, 'bob', 0);
  await fund(context.store, 'alice', 500_000);
  const stores = [context.newStore(), context.newIndependentStore()];
  const results = await Promise.all([
    send(stores[0], 'alice', 'bob', 400_000, 'race-same-request'),
    send(stores[1], 'alice', 'bob', 400_000, 'race-same-request'),
  ]);
  assert.equal(results[0].transfer.id, results[1].transfer.id);
  assert.equal(results[0].balanceWon, results[1].balanceWon);
  assert.equal((await context.store.snapshot('alice')).balanceWon, 100_000);
  const recipient = await context.store.snapshot('bob');
  assert.equal(recipient.balanceWon, 400_000);
  assert.equal((await context.store.snapshot('alice')).transactions.filter((item) => item.direction === 'sent').length, 1);
  assert.equal(recipient.transactions.length, 1);
});

test('서로 다른 송금인의 동시 입금도 수신자 잔액의 정수 한도를 초과하지 않는다', { timeout: 15_000 }, async (t) => {
  const context = await fixture(t);
  for (const id of ['alice', 'bob', 'carol']) await member(context.store, id, 0);
  await fund(context.store, 'alice', 2_000);
  await fund(context.store, 'carol', 2_000);
  await fund(context.store, 'bob', Number.MAX_SAFE_INTEGER - 1_000);
  const stores = [context.newStore(), context.newIndependentStore()];
  const results = await Promise.allSettled([
    send(stores[0], 'alice', 'bob', 1_000, 'incoming-alice'),
    send(stores[1], 'carol', 'bob', 1_000, 'incoming-carol'),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.ok(rejected.reason instanceof LedgerError);
  assert.equal(rejected.reason.code, 'RECIPIENT_BALANCE_LIMIT');
  const accounts = await Promise.all(['alice', 'bob', 'carol'].map((id) => context.store.snapshot(id)));
  assert.equal(accounts[1].balanceWon, Number.MAX_SAFE_INTEGER);
  assert.equal(accounts.reduce((total, account) => total + BigInt(account.balanceWon), 0n), BigInt(Number.MAX_SAFE_INTEGER) + 3_000n);
  assert.equal(accounts[1].transactions.filter((item) => item.direction === 'received').length, 1);
});
