import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from './database';
import { applyMigrations } from './migrations';
import { CardInboxStore } from './card-inbox';
import { CardPaymentStore } from './card-payments';
import { LedgerStore } from './ledger';
import { IssuerOutboxStore } from './issuer-outbox';
import { RewardsStore } from './rewards';
import { reconcileRewards } from './reward-reconciliation';
import { approveTestCustomer } from './test-customer-access';
import { createTestDatabase } from './test-support';

const start = Date.UTC(2025, 10, 26, 3);
const day = 86_400_000;
const deadline = start + 7 * day;
const authorize = (paymentId: string) => ({ kind: 'authorize' as const, userId: 'alice', paymentId,
  eventId: 'auth-' + paymentId, amountWon: 100, merchantName: '테스트 상점' });
const capture = (paymentId: string, eventId: string, amountWon: number, finalCapture = true) => ({
  kind: 'capture' as const, userId: 'alice', paymentId, eventId, amountWon, finalCapture,
});

async function fixture(t: TestContext) {
  const base = await createTestDatabase();
  t.after(base.cleanup);
  let now = start;
  const clock = { now: () => now };
  const ledger = new LedgerStore(base.database, clock);
  const inbox = new CardInboxStore(base.database, clock);
  const cards = new CardPaymentStore(base.database, clock);
  const rewards = new RewardsStore(base.database, clock);
  await ledger.createUser({ id:'alice', email:'alice@example.test', name:'테스트', tag:'alice',
    createdAt:start - day, passwordHash:'test-only' });
  await approveTestCustomer(base.database, 'alice');
  await new IssuerOutboxStore(base.database, clock).register({ userId:'alice', providerCardId:'sandbox-card-hold', initialStatus:'active' });
  await ledger.creditSandbox({ userId:'alice', amountWon:1_000, idempotencyKey:'credit' });
  return { ...base, ledger, inbox, cards, rewards, setTime(v: number) { now = v; } };
}

test('hold expires once at its snapshotted deadline; partial captures, refunds and original reward backing survive', async t => {
  const f = await fixture(t);
  await f.rewards.fundBudget({ amountWon:1_000, idempotencyKey:'budget' });
  await f.rewards.setProgram({ enabled:true, idempotencyKey:'enable' });
  await f.rewards.grant({ userId:'alice', amountWon:30, idempotencyKey:'grant' });
  await f.cards.apply(authorize('mixed'));
  const partial = capture('mixed','early-partial',40,false);
  await f.cards.apply(partial);
  await f.database.query('UPDATE sandbox_card_hold_policy SET days=1');
  f.setTime(deadline - 1);
  assert.equal(await f.inbox.expireHold(),null);
  f.setTime(deadline);
  await f.database.query(`CREATE FUNCTION fail_expiry_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test_expiry_audit_unavailable'; END; $$`);
  await f.database.query('CREATE TRIGGER fail_expiry_audit BEFORE INSERT ON card_hold_expirations FOR EACH ROW EXECUTE FUNCTION fail_expiry_audit()');
  const beforeRollback = await f.ledger.snapshot('alice');
  await assert.rejects(f.inbox.expireHold(),/test_expiry_audit_unavailable/);
  assert.deepEqual(await f.ledger.snapshot('alice'),beforeRollback);
  await f.database.query('DROP TRIGGER fail_expiry_audit ON card_hold_expirations');
  const expiries = (await Promise.all([f.inbox.expireHold(), f.inbox.expireHold()])).filter(x=>x!==null);
  assert.equal(expiries.length,1);
  assert.equal(expiries[0].releasedWon,60);
  assert.equal(await f.inbox.expireHold(),null);
  assert.equal((await f.cards.apply(partial)).payment.heldWon,60, 'pre-expiry capture replay returns its original receipt');
  const account = await f.ledger.snapshot('alice');
  assert.equal(account.heldBalanceWon,0);
  assert.equal(account.cardPayments[0].capturedWon,40);
  assert.equal(account.cardPayments[0].releasedWon,60);
  assert.equal((await f.rewards.snapshot('alice')).heldWon,0);
  await f.cards.apply({kind:'refund',paymentId:'mixed',eventId:'refund-after-expiry',userId:'alice',amountWon:40});
  assert.equal((await f.ledger.snapshot('alice')).balanceWon,1000);
  assert.equal((await f.rewards.snapshot('alice')).availableWon,30);
  assert.equal((await reconcileRewards(f.database)).ok,true);
  await assert.rejects(f.database.query('DELETE FROM card_hold_expirations'),/immutable|history/i);
  await assert.rejects(f.database.query('UPDATE card_hold_deadlines SET expires_at=0'),/immutable|history/i);
});

