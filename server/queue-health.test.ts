import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { AuthService } from './auth';
import { AuthMailOutbox, PostgresAuthMailQueue } from './auth-mail';
import { CardInboxStore } from './card-inbox';
import { CustomerAccessStore } from './customer-access';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerStore } from './ledger';
import { readQueueHealth } from './queue-health';
import { approveTestCustomer } from './test-customer-access';
import { createTestDatabase } from './test-support';

const start = Date.UTC(2026, 10, 26);
const idle = { dueCount: 0, oldestDueSeconds: 0, recentFailures: 0, needsReview: 0, blockedCount: 0 };

async function fixture(t: TestContext) {
  const base = await createTestDatabase();
  t.after(base.cleanup);
  let time = start;
  const now = () => time;
  const ledger = new LedgerStore(base.database, { now });
  const userId = 'queue-health-user';
  const email = 'queue-health@example.test';
  await ledger.createUser({ id: userId, email, name: '대기열 확인', tag: 'queue.health', passwordHash: 'fixture-hash', createdAt: start });
  return { ...base, ledger, userId, email, now, advance(ms: number) { time += ms; },
    health: () => readQueueHealth(base.database, now()) };
}

test('only eligible inbox work ages; an exhausted capture and its blocked successor remain visible until recovery', async (t) => {
  const f = await fixture(t);
  const inbox = new CardInboxStore(f.database, { now: f.now });
  assert.deepEqual(await f.health(), { cardInbox: idle, issuerOutbox: idle, authMail: idle });
  await inbox.enqueue({ kind: 'authorize', eventId: 'declined-card', paymentId: 'declined', userId: f.userId, merchantName: '정책 확인', amountWon: 100 });
  const declined = await inbox.processNext();
  assert.equal(declined?.status, 'dead_letter');
  assert.deepEqual((await f.health()).cardInbox, idle, 'ordinary authorization policy denial must not page operations');
  await new IssuerOutboxStore(f.database, { now: f.now }).register({ userId: f.userId, providerCardId: 'sandbox-card-policy', initialStatus: 'active' });
  await new CustomerAccessStore(f.database, { now: f.now }).transition({ userId: f.userId, status: 'active',
    expectedVersion: 1, idempotencyKey: 'access-reviewed', reason: 'Fixture approval before email verification' });
  await inbox.enqueue({ kind: 'authorize', eventId: 'unverified-email', paymentId: 'unverified', userId: f.userId, merchantName: '이메일 확인', amountWon: 100 });
  assert.equal((await inbox.processNext())?.errorCode, 'EMAIL_VERIFICATION_REQUIRED');
  assert.deepEqual((await f.health()).cardInbox, idle);

  await inbox.enqueue({ kind: 'capture', eventId: 'capture-first', paymentId: 'later-payment', userId: f.userId, amountWon: 100, finalCapture: false });
  await inbox.enqueue({ kind: 'reverse', eventId: 'reverse-after', paymentId: 'later-payment', userId: f.userId });
  f.advance(6_500);
  assert.deepEqual((await f.health()).cardInbox, { ...idle, dueCount: 1, oldestDueSeconds: 6, blockedCount: 1 });
  let result = await inbox.processNext(); assert.ok(result);
  assert.equal(result.status, 'retry');
  assert.deepEqual((await f.health()).cardInbox, { ...idle, blockedCount: 1 }, 'the first capture is now in backoff');
  for (let attempt = 2; attempt <= 8; attempt++) {
    assert.ok(result.nextAttemptAt);
    f.advance(result.nextAttemptAt - f.now() + 2_000);
    assert.deepEqual((await f.health()).cardInbox, { ...idle, dueCount: 1, oldestDueSeconds: 2, blockedCount: 1 });
    result = await inbox.processNext(); assert.ok(result);
  }
  assert.equal(result.status, 'dead_letter');
  assert.deepEqual((await f.health()).cardInbox, { ...idle, recentFailures: 1, needsReview: 1, blockedCount: 1 });
  f.advance(900_000);
  assert.deepEqual((await f.health()).cardInbox, { ...idle, needsReview: 1, blockedCount: 1 });
  await inbox.requeue({ id: result.id, expectedVersion: result.version, idempotencyKey: 'review-complete', reason: 'Retry following review of missing authorization' });
  assert.deepEqual((await f.health()).cardInbox, { ...idle, dueCount: 1, blockedCount: 1 });
});

