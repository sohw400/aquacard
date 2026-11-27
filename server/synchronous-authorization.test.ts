import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyMigrations } from './migrations';
import test, { type TestContext } from 'node:test';
import { CardPaymentStore } from './card-payments';
import { Database } from './database';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerStore } from './ledger';
import { grantAuthorizationSimulatorRole, verifyAuthorizationSimulatorRole } from './permissions';
import { approveTestCustomer } from './test-customer-access';
import { createTestDatabase } from './test-support';

async function fixture(t: TestContext) {
  const f=await createTestDatabase();
  const name='sync_issuer_'+randomBytes(8).toString('hex'), password=randomBytes(24).toString('hex');
  const url=new URL(f.connectionString); url.username=name; url.password=password;
  const db=new Database({connectionString:url.href,schema:f.schema,maxConnections:4});
  t.after(async()=>{
    await db.close();
    try { await f.database.query(`DROP OWNED BY "${name}"`); await f.database.query(`DROP ROLE "${name}"`); }
    finally { await f.cleanup(); }
  });
  await f.database.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}'`);
  await grantAuthorizationSimulatorRole(f.database,name);
  await verifyAuthorizationSimulatorRole(db);
  const userId='sync-member';
  const ledger=new LedgerStore(f.database);
  await ledger.createUser({id:userId,tag:'syncmember',name:'가상',email:'sync@example.test',passwordHash:'synthetic',createdAt:Date.now()});
  await approveTestCustomer(f.database,userId);
  await new IssuerOutboxStore(f.database).register({userId,providerCardId:'sandbox-card-sync-issuer',initialStatus:'active'});
  await ledger.creditSandbox({userId,amountWon:200,idempotencyKey:'sync-load'});
  const request=(amountWon=40,issuedAt=Date.now())=>({requestId:randomUUID(),issuedAt,userId,amountWon,merchantName:'합성 매장'});
  const decide=async (body:ReturnType<typeof request>)=>(await db.query('SELECT decide_sandbox_authorization($1::jsonb) AS receipt',[JSON.stringify(body)])).rows[0].receipt;
  const lookup=async (rid:string)=>(await db.query('SELECT lookup_sandbox_authorization($1::uuid) AS receipt',[rid])).rows[0].receipt;
  return {...f,db,url:url.href,request,decide,lookup,ledger,userId,cards:new CardPaymentStore(f.database)};
}

test('the synchronous simulator commits one hold, replays its original decision, and authorizes with current policy',async t=>{
  const f=await fixture(t);
  for (const sql of ["SELECT * FROM users","SELECT * FROM sandbox_sync_requests","SELECT * FROM sandbox_sync_decisions",
    "SELECT apply_sandbox_card_event('{}',0)","SELECT enqueue_sandbox_card_event('{}',0)","SELECT * FROM card_payment_events"]) {
    await assert.rejects(f.db.query(sql),/permission denied/);
  }
  const request=f.request();
  const result=await f.decide(request);
  assert.equal(result.outcome,'approved'); assert.equal(result.requestId,request.requestId);
  assert.equal(result.deadlineAt,request.issuedAt+2000);
  assert.ok(result.decidedAt<result.deadlineAt);
  assert.deepEqual(await f.decide(request),result);
  assert.deepEqual(await f.lookup(request.requestId),result);
  await assert.rejects(f.decide({...request,amountWon:42}),/SYNC_ID_CONFLICT/);
  assert.equal((await f.database.query('SELECT held_won FROM card_payments WHERE id=$1',[result.paymentId])).rows[0].held_won,'40');
  // The existing asynchronous lifecycle may settle an approved synchronous hold.
  await f.cards.apply({kind:'capture',eventId:'capture-after-sync',paymentId:result.paymentId,userId:f.userId,amountWon:40,finalCapture:true});
  assert.deepEqual(await f.lookup(request.requestId),result);
  assert.equal((await f.database.query('SELECT captured_won,held_won FROM card_payments WHERE id=$1',[result.paymentId])).rows[0].held_won,'0');
  const insufficient=f.request(500);
  assert.equal((await f.decide(insufficient)).outcome,'declined');
  await f.ledger.creditSandbox({userId:f.userId,amountWon:1000,idempotencyKey:'second-load'});
  assert.equal((await f.decide(insufficient)).outcome,'declined');
  const issuer=new IssuerOutboxStore(f.database);
  const snap=await issuer.snapshot(f.userId);
  assert.ok(snap.card);
  await issuer.requestStatus({userId:f.userId,cardId:snap.card.id,targetStatus:'locked',expectedVersion:snap.card.version,idempotencyKey:'sync-lock'});
  const locked=f.request();
  assert.equal((await f.decide(locked)).outcome,'declined');
  assert.equal((await f.database.query('SELECT reason FROM card_authorization_decisions WHERE event_id=$1',['sync-auth:'+locked.requestId])).rows[0].reason,'CARD_LOCKED');
  assert.doesNotMatch(JSON.stringify(await f.lookup(locked.requestId)),/CARD_LOCKED|merchant|userId/);
  assert.equal(await f.lookup(randomUUID()),null);
});