test('a queued timely capture wins over expiry; late capture goes to review without reserving or charging funds', async t => {
  const f = await fixture(t);
  await f.cards.apply(authorize('queued'));
  await f.cards.apply(authorize('separate'));
  f.setTime(deadline-1);
  await f.inbox.enqueue(capture('queued','timely',75));
  f.setTime(deadline);
  const [expiration, applied] = await Promise.all([f.inbox.expireHold(), f.inbox.processNext()]);
  assert.equal(expiration?.paymentId,'separate');
  assert.equal(applied?.status,'applied');
  assert.equal(await f.inbox.expireHold(),null);
  await f.inbox.enqueue(capture('separate','too-late',25));
  const late = await f.inbox.processNext();
  assert.equal(late?.status,'dead_letter');
  assert.equal(late.errorCode,'CARD_HOLD_EXPIRED');
  assert.equal(late.nextAttemptAt,null);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon,925);
  assert.equal((await reconcileRewards(f.database)).ok,true);
});

test('an audited resolution unlocks the next capture but never rewrites attempts or posts customer money', async t => {
  const f = await fixture(t);
  await f.cards.apply(authorize('correction'));
  const erroneous = await f.inbox.enqueue(capture('correction','wrong-amount',101));
  const replacement = await f.inbox.enqueue(capture('correction','corrected',75));
  let result = await f.inbox.processNext();
  while (result?.status === 'retry') {
    f.setTime(result.nextAttemptAt!);
    result = await f.inbox.processNext();
  }
  assert.equal(result?.status,'dead_letter');
  assert.equal(result.errorCode,'CARD_STATE_CONFLICT');
  assert.equal(await f.inbox.processNext(),null);
  f.setTime(deadline+1);
  assert.equal(await f.inbox.expireHold(),null,'unresolved timely capture protects hold');
  const command = { id:erroneous.id, expectedVersion:result.version, idempotencyKey:'resolution-key',
    evidenceRef:'CASE-102', replacementId:replacement.id };
  await assert.rejects(f.inbox.resolveCapture({...command,replacementId:erroneous.id}),{code:'INBOX_STATE_CONFLICT'});
  await assert.rejects(f.inbox.resolveCapture({...command,expectedVersion:0}),{code:'INBOX_VERSION_CHANGED'});
  const before = await f.ledger.snapshot('alice');
  const [first, replay] = await Promise.all([f.inbox.resolveCapture(command),f.inbox.resolveCapture(command)]);
  assert.equal(first.disposition,'superseded');
  assert.deepEqual(first,replay);
  assert.deepEqual(await f.ledger.snapshot('alice'), before);
  await assert.rejects(f.inbox.resolveCapture({...command,replacementId:null}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.inbox.requeue({id:erroneous.id, expectedVersion:result.version,idempotencyKey:'repeat-attempt',
    reason:'Reopen the original capture after the correction.'}),{code:'INBOX_NOT_RETRYABLE'});
  const health = (await f.database.query('SELECT read_queue_health($1) AS health',[deadline+1])).rows[0].health.cardInbox;
  assert.equal(health.needsReview,0);
  assert.equal(health.blockedCount,0);
  assert.equal(await f.inbox.expireHold(),null,'the timely replacement remains ahead of expiry');
  assert.equal((await f.inbox.processNext())?.status,'applied');
  assert.equal((await f.ledger.snapshot('alice')).balanceWon,925);
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM card_inbox_attempts WHERE inbox_id=$1',[erroneous.id])).rows[0].n,8);
  await assert.rejects(f.database.query('DELETE FROM card_capture_resolutions'),/immutable|history/i);
  assert.equal((await reconcileRewards(f.database)).ok,true);
});

test('existing approvals get the original seven-day term when upgrading from migration 015', async t => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema = 'test_hold_upgrade_' + randomBytes(8).toString('hex');
  const database = new Database({ connectionString:process.env.TEST_DATABASE_URL, schema });
  const prefix = await mkdtemp(join(tmpdir(),'aqua-hold-upgrade-'));
  t.after(async () => {
    try { await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await database.close(); await rm(prefix,{recursive:true,force:true}); }
  });
  const migrations = new URL('./migrations/',import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => /^\d{3}_.*\.sql$/.test(file) && file < '016')) {
    await copyFile(new URL(file,migrations),join(prefix,file));
  }
  await applyMigrations(database,pathToFileURL(prefix + '/'));
  let now = start;
  const clock = { now:()=>now };
  const ledger = new LedgerStore(database,clock);
  await ledger.createUser({ id:'alice', email:'alice@example.test', name:'회원', tag:'alice', passwordHash:'test-only', createdAt:start-1 });
  await approveTestCustomer(database,'alice');
  await new IssuerOutboxStore(database,clock).register({userId:'alice',providerCardId:'sandbox-card-legacy',initialStatus:'active'});
  await ledger.creditSandbox({userId:'alice',amountWon:100,idempotencyKey:'legacy-100'});
  const cards = new CardPaymentStore(database,clock);
  await cards.apply(authorize('legacy-015'));
  const partial=capture('legacy-015','legacy-partial',25,false);
  await cards.apply(partial);
  await applyMigrations(database);
  now = deadline;
  assert.equal((await new CardInboxStore(database,clock).expireHold())?.releasedWon,75);
  assert.equal((await cards.apply(partial)).payment.heldWon,75);
  assert.equal((await ledger.snapshot('alice')).balanceWon,75);
  assert.equal((await reconcileRewards(database)).ok,true);
});

