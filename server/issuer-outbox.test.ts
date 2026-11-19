import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Database } from './database';
import { LedgerError, LedgerStore } from './ledger';
import { IssuerOutboxStore, type IssuerOutboxFinishInput, type IssuerOutboxOutcome } from './issuer-outbox';
import { RewardsStore } from './rewards';
import { reconcileRewards } from './reward-reconciliation';
import { createTestDatabase } from './test-support';

const NOW = Date.UTC(2026, 10, 19, 4);
const DAY = 86_400_000;
type Claim = NonNullable<Awaited<ReturnType<IssuerOutboxStore['claim']>>>;
type Finish = Awaited<ReturnType<IssuerOutboxStore['finish']>>;

async function fixture(t: TestContext, register = true) {
  const base = await createTestDatabase();
  let now = NOW;
  let sequence = 0;
  const peers: Database[] = [];
  const stores = (database: Database) => ({ database, outbox: new IssuerOutboxStore(database, { now: () => now }) });
  const main = stores(base.database);
  const ledger = new LedgerStore(base.database, { now: () => now });
  const rewards = new RewardsStore(base.database, { now: () => now });
  t.after(async () => { try { await Promise.all(peers.map((database) => database.close())); } finally { await base.cleanup(); } });
  for (const id of ['alice', 'bobby']) await ledger.createUser({ id, email: `${id}@example.test`, name: '발급사 요청 테스트', tag: id,
    passwordHash: 'test-only-hash', createdAt: NOW - DAY });
  if (register) await main.outbox.register({ userId: 'alice', providerCardId: 'sandbox-card-alice', initialStatus: 'active' });
  return {
    ...main, ledger, rewards, key: (prefix = 'issuer') => `${prefix}-${++sequence}`,
    now: () => now, setTime(value: number) { now = value; }, advance(value: number) { now += value; },
    peer() { const database = new Database({ connectionString: base.connectionString, schema: base.schema, maxConnections: 3 }); peers.push(database); return stores(database); },
    async input(targetStatus: 'active' | 'locked' = 'locked', userId = 'alice') {
      const card = (await main.outbox.snapshot(userId)).card; assert.ok(card);
      return { userId, cardId: card.id, targetStatus, expectedVersion: card.version, idempotencyKey: `issuer-request-${++sequence}` };
    },
  };
}

async function rejectCode(action: Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof LedgerError && error.code === code);
}
async function claim(store: IssuerOutboxStore): Promise<Claim> {
  const result = await store.claim(); assert.ok(result, 'a due command must be claimable'); return result;
}
function finishInput(value: Claim, kind: 'succeeded' | 'rejected' | 'uncertain' | 'not_found', code?: string): IssuerOutboxFinishInput {
  // Some tests deliberately pass an invalid provider code to exercise the runtime boundary.
  return { id: value.id, leaseToken: value.leaseToken, expectedVersion: value.version,
    outcome: (code === undefined ? { kind } : { kind, code }) as IssuerOutboxOutcome };
}
async function financialFingerprint(database: Database) {
  const tables = ['ledger_accounts', 'journals', 'card_payments', 'card_payment_events', 'reward_wallets', 'reward_cashback_months', 'card_reward_allocations', 'reward_journals', 'reward_cash_plans'];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table,
    (await database.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows] as const)));
}

test('card status requests persist desired state without confirming it or changing any monetary ledger', async (t) => {
  const f = await fixture(t);
  await f.ledger.creditSandbox({ userId: 'alice', amountWon: 20_000, idempotencyKey: 'outbox-principal' });
  await f.rewards.fundBudget({ amountWon: 10_000, idempotencyKey: 'outbox-company-budget' });
  await f.rewards.setProgram({ enabled: true, idempotencyKey: 'outbox-reward-program' });
  await f.rewards.grant({ userId: 'alice', amountWon: 1_000, idempotencyKey: 'outbox-reward-grant' });
  const money = await financialFingerprint(f.database);
  const input = await f.input();
  const receipt = await f.outbox.requestStatus(input);
  assert.deepEqual([receipt.status, receipt.cardVersion, receipt.duplicate], ['pending', input.expectedVersion + 1, false]);
  let card = (await f.outbox.snapshot('alice')).card; assert.ok(card);
  assert.deepEqual([card.desiredStatus, card.confirmedStatus, card.command?.status], ['locked', 'active', 'pending']);
  const leased = await claim(f.outbox);
  assert.deepEqual([leased.id, leased.phase, leased.attemptCount], [receipt.id, 'send', 1]);
  assert.equal((await f.outbox.snapshot('alice')).card?.confirmedStatus, 'active');
  await f.outbox.finish(finishInput(leased, 'succeeded'));
  card = (await f.outbox.snapshot('alice')).card; assert.ok(card);
  assert.deepEqual([card.desiredStatus, card.confirmedStatus, card.command?.status], ['locked', 'locked', 'succeeded']);
  assert.ok(card.version > receipt.cardVersion);
  assert.deepEqual(await financialFingerprint(f.database), money);
  const report = await reconcileRewards(f.database); assert.equal(report.ok, true, JSON.stringify(report.findings));
});