test('deadline rolls back a late financial approval and permanently prevents asynchronous resurrection',async t=>{
  const f=await fixture(t);
  const first=f.request(40,Date.now()-3000);
  const timed=await f.decide(first);
  assert.equal(timed.outcome,'timed_out');
  assert.deepEqual(await f.decide(first),timed);
  const before=await f.ledger.snapshot(f.userId);
  const direct={kind:'authorize' as const,eventId:'sync-auth:'+first.requestId,paymentId:timed.paymentId,userId:f.userId,amountWon:40,merchantName:'합성 매장'};
  await assert.rejects(f.cards.apply(direct));
  await assert.rejects(f.cards.apply({...direct,eventId:'another-authorize'}));
  const unknown=f.request();
  await assert.rejects(f.cards.apply({...direct,eventId:'sync-auth:'+unknown.requestId,paymentId:'sync-pay:'+unknown.requestId}));
  assert.equal(await f.lookup(unknown.requestId),null);
  // Delay after the policy has already created its hold. The inner exception must
  // roll back all financial writes while recording the outer timeout.
  await f.database.query(`CREATE FUNCTION test_slow_decision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(2.1); RETURN NEW; END; $$`);
  await f.database.query('CREATE TRIGGER test_slow AFTER INSERT ON card_authorization_decisions FOR EACH ROW EXECUTE FUNCTION test_slow_decision()');
  const inflight=f.request();
  const slow=f.decide(inflight);
  await new Promise(resolve=>setTimeout(resolve,150));
  try {
    const concurrent=await f.decide(inflight);
    assert.equal(concurrent.outcome,'timed_out'); // possible if the first client already finished
  } catch (error) { assert.match(String(error),/SYNC_RESULT_UNCONFIRMED/); }
  const late=await slow;
  assert.equal(late.outcome,'timed_out');
  assert.deepEqual(await f.decide(inflight),late);
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM card_authorization_decisions')).rows[0].n,0);
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM card_payments')).rows[0].n,0);
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM card_payment_events')).rows[0].n,0);
  assert.deepEqual(await f.ledger.snapshot(f.userId),before);
});

