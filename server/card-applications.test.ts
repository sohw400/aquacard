import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Database } from './database';
import { grantApplicationRole, grantIssuanceRole, verifyApplicationRole, verifyIssuanceRole } from './permissions';
import { CardApplicationStore } from './card-applications';
import { createTestDatabase } from './test-support';
import { LedgerStore } from './ledger';
import { IssuerOutboxStore } from './issuer-outbox';
import { approveTestCustomer } from './test-customer-access';
import { CardPaymentStore } from './card-payments';
import { CustomerAccessStore } from './customer-access';

async function fixture(t: TestContext) {
  const db = await createTestDatabase();
  t.after(db.cleanup);
  const ledger = new LedgerStore(db.database);
  const issuer = new IssuerOutboxStore(db.database);
  const app = new CardApplicationStore(db.database);
  for (const id of ['alice','bobby']) {
    await ledger.createUser({id,tag:id,email:id+'@example.test',name:'테스트 고객',passwordHash:'test-only',createdAt:1_000});
    await approveTestCustomer(db.database,id);
  }
  return {...db,ledger,issuer,app};
}

test('virtual issuance commits a single card only on verified member activation and preserves immutable retry receipts', async t => {
  const {database,ledger,issuer,app} = await fixture(t);
  const userId='alice';
  const command = {userId,form:'virtual' as const,idempotencyKey:'apply-first'};
  const [first,replay] = await Promise.all([app.submit(command),app.submit(command)]);
  assert.equal(first.status,'submitted');
  assert.deepEqual(first,replay);
  assert.equal((await app.snapshot('bobby')).application,null);
  await assert.rejects(app.submit({...command,idempotencyKey:'apply-again'}),{code:'CARD_APPLICATION_EXISTS'});
  await assert.rejects(app.submit({...command,form:'physical'}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(issuer.register({userId,providerCardId:'sandbox-card-manual',initialStatus:'active'}),{code:'OUTBOX_CARD_CONFLICT'});
  const confirm = {applicationId:first.id,expectedVersion:1,eventId:'decision-1',action:'approve' as const};
  const approved = await app.providerEvent(confirm);
  assert.equal(approved.status,'approved');
  await assert.rejects(app.providerEvent({...confirm,action:'decline',reason:'ELIGIBILITY'}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(app.providerEvent({...confirm,eventId:'stale-command',action:'issue'}),{code:'CARD_APPLICATION_VERSION_CHANGED'});
  const issued = await app.providerEvent({applicationId:first.id,expectedVersion:2,eventId:'issuance-1',action:'issue'});
  assert.deepEqual(await app.providerEvent(confirm),approved);
  assert.deepEqual(await app.submit(command),first);
  assert.equal((await issuer.snapshot(userId)).card,null);
  assert.equal((await app.snapshot(userId)).canActivate,true);
  const activate = {userId,applicationId:first.id,expectedVersion:issued.version,idempotencyKey:'activate-card'};
  await assert.rejects(app.activate({...activate,userId:'bobby'}),{code:'CARD_APPLICATION_NOT_FOUND'});
  const [active, repeated] = await Promise.all([app.activate(activate),app.activate(activate)]);
  assert.equal(active.status,'active'); assert.deepEqual(active,repeated);
  assert.equal((await issuer.snapshot(userId)).card?.confirmedStatus,'active');
  await ledger.creditSandbox({userId,amountWon:100,idempotencyKey:'credit'});
  const approvedPayment = await new CardPaymentStore(database).apply({kind:'authorize',userId,paymentId:'issued-payment',
    eventId:'first-auth',amountWon:50,merchantName:'테스트 가맹점'});
  assert.equal(approvedPayment.payment.heldWon,50);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM issuer_cards')).rows[0].n,1);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM card_application_events')).rows[0].n,4);
  await assert.rejects(database.query('DELETE FROM card_application_events'),/immutable|history/i);
});

test('physical cards require dispatch, delivery and member activation; access freezes stop new issuance', async t => {
  const {database,app,issuer} = await fixture(t);
  const userId='alice';
  let application = await app.submit({userId,form:'physical',idempotencyKey:'apply-physical'});
  for (const action of ['approve','issue'] as const) {
    application = await app.providerEvent({action,applicationId:application.id,expectedVersion:application.version,eventId:action});
  }
  const activate = () => app.activate({userId,applicationId:application.id,expectedVersion:application.version,idempotencyKey:'activate-physical'});
  await assert.rejects(activate(),{code:'CARD_APPLICATION_STATE_CONFLICT'});
  await assert.rejects(app.providerEvent({action:'deliver',applicationId:application.id,expectedVersion:3,eventId:'early-delivery'}),{code:'CARD_APPLICATION_STATE_CONFLICT'});
  for (const action of ['dispatch','deliver'] as const) {
    application = await app.providerEvent({action,applicationId:application.id,expectedVersion:application.version,eventId:action});
  }
  const access = new CustomerAccessStore(database);
  const change = {userId,expectedVersion:2,idempotencyKey:'freeze-before-activate',reason:'Testing frozen member account before activation'};
  await access.transition({...change,status:'restricted'});
  assert.equal((await app.snapshot(userId)).canActivate,false);
  await assert.rejects(activate(),{code:'CUSTOMER_ACCESS_REQUIRED'});
  assert.equal((await issuer.snapshot(userId)).card,null);
  await access.transition({...change,expectedVersion:3,idempotencyKey:'lift-restriction',status:'active'});
  assert.equal((await activate()).status,'active');
});

test('a declined member sees a stable reason and can file a new application, while legacy cards keep their original mapping', async t => {
  const {issuer,app} = await fixture(t);
  const userId='alice';
  const old = await app.submit({userId,form:'physical',idempotencyKey:'first-case'});
  const rejection = {action:'decline' as const,applicationId:old.id,expectedVersion:1,eventId:'decline-first',reason:'DETAILS_REQUIRED' as const};
  const declined = await app.providerEvent(rejection);
  assert.equal(declined.reason,'DETAILS_REQUIRED');
  assert.equal((await app.snapshot(userId)).canApply,true);
  const second = await app.submit({userId,form:'virtual',idempotencyKey:'second-case'});
  assert.notEqual(second.id,old.id);
  assert.equal((await app.snapshot(userId)).application?.id,second.id);
  assert.deepEqual(await app.providerEvent(rejection),declined);
  await issuer.register({userId:'bobby',providerCardId:'sandbox-card-classic',initialStatus:'locked'});
  assert.deepEqual(await app.snapshot('bobby'),{application:null,canApply:false,canActivate:false});
  await assert.rejects(app.submit({userId:'bobby',form:'virtual',idempotencyKey:'legacy-apply'}),{code:'CARD_APPLICATION_EXISTS'});
});

test('member and provider logins cannot act for one another and the sandbox issuer CLI replays its first decision', async t => {
  const f=await fixture(t);
  const suffix=randomBytes(8).toString('hex');
  const password=randomBytes(24).toString('hex');
  const roles: string[]=[];
  const connections: Database[]=[];
  async function login(name:string,grant:(database:Database,role:string)=>Promise<unknown>) {
    const role='test_app_'+name+'_'+suffix;
    await f.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`); roles.push(role);
    await grant(f.database,role);
    const url=new URL(f.connectionString); url.username=role; url.password=password;
    const db=new Database({connectionString:url.href,schema:f.schema,maxConnections:1}); connections.push(db);
    return {db,url:url.href};
  }
  try {
    const api=await login('api',grantApplicationRole); const provider=await login('issuer',grantIssuanceRole);
    await verifyIssuanceRole(provider.db); await verifyApplicationRole(api.db);
    await assert.rejects(api.db.query("SELECT apply_card_application_event('{}',0)"),/permission denied/);
    for(const sql of ["SELECT submit_card_application('{}',0)", "SELECT activate_card_application('{}',0)",
      'SELECT * FROM card_applications','SELECT * FROM users']) await assert.rejects(provider.db.query(sql),/permission denied/);
    const application=await new CardApplicationStore(api.db).submit({userId:'alice',form:'virtual',idempotencyKey:'apply-cli'});
    const args=['--import','tsx','server/card-application-provider.ts',application.id,'1','test-decision','approve'];
    const env={...process.env,NODE_ENV:'test',DATABASE_SCHEMA:f.schema,ISSUANCE_DATABASE_URL:provider.url};
    const approved=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:15000});
    assert.equal(approved.status,0,approved.stderr); assert.equal(JSON.parse(approved.stdout).status,'approved');
    const replay=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:15000}); assert.equal(replay.stdout,approved.stdout);
    const wrong=spawnSync(process.execPath,args,{env:{...env,ISSUANCE_DATABASE_URL:api.url},encoding:'utf8',timeout:15000});
    assert.equal(wrong.status,1); assert.equal(wrong.stderr.trim(),'SANDBOX_ISSUANCE_UNAVAILABLE');
  } finally {
    await Promise.all(connections.map(db=>db.close()));
    for(const role of roles) {
      await f.database.query(`DROP OWNED BY "${role}"`); await f.database.query(`DROP ROLE "${role}"`);
    }
  }
});