test('card registration is idempotent without resetting a changed card and rejects conflicting provider mappings', async (t) => {
  const f = await fixture(t, false);
  assert.deepEqual(await f.outbox.snapshot('alice'), { mode: 'sandbox', card: null });
  const input = { userId: 'alice', providerCardId: 'sandbox-card-alice', initialStatus: 'active' as const };
  const registered = await f.outbox.register(input);
  assert.deepEqual(await f.peer().outbox.register(input), registered);
  await f.outbox.requestStatus(await f.input());
  await f.outbox.finish(finishInput(await claim(f.outbox), 'succeeded'));
  const before = await f.outbox.snapshot('alice');
  assert.deepEqual(await f.outbox.register(input), registered);
  assert.deepEqual(await f.outbox.snapshot('alice'), before);
  await rejectCode(f.outbox.register({ ...input, providerCardId: 'sandbox-card-other' }), 'OUTBOX_CARD_CONFLICT');
  await rejectCode(f.outbox.register({ ...input, initialStatus: 'locked' }), 'OUTBOX_CARD_CONFLICT');
  await rejectCode(f.outbox.register({ ...input, userId: 'bobby' }), 'OUTBOX_CARD_CONFLICT');
});

test('concurrent duplicate requests create one command while a reused key with changed content conflicts', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t); const peer = f.peer(); const input = await f.input();
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? peer.outbox : f.outbox).requestStatus(input)));
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM issuer_outbox')).rows[0].count, 1);
  await rejectCode(f.outbox.requestStatus({ ...input, targetStatus: 'active' }), 'IDEMPOTENCY_CONFLICT');
  await rejectCode(f.outbox.requestStatus({ ...input, expectedVersion: input.expectedVersion + 1 }), 'IDEMPOTENCY_CONFLICT');
  const leased = await claim(f.outbox); await f.outbox.finish(finishInput(leased, 'succeeded'));
  const before = await f.outbox.snapshot('alice');
  const replay = await peer.outbox.requestStatus(input);
  assert.equal(replay.id, results[0].id); assert.equal(replay.duplicate, true);
  assert.equal(replay.cardVersion, results[0].cardVersion);
  assert.deepEqual(await f.outbox.snapshot('alice'), before, 'a lost request reply cannot enqueue another status change');
});

test('ownership, card version and outstanding commands prevent stale or opposite card changes', async (t) => {
  const f = await fixture(t); const original = await f.input();
  await rejectCode(f.outbox.requestStatus({ ...original, userId: 'bobby' }), 'OUTBOX_CARD_NOT_FOUND');
  await rejectCode(f.outbox.requestStatus({ ...original, expectedVersion: original.expectedVersion + 1 }), 'OUTBOX_VERSION_CHANGED');
  await f.outbox.requestStatus(original);
  await rejectCode(f.outbox.requestStatus({ ...original, idempotencyKey: 'stale-card-request' }), 'OUTBOX_VERSION_CHANGED');
  await rejectCode(f.outbox.requestStatus(await f.input('active')), 'OUTBOX_PENDING');
  const leased = await claim(f.outbox);
  await rejectCode(f.outbox.requestStatus(await f.input('active')), 'OUTBOX_PENDING');
  const retry = await f.outbox.finish(finishInput(leased, 'uncertain', 'PROVIDER_TIMEOUT'));
  assert.equal(retry.status, 'retry');
  await rejectCode(f.outbox.requestStatus(await f.input('active')), 'OUTBOX_PENDING');
  assert.equal((await f.outbox.snapshot('alice')).card?.confirmedStatus, 'active');
});