test('trusted CLI distinguishes a historical receipt and unavailable result, and cannot run in production',async t=>{
  const f=await fixture(t);
  const dir=await mkdtemp(join(tmpdir(),'sim-input-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'req.json');
  const request=f.request(40,Date.now()-5_000);
  await writeFile(file,JSON.stringify(request));
  function cli(args:string[],env:NodeJS.ProcessEnv={}) {
    const response=spawnSync(process.execPath,['--import','tsx','server/authorization-simulator.ts',...args],{
      env:{...process.env,NODE_ENV:'test',DATABASE_SCHEMA:f.schema,AUTHORIZATION_SIMULATOR_DATABASE_URL:f.url,...env},encoding:'utf8',timeout:10_000,
    });
    assert.ifError(response.error);
    assert.doesNotMatch(response.stdout+response.stderr,/합성|sync-member|postgresql:|sim-input-/);
    return response;
  }
  const decision=cli(['decide',file]);
  assert.equal(decision.status,0,decision.stderr);
  assert.equal(JSON.parse(decision.stdout).outcome,'timed_out');
  assert.equal(JSON.parse(decision.stdout).delivery,'after_deadline');
  const seen=cli(['lookup',request.requestId]);
  assert.equal(JSON.parse(seen.stdout).delivery,'lookup');
  assert.equal(JSON.parse(seen.stdout).decidedAt,JSON.parse(decision.stdout).decidedAt);
  const absent=cli(['lookup',randomUUID()]);
  assert.equal(absent.status,2); assert.equal(JSON.parse(absent.stdout).outcome,'unconfirmed');
  const production=cli(['decide',file],{NODE_ENV:'production'});
  assert.equal(production.status,2); assert.equal(JSON.parse(production.stderr).code,'SIMULATOR_DISABLED');
});

test('legacy prefixed authorizations keep their holds, captures and refunds across the simulator upgrade', async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  const schema = 'test_sync_upgrade_' + randomBytes(8).toString('hex');
  const db = new Database({ connectionString, schema });
  const dir = await mkdtemp(join(tmpdir(),'before-026-'));
  t.after(async () => {
    try { await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await db.close(); await rm(dir,{recursive:true,force:true}); }
  });
  const all = new URL('./migrations/',import.meta.url);
  for (const file of (await readdir(all)).filter(name=>/^\d{3}_.*\.sql$/.test(name)&&name<'026')) {
    await copyFile(new URL(file,all),join(dir,file));
  }
  await applyMigrations(db,pathToFileURL(dir+'/'));
  const userId='legacy-sync';
  const ledger=new LedgerStore(db), cards=new CardPaymentStore(db);
  await ledger.createUser({id:userId,tag:'legacysync',name:'가상',email:'legacy-sync@example.test',passwordHash:'synthetic',createdAt:Date.now()});
  await approveTestCustomer(db,userId);
  await new IssuerOutboxStore(db).register({userId,initialStatus:'active',providerCardId:'sandbox-card-legacy-sync'});
  await ledger.creditSandbox({userId,amountWon:500,idempotencyKey:'initial-credit'});
  const rid=randomUUID();
  const old={kind:'authorize' as const,eventId:'legacy-authorize',paymentId:'sync-pay:'+rid,userId,amountWon:100,merchantName:'합성 가게'};
  const ordinary={...old,eventId:'sync-auth:old-text',paymentId:'sync-pay:old-text'};
  const before=await cards.apply(old);
  await cards.apply(ordinary);
  await applyMigrations(db);
  assert.deepEqual(await cards.apply(old),before);
  await cards.apply({...ordinary,eventId:'sync-auth:new-text',paymentId:'sync-pay:new-text'});
  await cards.apply({kind:'capture',eventId:'sync-auth:old-text-capture',paymentId:ordinary.paymentId,userId,amountWon:100,finalCapture:true});
  await cards.apply({kind:'capture',eventId:'sync-auth:'+rid,paymentId:old.paymentId,userId,amountWon:100,finalCapture:true});
  await cards.apply({kind:'refund',eventId:'legacy-refund',paymentId:old.paymentId,userId,amountWon:25});
  await assert.rejects(db.query('SELECT decide_sandbox_authorization($1::jsonb)',[JSON.stringify({
    requestId:rid,userId,merchantName:old.merchantName,amountWon:100,issuedAt:Date.now(),
  })]),/SYNC_ID_CONFLICT/);
  const payment=(await db.query('SELECT captured_won,refunded_won,held_won FROM card_payments WHERE id=$1',[old.paymentId])).rows[0];
  assert.deepEqual(payment,{captured_won:'100',refunded_won:'25',held_won:'0'});
});
