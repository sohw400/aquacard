import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import type { AccountSnapshot, SandboxCardEvent } from '../shared/api';
import { CardInboxStore } from '../server/card-inbox';
import { CardPaymentStore } from '../server/card-payments';
import { Database } from '../server/database';
import { IssuerOutboxStore } from '../server/issuer-outbox';
import { LedgerStore } from '../server/ledger';
import { reconcileRewards } from '../server/reward-reconciliation';
import { approveTestCustomer } from '../server/test-customer-access';

const [phase, address, sessionPath] = process.argv.slice(2);
assert.ok(['seed','held','settled','resumed'].includes(phase) && sessionPath && /^http:\/\/127\.0\.0\.1:\d+$/.test(address));
assert.equal(process.env.NODE_ENV, 'test');
const origin = 'https://fallback.example.test';
const paymentId = 'fallback-hold';
type Session = { id: string; cookie: string };

async function withDatabase(variable: string, role: string, work: (database: Database) => Promise<void>) {
  const url = new URL(process.env[variable] ?? '');
  assert.ok(url.hostname === '127.0.0.1' && url.pathname === '/aqua_fallback' && url.username === role);
  const database = new Database({ connectionString: url.href, schema: 'aqua', maxConnections: 1 });
  try {
    const result = await database.query('SELECT current_database() AS db, current_user AS role');
    assert.deepEqual(result.rows, [{ db: 'aqua_fallback', role }]);
    await work(database);
  } finally { await database.close(); }
}

function events(userId: string): SandboxCardEvent[] {
  return [
    { kind: 'capture', userId, paymentId, eventId: 'fallback-capture', amountWon: 80, finalCapture: true },
    { kind: 'refund', userId, paymentId, eventId: 'fallback-refund', amountWon: 30 },
  ];
}

async function enqueue(userId: string, replay: boolean) {
  await withDatabase('INGRESS_DATABASE_URL','aqua_ingress', async database => {
    for (const event of events(userId)) {
      const result = await new CardInboxStore(database).enqueue(event);
      assert.equal(result.duplicate, replay);
      assert.equal(result.status, replay ? 'applied' : 'pending');
    }
  });
}

async function seed(): Promise<Session> {
  const signup = await fetch(address + '/api/auth/signup', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'fallback@example.test', name: '복구 체험', tag: 'fallback', password: 'Aqua-fixture-password-42' }) });
  assert.equal(signup.status, 201, 'The current image must accept signup before fallback.');
  const { user } = await signup.json() as { user: { id: string } };
  const cookie = signup.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie && user.id);
  await withDatabase('MIGRATION_DATABASE_URL','aqua', async owner => {
    await approveTestCustomer(owner,user.id);
    await new IssuerOutboxStore(owner).register({ userId: user.id, providerCardId: 'sandbox-card-fallback', initialStatus:'active' });
  });
  await withDatabase('DATABASE_URL','aqua_app', async db => {
    await new LedgerStore(db).creditSandbox({ userId: user.id, amountWon: 1_000, idempotencyKey: 'fallback-credit' });
    await new CardPaymentStore(db).apply({ kind: 'authorize', eventId: 'fallback-authorize', paymentId,
      userId: user.id, amountWon: 100, merchantName: '복구 가맹점' });
  });
  await enqueue(user.id,false);
  const session = { id: user.id, cookie };
  await writeFile(sessionPath,JSON.stringify(session), { flag:'wx', mode:0o600 });
  return session;
}

const session: Session = phase === 'seed' ? await seed() : JSON.parse(await readFile(sessionPath,'utf8'));
const headers = { cookie: session.cookie, origin, 'x-aqua-account': session.id };
const response = await fetch(address+'/api/account',{ headers });
assert.equal(response.status,200);
const account = await response.json() as AccountSnapshot;
assert.equal(account.user.id,session.id);
const payment = account.cardPayments.find(p => p.id === paymentId);
assert.ok(payment);
const stillHeld = phase === 'seed' || phase === 'held';
assert.equal(account.balanceWon, stillHeld ? 900 : 950);
assert.equal(account.heldBalanceWon, stillHeld ? 100 : 0);
assert.equal(payment.capturedWon,stillHeld ? 0 : 80);
assert.equal(payment.refundedWon,stillHeld ? 0 : 30);
assert.equal(payment.status,stillHeld ? 'authorized' : 'partially_refunded');
const old = phase === 'held' || phase === 'settled';
const cardApplication = await fetch(address+'/api/card-application',{ headers });
assert.equal(cardApplication.status,old ? 404 : 200);
if (old) {
  const write = await fetch(address+'/api/transfers',{ method:'POST', headers:{...headers,'content-type':'application/json'}, body:'{}' });
  assert.equal(write.status,503);
  assert.equal((await write.json() as { error:{ code:string } }).error.code,'FALLBACK_READ_ONLY');
}
if (!stillHeld) {
  await enqueue(session.id,true);
  await withDatabase('DATABASE_URL','aqua_app', async db => {
    const result = await reconcileRewards(db);
    assert.equal(result.ok,true);
    assert.equal(result.counts.cardPaymentEvents,'3');
    const settlement = await db.query("SELECT balance_won FROM ledger_accounts WHERE id='system:card_settlement'");
    assert.deepEqual(settlement.rows,[{balance_won:'50'}]);
  });
}
console.log(`Fallback drill ${phase}: available=${account.balanceWon}, held=${account.heldBalanceWon}, captured=${payment.capturedWon}, refunded=${payment.refundedWon} TEST_KRW.`);