test('issuer monitor ages expired leases and due retries from their eligibility time and distinguishes manual review from rejection', async (t) => {
  const f = await fixture(t);
  const outbox = new IssuerOutboxStore(f.database, { now: f.now });
  await approveTestCustomer(f.database, f.userId);
  const { cardId } = await outbox.register({ userId: f.userId, providerCardId: 'sandbox-card-monitor', initialStatus: 'active' });
  const card = (await outbox.snapshot(f.userId)).card; assert.ok(card);
  await outbox.requestStatus({ userId: f.userId, cardId, targetStatus: 'locked', expectedVersion: card.version, idempotencyKey: 'lock-health' });
  assert.equal((await f.health()).issuerOutbox.dueCount, 1);
  let claim = await outbox.claim(); assert.ok(claim);
  f.advance(29_999);
  assert.deepEqual((await f.health()).issuerOutbox, idle, 'an active lease is legitimate processing');
  f.advance(2_001);
  assert.deepEqual((await f.health()).issuerOutbox, { ...idle, dueCount: 1, oldestDueSeconds: 2 });
  claim = await outbox.claim(); assert.ok(claim);
  const retry = await outbox.finish({ id: claim.id, expectedVersion: claim.version, leaseToken: claim.leaseToken, outcome: { kind: 'uncertain' } });
  assert.ok(retry.nextAttemptAt);
  assert.deepEqual((await f.health()).issuerOutbox, idle);
  f.advance(retry.nextAttemptAt - f.now() + 4_000);
  assert.deepEqual((await f.health()).issuerOutbox, { ...idle, dueCount: 1, oldestDueSeconds: 4 });
  claim = await outbox.claim(); assert.ok(claim);
  const review = await outbox.finish({ id: claim.id, expectedVersion: claim.version, leaseToken: claim.leaseToken,
    outcome: { kind: 'uncertain', code: 'IDEMPOTENCY_WINDOW_EXPIRED' } });
  f.advance(1_000_000);
  assert.deepEqual((await f.health()).issuerOutbox, { ...idle, needsReview: 1 });
  await outbox.requeue({ id: review.id, expectedVersion: review.version, idempotencyKey: 'issuer-review-complete', reason: 'Reconcile issuer status after manual investigation' });
  claim = await outbox.claim(); assert.ok(claim);
  await outbox.finish({ id: claim.id, expectedVersion: claim.version, leaseToken: claim.leaseToken, outcome: { kind: 'rejected' } });
  assert.deepEqual((await f.health()).issuerOutbox, { ...idle, recentFailures: 1 });
  f.advance(900_000);
  assert.deepEqual((await f.health()).issuerOutbox, idle);
});

test('mail separates eligible work, superseded challenges, rejected deliveries and expiry before delivery', async (t) => {
  const f = await fixture(t);
  const mailQueue = new PostgresAuthMailQueue(f.schema, { activeKeyId: 'test', keys: new Map([['test', randomBytes(32)]]) });
  const auth = new AuthService(f.ledger, { now: f.now, mailQueue });
  const outbox = new AuthMailOutbox(f.database, f.now);
  await auth.requestRecovery(f.email, '127.0.0.1');
  f.advance(1);
  await auth.requestRecovery(f.email, '127.0.0.1');
  f.advance(5_000);
  assert.deepEqual((await f.health()).authMail, { ...idle, dueCount: 2, oldestDueSeconds: 5 });
  let claim = await outbox.claim(); assert.ok(claim);
  assert.deepEqual((await f.health()).authMail, idle, 'a superseded challenge was discarded and its replacement is leased');
  f.advance(32_000);
  assert.deepEqual((await f.health()).authMail, { ...idle, dueCount: 1, oldestDueSeconds: 2 });
  claim = await outbox.claim(); assert.ok(claim);
  await outbox.finish({ id: claim.id, expectedVersion: claim.version, leaseToken: claim.leaseToken, outcome: 'retry', errorCode: 'DELIVERY_UNAVAILABLE' });
  assert.deepEqual((await f.health()).authMail, idle);
  f.advance(7_000);
  assert.deepEqual((await f.health()).authMail, { ...idle, dueCount: 1, oldestDueSeconds: 2 });
  claim = await outbox.claim(); assert.ok(claim);
  await outbox.finish({ id: claim.id, expectedVersion: claim.version, leaseToken: claim.leaseToken, outcome: 'failed', errorCode: 'DELIVERY_REJECTED' });
  assert.deepEqual((await f.health()).authMail, { ...idle, recentFailures: 1 });
  await auth.requestRecovery(f.email, '127.0.0.1');
  f.advance(900_000);
  assert.equal(await outbox.claim(), null, 'expired unsent mail must be discarded');
  assert.deepEqual((await f.health()).authMail, { ...idle, recentFailures: 1 });
  f.advance(900_000);
  assert.deepEqual((await f.health()).authMail, idle);
});