test('only the correction login can resolve a reviewed receipt through the sandbox CLI', async t => {
  const f = await fixture(t);
  await f.cards.apply(authorize('void'));
  f.setTime(deadline);
  await f.inbox.enqueue(capture('void','late-to-review',100));
  const result = await f.inbox.processNext();
  assert.equal(result?.errorCode,'CARD_HOLD_EXPIRED');
  const { grantCorrectionRole, verifyCorrectionRole } = await import('./permissions');
  const role = 'test_correction_' + randomBytes(8).toString('hex');
  const password = randomBytes(24).toString('hex');
  const connection = new URL(f.connectionString);
  connection.username = role;
  connection.password = password;
  const restricted = new Database({connectionString:connection.href,schema:f.schema,maxConnections:1});
  await f.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  try {
    await grantCorrectionRole(f.database,role);
    await verifyCorrectionRole(restricted);
    for (const sql of ['SELECT * FROM users', 'SELECT * FROM card_capture_resolutions',
      'SELECT expire_sandbox_card_hold(0)', "SELECT apply_sandbox_card_event('{}',0)"]) {
      await assert.rejects(restricted.query(sql), /permission denied/);
    }
    const args = ['--import','tsx','server/card-inbox-operator.ts','resolve',result!.id,
      String(result!.version),'void-command','CASE-AUDIT','void'];
    const env = {...process.env, NODE_ENV:'test', DATABASE_SCHEMA:f.schema, CORRECTION_DATABASE_URL:connection.href};
    const cli = spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:10000});
    assert.equal(cli.status,0,cli.stderr);
    assert.equal(cli.stderr,'');
    const receipt = JSON.parse(cli.stdout);
    assert.equal(receipt.disposition,'void');
    assert.equal(receipt.evidenceRef,'CASE-AUDIT');
    const replay = spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:10000});
    assert.equal(replay.status,0,replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout),receipt);
    const refused = spawnSync(process.execPath,args,{env:{...env, CORRECTION_DATABASE_URL:'',
      MIGRATION_DATABASE_URL:f.connectionString},encoding:'utf8',timeout:10000});
    assert.equal(refused.status,1);
    assert.doesNotMatch(refused.stdout + refused.stderr,/postgresql:\/\//);
    const stored = await f.database.query('SELECT actor FROM card_capture_resolutions WHERE inbox_id=$1',[result!.id]);
    assert.equal(stored.rows[0].actor,role);
    assert.equal((await f.inbox.expireHold())?.releasedWon,100);
  } finally {
    await restricted.close();
    await f.database.query(`DROP OWNED BY "${role}"`);
    await f.database.query(`DROP ROLE "${role}"`);
  }
});