test('simultaneous opposite requests at one card version cannot create competing provider commands', async (t) => {
  const f = await fixture(t); const peer = f.peer(); const input = await f.input();
  const results = await Promise.allSettled([
    f.outbox.requestStatus(input),
    peer.outbox.requestStatus({ ...input, targetStatus: 'active', idempotencyKey: 'opposite-request' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected'); assert.ok(failed?.status === 'rejected');
  assert.ok(failed.reason instanceof LedgerError);
  assert.ok(['OUTBOX_VERSION_CHANGED', 'OUTBOX_PENDING'].includes(failed.reason.code));
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM issuer_outbox')).rows[0].count, 1);
  const winner = await claim(f.outbox);
  assert.equal((await f.outbox.snapshot('alice')).card?.desiredStatus, winner.targetStatus);
  assert.equal(await peer.outbox.claim(), null);
});

test('a failed outbox insertion rolls back the requested card state and does not consume the request key', async (t) => {
  const f = await fixture(t); const input = await f.input(); const before = await f.outbox.snapshot('alice');
  await f.database.query(`CREATE FUNCTION test_reject_issuer_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture fails after card update'; END; $$;
    CREATE TRIGGER test_reject_issuer_insert AFTER INSERT ON issuer_outbox FOR EACH ROW EXECUTE FUNCTION test_reject_issuer_outbox()`);
  await assert.rejects(f.outbox.requestStatus(input));
  assert.deepEqual(await f.outbox.snapshot('alice'), before);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM issuer_outbox')).rows[0].count, 0);
  await f.database.query('DROP TRIGGER test_reject_issuer_insert ON issuer_outbox');
  const accepted = await f.outbox.requestStatus(input); assert.equal(accepted.duplicate, false);
});

test('two dispatchers cannot claim the same command and an unrelated card can progress independently', async (t) => {
  const f = await fixture(t); const peer = f.peer();
  const firstInput = await f.input(); const first = await f.outbox.requestStatus(firstInput);
  const claims = await Promise.all([f.outbox.claim(), peer.outbox.claim()]);
  assert.equal(claims.filter(Boolean).length, 1); assert.equal(claims.find(Boolean)?.id, first.id);
  await f.outbox.register({ userId: 'bobby', providerCardId: 'sandbox-card-bobby', initialStatus: 'active' });
  const second = await f.outbox.requestStatus({ ...await f.input('locked', 'bobby'), idempotencyKey: firstInput.idempotencyKey });
  const other = await claim(peer.outbox); assert.equal(other.id, second.id);
  await peer.outbox.finish(finishInput(other, 'succeeded'));
  assert.equal((await f.outbox.snapshot('bobby')).card?.confirmedStatus, 'locked');
  assert.equal((await f.outbox.snapshot('alice')).card?.confirmedStatus, 'active');
  assert.equal(await f.outbox.claim(), null);
});

test('expired leases recover with lookup and fence out both expired and superseded worker completions', async (t) => {
  const f = await fixture(t); const peer = f.peer();
  await f.outbox.requestStatus(await f.input());
  const original = await claim(f.outbox);
  f.setTime(original.leaseUntil);
  await rejectCode(f.outbox.finish(finishInput(original, 'succeeded')), 'OUTBOX_LEASE_LOST');
  const replacement = await claim(peer.outbox);
  assert.equal(replacement.id, original.id); assert.equal(replacement.requestKey, original.requestKey);
  assert.equal(replacement.phase, 'lookup'); assert.equal(replacement.attemptCount, 2);
  assert.notEqual(replacement.leaseToken, original.leaseToken); assert.ok(replacement.version > original.version);
  await rejectCode(f.outbox.finish(finishInput(original, 'succeeded')), 'OUTBOX_LEASE_LOST');
  await peer.outbox.finish(finishInput(replacement, 'succeeded'));
  assert.equal((await f.outbox.snapshot('alice')).card?.confirmedStatus, 'locked');
  assert.equal(await f.outbox.claim(), null);
});

test('a lost completion reply is resolved idempotently without accepting a changed result for the same lease', async (t) => {
  const f = await fixture(t); await f.outbox.requestStatus(await f.input());
  const leased = await claim(f.outbox); const input = finishInput(leased, 'succeeded');
  const result = await f.outbox.finish(input); const before = await f.outbox.snapshot('alice');
  f.advance(2 * DAY);
  assert.deepEqual(await f.peer().outbox.finish(input), result);
  assert.deepEqual(await f.outbox.snapshot('alice'), before);
  await rejectCode(f.outbox.finish(finishInput(leased, 'rejected', 'CARD_CLOSED')), 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM issuer_outbox_completions')).rows[0].count, 1);
});

test('a deferred completion failure rolls back confirmed status and audit results without losing the active lease', async (t) => {
  const f = await fixture(t); await f.outbox.requestStatus(await f.input()); const leased = await claim(f.outbox);
  const before = await f.outbox.snapshot('alice');
  await f.database.query(`CREATE FUNCTION test_reject_issuer_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture refuses completion commit'; END; $$;
    CREATE CONSTRAINT TRIGGER test_reject_issuer_completion AFTER INSERT ON issuer_outbox_completions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_reject_issuer_completion()`);
  await assert.rejects(f.outbox.finish(finishInput(leased, 'succeeded')));
  assert.deepEqual(await f.outbox.snapshot('alice'), before);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM issuer_outbox_completions')).rows[0].count, 0);
  await f.database.query('DROP TRIGGER test_reject_issuer_completion ON issuer_outbox_completions');
  const recovered = await f.outbox.finish(finishInput(leased, 'succeeded'));
  assert.equal(recovered.status, 'succeeded'); assert.equal((await f.outbox.snapshot('alice')).card?.confirmedStatus, 'locked');
});

test('an ambiguous send requires lookup and authoritative absence before retransmitting the same key', async (t) => {
  const f = await fixture(t); await f.outbox.requestStatus(await f.input());
  const first = await claim(f.outbox);
  const retry = await f.outbox.finish(finishInput(first, 'uncertain', 'PROVIDER_TIMEOUT'));
  assert.equal(retry.status, 'retry'); assert.ok(retry.nextAttemptAt! > f.now());
  assert.equal(await f.outbox.claim(), null);
  f.setTime(retry.nextAttemptAt!);
  const lookup = await claim(f.outbox); assert.equal(lookup.phase, 'lookup'); assert.equal(lookup.requestKey, first.requestKey);
  const absent = await f.outbox.finish(finishInput(lookup, 'not_found'));
  assert.equal(absent.status, 'retry'); f.setTime(absent.nextAttemptAt!);
  const resent = await claim(f.outbox); assert.equal(resent.phase, 'send'); assert.equal(resent.requestKey, first.requestKey);
  assert.equal(resent.expiresAt, first.expiresAt); assert.equal(resent.attemptCount, 3);
  await f.outbox.finish(finishInput(resent, 'succeeded'));
  assert.equal((await f.outbox.snapshot('alice')).card?.confirmedStatus, 'locked');
});

test('an authoritative absence cannot be claimed as a send result or forge a terminal rejection', async (t) => {
  const f = await fixture(t); await f.outbox.requestStatus(await f.input()); const leased = await claim(f.outbox);
  await assert.rejects(f.outbox.finish(finishInput(leased, 'not_found')));
  await assert.rejects(f.outbox.finish(finishInput(leased, 'rejected', 'PRIVATE_VENDOR_DETAIL')));
  assert.equal((await f.outbox.snapshot('alice')).card?.command?.status, 'in_flight');
  await f.outbox.finish(finishInput(leased, 'succeeded'));
});

test('an expired first-send deadline stops dispatch while review recovery retains the original key and deadline', async (t) => {
  const f = await fixture(t); const receipt = await f.outbox.requestStatus(await f.input());
  f.advance(DAY);
  assert.equal(await f.outbox.claim(), null, 'a send beyond the fixed idempotency window must not leave the database');
  const card = (await f.outbox.snapshot('alice')).card; assert.ok(card?.command);
  assert.equal(card.command.status, 'needs_review'); assert.equal(card.command.errorCode, 'IDEMPOTENCY_WINDOW_EXPIRED');
  assert.equal(card.confirmedStatus, 'active');
  const stored = (await f.database.query('SELECT * FROM issuer_outbox WHERE id=$1', [receipt.id])).rows[0];
  const requeue = await f.outbox.requeue({ id: receipt.id, expectedVersion: Number(stored.version), idempotencyKey: 'expired-card-review', reason: 'Read issuer operation status after the original delivery deadline.' });
  const lookup = await claim(f.outbox);
  assert.equal(lookup.phase, 'lookup'); assert.equal(lookup.expiresAt, NOW + DAY);
  assert.equal(lookup.requestKey, stored.request_key);
  assert.ok(lookup.version > requeue.version);
  const result = await f.outbox.finish(finishInput(lookup, 'not_found'));
  assert.equal(result.status, 'needs_review'); assert.equal(result.errorCode, 'IDEMPOTENCY_WINDOW_EXPIRED');
  assert.equal(await f.outbox.claim(), null);
  await rejectCode(f.outbox.requestStatus(await f.input('active')), 'OUTBOX_PENDING');
});

test('a lookup after key expiry can confirm an accepted command but never schedules another send', async (t) => {
  const f = await fixture(t); await f.outbox.requestStatus(await f.input()); const first = await claim(f.outbox);
  await f.outbox.finish(finishInput(first, 'uncertain', 'PROVIDER_UNAVAILABLE'));
  f.setTime(first.expiresAt + DAY);
  const lookup = await claim(f.outbox);
  assert.equal(lookup.phase, 'lookup'); assert.equal(lookup.requestKey, first.requestKey);
  await f.outbox.finish(finishInput(lookup, 'succeeded'));
  assert.equal((await f.outbox.snapshot('alice')).card?.confirmedStatus, 'locked');
});

test('eight claimed attempts exhaust into review and an audited CAS retry cannot replace the key or extend its lifetime', async (t) => {
  const f = await fixture(t); const receipt = await f.outbox.requestStatus(await f.input());
  let first: Claim | undefined; let completed: Finish | undefined;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const current = await claim(f.outbox); first ??= current;
    assert.equal(current.attemptCount, attempt);
    assert.equal(current.phase, attempt === 1 ? 'send' : 'lookup');
    completed = await f.outbox.finish(finishInput(current, 'uncertain', 'PROVIDER_UNAVAILABLE'));
    assert.equal(completed.status, attempt === 8 ? 'needs_review' : 'retry');
    if (attempt < 8) { assert.equal(await f.outbox.claim(), null); f.setTime(completed.nextAttemptAt!); }
  }
  assert.ok(completed); assert.ok(first);
  assert.equal(await f.outbox.claim(), null);
  await rejectCode(f.outbox.requestStatus(await f.input('active')), 'OUTBOX_PENDING');
  const input = { id: receipt.id, expectedVersion: completed.version, idempotencyKey: 'issuer-reviewed-001', reason: 'Issuer lookup service recovered; retry lookup without changing the original request.' };
  await rejectCode(f.outbox.requeue({ ...input, expectedVersion: completed.version - 1, idempotencyKey: 'stale-issuer-review' }), 'OUTBOX_VERSION_CHANGED');
  const requeued = await f.outbox.requeue(input);
  assert.deepEqual(await f.peer().outbox.requeue(input), requeued);
  await rejectCode(f.outbox.requeue({ ...input, reason: 'Different review must never reuse the original audit request key.' }), 'IDEMPOTENCY_CONFLICT');
  const recovered = await claim(f.outbox);
  assert.equal(recovered.phase, 'lookup'); assert.equal(recovered.attemptCount, 9);
  assert.equal(recovered.requestKey, first.requestKey); assert.equal(recovered.expiresAt, first.expiresAt);
  const stored = (await f.database.query('SELECT cycle_attempts FROM issuer_outbox WHERE id=$1', [receipt.id])).rows[0];
  assert.equal(stored.cycle_attempts, 1);
  await f.outbox.finish(finishInput(recovered, 'succeeded'));
  assert.deepEqual(await f.outbox.requeue(input), requeued);
  assert.equal(await f.outbox.claim(), null);
  const audits = (await f.database.query('SELECT * FROM issuer_outbox_requeues')).rows;
  assert.equal(audits.length, 1); assert.equal(audits[0].reason, input.reason);
  assert.equal(audits[0].actor, (await f.database.query('SELECT session_user AS actor')).rows[0].actor);
});

test('eight interrupted workers exhaust their committed claims instead of reclaiming indefinitely', async (t) => {
  const f = await fixture(t); await f.outbox.requestStatus(await f.input());
  let originalKey: string | undefined;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const leased = await claim(f.outbox); originalKey ??= leased.requestKey;
    assert.equal(leased.requestKey, originalKey); assert.equal(leased.attemptCount, attempt);
    assert.equal(leased.phase, attempt === 1 ? 'send' : 'lookup');
    f.setTime(leased.leaseUntil);
  }
  assert.equal(await f.outbox.claim(), null);
  const current = (await f.outbox.snapshot('alice')).card;
  assert.equal(current?.command?.status, 'needs_review'); assert.equal(current?.confirmedStatus, 'active');
  assert.equal(current?.command?.attemptCount, 8);
});

test('an explicit issuer rejection is terminal, leaves the confirmed card unchanged and permits a new versioned command', async (t) => {
  const f = await fixture(t); await f.outbox.requestStatus(await f.input()); const leased = await claim(f.outbox);
  const failed = await f.outbox.finish(finishInput(leased, 'rejected', 'CARD_CLOSED'));
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'CARD_CLOSED');
  assert.equal((await f.outbox.snapshot('alice')).card?.confirmedStatus, 'active');
  assert.equal(await f.outbox.claim(), null);
  await rejectCode(f.outbox.requeue({ id: leased.id, expectedVersion: failed.version, idempotencyKey: 'rejected-command-review', reason: 'A definitive rejection must not be resubmitted under the same operation.' }), 'OUTBOX_NOT_RETRYABLE');
  const next = await f.outbox.requestStatus(await f.input('active')); assert.notEqual(next.id, leased.id);
  const nextClaim = await claim(f.outbox); assert.notEqual(nextClaim.requestKey, leased.requestKey);
});

test('connection termination before claim commit rolls back the lease while a committed claim survives reconnection', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t); const peer = f.peer(); const receipt = await f.outbox.requestStatus(await f.input());
  const client = await f.database.pool.connect(); client.on('error', () => {});
  try {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await client.query('BEGIN');
    const tentative = (await client.query('SELECT claim_issuer_outbox($1::bigint) AS result', [f.now()])).rows[0].result;
    assert.equal(tentative.id, receipt.id); assert.equal(tentative.phase, 'send');
    assert.equal(await peer.outbox.claim(), null, 'a second worker must not block behind or duplicate an uncommitted claim');
    assert.equal((await peer.outbox.snapshot('alice')).card?.command?.status, 'pending');
    assert.equal((await f.database.query('SELECT pg_terminate_backend($1) AS stopped', [pid])).rows[0].stopped, true);
    await assert.rejects(client.query('COMMIT'));
  } finally { client.release(true); }
  const committed = await claim(peer.outbox); assert.equal(committed.attemptCount, 1);
  await peer.database.close();
  const restarted = f.peer(); assert.equal(await restarted.outbox.claim(), null);
  f.setTime(committed.leaseUntil);
  const recovery = await claim(restarted.outbox);
  assert.equal(recovery.id, committed.id); assert.equal(recovery.phase, 'lookup'); assert.equal(recovery.requestKey, committed.requestKey);
});

