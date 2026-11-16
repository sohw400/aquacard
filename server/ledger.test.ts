import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { LedgerError, LedgerStore } from './ledger';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 3);

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'aqua-ledger-test-'));
  const filename = join(directory, 'ledger.sqlite');
  let store = new LedgerStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    filename,
    get store() { return store; },
    reopen() { store.close(); store = new LedgerStore(filename); return store; },
  };
}

function clock(t: TestContext, initial = NOW) {
  let now = initial;
  const original = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = original; });
  return { set(value: number) { now = value; }, advance(milliseconds: number) { now += milliseconds; } };
}

function member(store: LedgerStore, id: string, createdAt = NOW - 60 * DAY) {
  const names: Record<string, string> = { alice: '김민수', bob: '이서연', carol: '박지훈' };
  return store.createUser({ id, email: `${id}@example.test`, name: names[id] ?? `${id} 회원`, tag: id,
    passwordHash: `test-password-hash:${id}`, createdAt });
}

function fund(store: LedgerStore, userId: string, amountWon: number, idempotencyKey = `seed-${userId}`) {
  return store.creditSandbox({ userId, amountWon, idempotencyKey });
}

function send(store: LedgerStore, senderId: string, recipientTag: string, amountWon: number, idempotencyKey = 'transfer-1') {
  return store.transfer({ senderId, recipientTag, amountWon, idempotencyKey });
}

function ledgerFailure(run: () => unknown, status?: number) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof LedgerError, '원장 실패는 호출자가 처리할 수 있는 LedgerError여야 한다');
    assert.equal(typeof error.code, 'string');
    assert.ok(error.code.length > 0);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test('신규 계정은 잔액 0원이며 공개 스냅샷에 비밀번호 해시를 노출하지 않는다', (t) => {
  clock(t);
  const { store } = fixture(t);
  const user = member(store, 'alice');
  assert.equal(user.passwordHash, 'test-password-hash:alice');
  assert.equal(store.getUserById('alice')?.id, 'alice');
  assert.equal(store.getUserByEmail('alice@example.test')?.id, 'alice');
  assert.equal(store.getUserByTag('alice')?.id, 'alice');
  assert.equal(store.getUserById('missing') == null, true);
  const snapshot = store.snapshot('alice');
  assert.equal(snapshot.balanceWon, 0);
  assert.deepEqual(snapshot.transactions, []);
  assert.deepEqual(snapshot.user, { id: 'alice', email: 'alice@example.test', name: '김민수', tag: 'alice', createdAt: NOW - 60 * DAY });
  assert.equal(Object.hasOwn(snapshot.user, 'passwordHash'), false);
  assert.equal(JSON.stringify(snapshot).includes('test-password-hash:'), false);
  assert.equal(snapshot.limits.available, 0);
});

test('송금은 사용자 잔액 합계를 보존하고 양쪽에 같은 거래의 관점을 기록한다', (t) => {
  clock(t);
  const { store } = fixture(t);
  member(store, 'alice'); member(store, 'bob');
  const credit = fund(store, 'alice', 100_000);
  assert.equal(credit.transfer.direction, 'funded');
  assert.equal(credit.balanceWon, 100_000);
  const result = send(store, 'alice', 'bob', 23_456);
  const sender = store.snapshot('alice');
  const recipient = store.snapshot('bob');
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

test('모든 충전·송금은 원장에 균형을 맞춰 기록하고 기존 분개를 수정하거나 삭제할 수 없다', (t) => {
  clock(t);
  const { store } = fixture(t);
  member(store, 'alice'); member(store, 'bob');
  fund(store, 'alice', 100_000);
  const sent = send(store, 'alice', 'bob', 20_000);
  fund(store, 'bob', 10_000);
  const entries = store.db.prepare(`SELECT journal_id, COUNT(*) AS legs, SUM(amount_won) AS net_won
    FROM journal_entries GROUP BY journal_id`).all();
  assert.equal(entries.length, 3);
  for (const row of entries) {
    assert.equal(row.legs, 2);
    assert.equal(row.net_won, 0, `거래 ${row.journal_id}의 차변과 대변 합계가 0이어야 한다`);
  }
  const accounts = store.db.prepare('SELECT kind, user_id, balance_won FROM ledger_accounts').all();
  assert.equal(accounts.reduce((sum, account) => sum + Number(account.balance_won), 0), 0);
  assert.equal(accounts.filter((account) => account.user_id !== null).reduce((sum, account) => sum + Number(account.balance_won), 0), 110_000);
  assert.ok(accounts.some((account) => account.user_id === null && Number(account.balance_won) === -110_000), '샌드박스 충전도 반대 계정에 기록한다');
  const sender = store.snapshot('alice');
  const recipient = store.snapshot('bob');
  assert.throws(() => store.db.prepare('UPDATE journals SET amount_won = amount_won + 1 WHERE id = ?').run(sent.transfer.id));
  assert.throws(() => store.db.prepare('DELETE FROM journals WHERE id = ?').run(sent.transfer.id));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM journals').get()?.count, 3);
  assert.deepEqual(store.snapshot('alice'), sender);
  assert.deepEqual(store.snapshot('bob'), recipient);
});

test('같은 요청은 재시작 이후에도 한 번만 반영하고 다른 내용으로 재사용하면 충돌한다', (t) => {
  const time = clock(t);
  const context = fixture(t);
  member(context.store, 'alice'); member(context.store, 'bob'); member(context.store, 'carol');
  const credit = fund(context.store, 'alice', 100_000, 'persistent-credit');
  const sent = send(context.store, 'alice', 'bob', 20_000, 'persistent-transfer');
  time.advance(DAY);
  const store = context.reopen();
  const repeatedCredit = fund(store, 'alice', 100_000, 'persistent-credit');
  assert.equal(repeatedCredit.transfer.id, credit.transfer.id);
  assert.equal(repeatedCredit.balanceWon, 100_000, '동일 요청은 최초 확정 응답을 보존한다');
  const repeated = send(store, 'alice', ' @BOB ', 20_000, 'persistent-transfer');
  assert.equal(repeated.transfer.id, sent.transfer.id);
  assert.equal(store.snapshot('alice').balanceWon, 80_000);
  assert.equal(store.snapshot('bob').balanceWon, 20_000);
  assert.equal(store.snapshot('alice').transactions.length, 2);
  assert.equal(store.snapshot('bob').transactions.length, 1);
  assert.equal(store.snapshot('alice').limits.sentToday, 0, '이전 거래의 재시도는 오늘 사용량으로 다시 계산하지 않는다');
  ledgerFailure(() => send(store, 'alice', 'bob', 21_000, 'persistent-transfer'), 409);
  ledgerFailure(() => send(store, 'alice', 'carol', 20_000, 'persistent-transfer'), 409);
  ledgerFailure(() => fund(store, 'alice', 101_000, 'persistent-credit'), 409);
  ledgerFailure(() => send(store, 'alice', 'bob', 20_000, 'persistent-credit'), 409);
  assert.equal(store.snapshot('alice').balanceWon, 80_000);
  fund(store, 'carol', 5_000);
  send(store, 'carol', 'alice', 5_000, 'later-incoming');
  assert.equal(send(store, 'alice', 'bob', 20_000, 'persistent-transfer').balanceWon, 80_000);
  assert.equal(store.snapshot('alice').balanceWon, 85_000, '후속 입금이 있어도 원래 응답 재전송은 잔액을 덮어쓰지 않는다');
});

test('요청 키 범위는 보내는 사용자별이며 서로 다른 사용자의 같은 키를 허용한다', (t) => {
  clock(t);
  const { store } = fixture(t);
  for (const id of ['alice', 'bob', 'carol']) member(store, id);
  fund(store, 'alice', 10_000, 'same-seed');
  fund(store, 'bob', 10_000, 'same-seed');
  const first = send(store, 'alice', 'carol', 2_000, 'shared-request');
  const second = send(store, 'bob', 'carol', 3_000, 'shared-request');
  assert.notEqual(first.transfer.id, second.transfer.id);
  assert.equal(store.snapshot('alice').balanceWon, 8_000);
  assert.equal(store.snapshot('bob').balanceWon, 7_000);
  assert.equal(store.snapshot('carol').balanceWon, 5_000);
});

test('잔액 직접 수정과 INSERT OR REPLACE로 원장 불변성을 우회할 수 없다', (t) => {
  clock(t);
  const { store } = fixture(t);
  member(store, 'alice'); member(store, 'bob');
  fund(store, 'alice', 10_000);
  const result = send(store, 'alice', 'bob', 1_000);
  const before = store.snapshot('alice');
  assert.throws(() => store.db.prepare('UPDATE ledger_accounts SET balance_won = balance_won + 1000 WHERE user_id = ?').run('alice'), /must match the journal/);
  assert.throws(() => store.db.prepare(`INSERT OR REPLACE INTO journals SELECT
    id, kind, currency, from_account_id, to_account_id, amount_won, sender_id, recipient_id,
    sender_name, sender_tag, recipient_name, recipient_tag, request_owner_id, idempotency_key,
    request_payload, balance_after_won - amount_won, created_at FROM journals WHERE id = ?`).run(result.transfer.id), /immutable/);
  assert.deepEqual(store.snapshot('alice'), before);
  assert.equal(store.snapshot('bob').balanceWon, 1_000);
  assert.equal(store.db.prepare('SELECT SUM(balance_won) AS total FROM ledger_accounts').get()?.total, 0);
});

test('자기 송금·없는 수신자·잘못된 금액·잔액 부족은 잔액과 내역을 남기지 않는다', (t) => {
  clock(t);
  const { store } = fixture(t);
  member(store, 'alice'); member(store, 'bob');
  fund(store, 'alice', 10_000);
  const before = store.snapshot('alice');
  const beforeJournals = store.db.prepare('SELECT COUNT(*) AS count FROM journals').get()?.count;
  ledgerFailure(() => send(store, 'alice', 'alice', 1_000, 'self'));
  ledgerFailure(() => send(store, 'alice', 'unknown', 1_000, 'unknown'));
  ledgerFailure(() => send(store, 'alice', 'bob', 11_000, 'insufficient'));
  for (const [index, amount] of [0, -1, 999, 1_000.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].entries()) {
    ledgerFailure(() => send(store, 'alice', 'bob', amount, `bad-amount-${index}`));
    if (amount !== 999) ledgerFailure(() => fund(store, 'alice', amount, `bad-credit-${index}`));
  }
  assert.deepEqual(store.snapshot('alice'), before);
  assert.equal(store.snapshot('bob').balanceWon, 0);
  assert.deepEqual(store.snapshot('bob').transactions, []);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM journals').get()?.count, beforeJournals);
});

test('운영자용 샌드박스 충전은 1원 단위를 허용하고 회원 송금 최소 금액은 유지한다', (t) => {
  clock(t);
  const { store } = fixture(t);
  member(store, 'alice'); member(store, 'bob');
  assert.equal(fund(store, 'alice', 1, 'one-won').balanceWon, 1);
  ledgerFailure(() => send(store, 'alice', 'bob', 1, 'too-small-transfer'), 400);
  assert.equal(fund(store, 'alice', 999, 'remaining-won').balanceWon, 1_000);
  assert.equal(send(store, 'alice', 'bob', 1_000, 'minimum-transfer').balanceWon, 0);
  assert.equal(store.snapshot('bob').balanceWon, 1_000);
});

test('실패한 송금은 요청 키를 소비하지 않아 자금 보충 후 동일 요청을 성공시킬 수 있다', (t) => {
  clock(t);
  const { store } = fixture(t);
  member(store, 'alice'); member(store, 'bob');
  ledgerFailure(() => send(store, 'alice', 'bob', 5_000, 'retry-after-failure'));
  fund(store, 'alice', 5_000);
  const result = send(store, 'alice', 'bob', 5_000, 'retry-after-failure');
  assert.equal(result.balanceWon, 0);
  assert.equal(store.snapshot('bob').balanceWon, 5_000);
  assert.equal(store.snapshot('bob').transactions.length, 1);
});

test('수신자 잔액과 샌드박스 충전의 정수 범위 초과는 전체 거래를 롤백한다', (t) => {
  clock(t);
  const { store } = fixture(t);
  member(store, 'alice'); member(store, 'bob');
  fund(store, 'alice', 10_000);
  fund(store, 'bob', Number.MAX_SAFE_INTEGER);
  const sender = store.snapshot('alice');
  const recipient = store.snapshot('bob');
  ledgerFailure(() => send(store, 'alice', 'bob', 1_000, 'recipient-overflow'));
  ledgerFailure(() => fund(store, 'bob', 1_000, 'funding-overflow'));
  assert.deepEqual(store.snapshot('alice'), sender);
  assert.deepEqual(store.snapshot('bob'), recipient);
});

test('가입 첫 30일은 송금 한도를 절반 적용하고 정확히 30일 후 기본 한도로 전환한다', (t) => {
  const time = clock(t);
  const { store } = fixture(t);
  member(store, 'alice', NOW - 30 * DAY + 1); member(store, 'bob');
  fund(store, 'alice', 3_000_000);
  assert.deepEqual(store.snapshot('alice').limits, {
    perTransfer: 500_000, daily: 1_000_000, monthly: 2_500_000,
    sentToday: 0, sentMonth: 0, available: 500_000,
  });
  ledgerFailure(() => send(store, 'alice', 'bob', 500_001, 'new-per-transfer'));
  send(store, 'alice', 'bob', 500_000, 'new-first');
  send(store, 'alice', 'bob', 500_000, 'new-second');
  assert.equal(store.snapshot('alice').limits.available, 0);
  ledgerFailure(() => send(store, 'alice', 'bob', 1_000, 'new-day-limit'));
  time.advance(1);
  const mature = store.snapshot('alice').limits;
  assert.equal(mature.perTransfer, 1_000_000);
  assert.equal(mature.daily, 2_000_000);
  assert.equal(mature.monthly, 5_000_000);
  assert.equal(mature.sentToday, 1_000_000);
  assert.equal(mature.available, 1_000_000);
});

test('일 한도는 한국 자정에 초기화되고 같은 달 송금 누계는 유지한다', (t) => {
  const beforeMidnight = Date.UTC(2026, 10, 16, 14, 59, 59, 999);
  const time = clock(t, beforeMidnight);
  const { store } = fixture(t);
  member(store, 'alice'); member(store, 'bob');
  fund(store, 'alice', 10_000_000);
  send(store, 'alice', 'bob', 1_000_000, 'day-first');
  send(store, 'alice', 'bob', 1_000_000, 'day-second');
  assert.equal(store.snapshot('alice').limits.sentToday, 2_000_000);
  assert.equal(store.snapshot('alice').limits.available, 0);
  ledgerFailure(() => send(store, 'alice', 'bob', 1_000, 'before-midnight-over'));
  time.advance(1);
  assert.deepEqual(store.snapshot('alice').limits, {
    perTransfer: 1_000_000, daily: 2_000_000, monthly: 5_000_000,
    sentToday: 0, sentMonth: 2_000_000, available: 1_000_000,
  });
  send(store, 'alice', 'bob', 1_000_000, 'after-midnight');
  assert.equal(store.snapshot('alice').limits.sentToday, 1_000_000);
  assert.equal(store.snapshot('alice').limits.sentMonth, 3_000_000);
});

test('월 한도는 한국 월 경계에서 초기화하며 실패한 송금은 누계에 포함하지 않는다', (t) => {
  const time = clock(t, Date.UTC(2026, 9, 28, 3));
  const { store } = fixture(t);
  member(store, 'alice', Date.UTC(2026, 0, 1)); member(store, 'bob', Date.UTC(2026, 0, 1));
  fund(store, 'alice', 10_000_000);
  for (let day = 0; day < 3; day++) {
    time.set(Date.UTC(2026, 9, 28 + day, 3));
    for (let transfer = 0; transfer < (day === 2 ? 1 : 2); transfer++) {
      send(store, 'alice', 'bob', 1_000_000, `month-${day}-${transfer}`);
    }
  }
  time.set(Date.UTC(2026, 9, 31, 14, 59, 59, 999));
  assert.equal(store.snapshot('alice').limits.sentToday, 0);
  assert.equal(store.snapshot('alice').limits.sentMonth, 5_000_000);
  assert.equal(store.snapshot('alice').limits.available, 0);
  ledgerFailure(() => send(store, 'alice', 'bob', 1_000, 'month-over'));
  time.advance(1);
  assert.equal(store.snapshot('alice').limits.sentMonth, 0);
  assert.equal(store.snapshot('alice').limits.available, 1_000_000);
  send(store, 'alice', 'bob', 1_000, 'new-month');
  assert.equal(store.snapshot('alice').limits.sentToday, 1_000);
  assert.equal(store.snapshot('alice').limits.sentMonth, 1_000);
});

interface WorkerResult { ok: boolean; transferId?: string; code?: string; status?: number; message?: string }

function competingRequest(filename: string, gate: SharedArrayBuffer, recipientTag: string, idempotencyKey: string) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { pathToFileURL } = require('node:url');
    (async () => {
      const { LedgerStore } = await import(pathToFileURL(workerData.modulePath).href);
      const store = new LedgerStore(workerData.filename);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      try {
        const result = store.transfer({ senderId: 'alice', recipientTag: workerData.recipientTag,
          amountWon: 400_000, idempotencyKey: workerData.idempotencyKey });
        parentPort.postMessage({ result: { ok: true, transferId: result.transfer.id } });
      } catch (error) {
        parentPort.postMessage({ result: { ok: false, code: error.code, status: error.status, message: error.message } });
      } finally { store.close(); }
    })().catch((error) => { parentPort.postMessage({ fatal: error.stack }); process.exitCode = 1; });
  `, { eval: true, execArgv: ['--import', 'tsx'], workerData: {
    modulePath: fileURLToPath(new URL('./ledger.ts', import.meta.url)), filename, gate, recipientTag, idempotencyKey,
  } });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let resultResolve!: (result: WorkerResult) => void;
  let resultReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise<WorkerResult>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  // Both promises can fail during startup; attach a handler before awaiting either.
  void result.catch(() => {});
  worker.on('message', (message) => {
    if (message.ready) readyResolve();
    else if (message.result) resultResolve(message.result as WorkerResult);
    else if (message.fatal) { const error = new Error(message.fatal); readyReject(error); resultReject(error); }
  });
  worker.on('error', (cause) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    readyReject(error); resultReject(error);
  });
  worker.on('exit', (code) => {
    if (code !== 0) { const error = new Error(`경합 worker 종료 코드: ${code}`); readyReject(error); resultReject(error); }
  });
  return { worker, ready, result };
}

test('별도 SQLite 연결의 동시 송금은 한 번만 지출하고 초과 출금을 허용하지 않는다', { timeout: 15_000 }, async (t) => {
  const context = fixture(t);
  for (const id of ['alice', 'bob', 'carol']) member(context.store, id, 0);
  fund(context.store, 'alice', 500_000);
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const requests = [competingRequest(context.filename, gate, 'bob', 'race-bob'), competingRequest(context.filename, gate, 'carol', 'race-carol')];
  t.after(async () => { await Promise.all(requests.map(({ worker }) => worker.terminate())); });
  await Promise.all(requests.map(({ ready }) => ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const results = await Promise.all(requests.map(({ result }) => result));
  assert.equal(results.filter(({ ok }) => ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter(({ ok }) => !ok).length, 1);
  assert.equal(results.find(({ ok }) => !ok)?.code, 'INSUFFICIENT_FUNDS', 'DB 잠금 오류가 아닌 직렬화된 잔액 검사로 거절해야 한다');
  assert.equal(context.store.snapshot('alice').balanceWon, 100_000);
  const received = context.store.snapshot('bob').balanceWon + context.store.snapshot('carol').balanceWon;
  assert.equal(received, 400_000);
  assert.equal(context.store.snapshot('alice').balanceWon + received, 500_000);
  assert.equal(context.store.snapshot('alice').transactions.filter((item) => item.direction === 'sent').length, 1);
});

test('서로 다른 연결에서 동시에 재전송한 같은 요청도 하나의 거래로 확정한다', { timeout: 15_000 }, async (t) => {
  const context = fixture(t);
  member(context.store, 'alice', 0); member(context.store, 'bob', 0);
  fund(context.store, 'alice', 500_000);
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const requests = [competingRequest(context.filename, gate, 'bob', 'race-same-request'), competingRequest(context.filename, gate, 'bob', 'race-same-request')];
  t.after(async () => { await Promise.all(requests.map(({ worker }) => worker.terminate())); });
  await Promise.all(requests.map(({ ready }) => ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const results = await Promise.all(requests.map(({ result }) => result));
  assert.ok(results.every(({ ok }) => ok), JSON.stringify(results));
  assert.equal(results[0].transferId, results[1].transferId);
  assert.equal(context.store.snapshot('alice').balanceWon, 100_000);
  assert.equal(context.store.snapshot('bob').balanceWon, 400_000);
  assert.equal(context.store.snapshot('alice').transactions.filter((item) => item.direction === 'sent').length, 1);
  assert.equal(context.store.snapshot('bob').transactions.length, 1);
});