test('direct SQL validates command fields and immutable issuer identities, results and audit history resist rewriting', async (t) => {
  const f = await fixture(t); const input = await f.input();
  await assert.rejects(f.database.query('SELECT request_issuer_card_status($1::jsonb,$2::bigint)', [JSON.stringify({ ...input, providerCardId: 'sandbox-card-forged' }), f.now()]));
  await assert.rejects(f.database.query('SELECT request_issuer_card_status($1::jsonb,$2::bigint)', [JSON.stringify({ ...input, targetStatus: 'deleted' }), f.now()]));
  await assert.rejects(f.database.query('SELECT claim_issuer_outbox($1::bigint)', [null]));
  const receipt = await f.outbox.requestStatus(input); const leased = await claim(f.outbox);
  await f.outbox.finish(finishInput(leased, 'succeeded'));
  const before = await f.outbox.snapshot('alice');
  await assert.rejects(f.database.query("UPDATE issuer_cards SET confirmed_status='active'"));
  await assert.rejects(f.database.query("UPDATE issuer_outbox SET request_key='aqua-forged' WHERE id=$1", [receipt.id]));
  await assert.rejects(f.database.query('UPDATE issuer_outbox SET expires_at=expires_at+1 WHERE id=$1', [receipt.id]));
  await assert.rejects(f.database.query("UPDATE issuer_outbox_audit SET kind='forged'"));
  await assert.rejects(f.database.query('DELETE FROM issuer_outbox_audit'));
  await assert.rejects(f.database.query("UPDATE issuer_outbox_completions SET result='{}'::jsonb"));
  await assert.rejects(f.database.query('TRUNCATE issuer_outbox CASCADE'));
  assert.deepEqual(await f.outbox.snapshot('alice'), before);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM issuer_outbox')).rows[0].count, 1);
});
