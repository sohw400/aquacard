import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerStore, LedgerError } from './ledger';
import { createTestDatabase } from './test-support';
import { approveTestCustomer } from './test-customer-access';
import { CustomerAccessStore } from './customer-access';
import { memberCardDeclines } from './card-declines';
import { IssuerOutboxStore } from './issuer-outbox';
import { activityBoundary } from './activity-cursor';

const now = Date.UTC(2026, 10, 27);
async function accounts(t: TestContext) {
  const fixture = await createTestDatabase();
  t.after(fixture.cleanup);
  const db = fixture.database;
  const ledger = new LedgerStore(db, { now: () => now });
  const risk = new CustomerAccessStore(db, { now: () => now });
  for (const id of ['alice', 'bobby']) {
    await ledger.createUser({ id, email: id + '@example.test', name: '테스트 회원', tag: id,
      createdAt: now - 60 * 86_400_000, passwordHash: 'test-only' });
    await approveTestCustomer(db,id);
  }
  return { db, ledger, risk };
}

test('older high-risk members retain reduced limits and concurrent risk decisions are versioned and replayable', async t => {
  const { db, ledger, risk } = await accounts(t);
  await ledger.creditSandbox({ userId: 'alice',amountWon: 3_000_000,idempotencyKey: 'fund-sender' });
  assert.deepEqual(await risk.transferRisk('alice'), { version: 0, tier: 'standard', updatedAt: null });
  const initial = (await ledger.snapshot('alice')).limits;
  assert.equal(initial.perTransfer,1_000_000);
  const transfer = { senderId:'alice',recipientTag:'bobby',amountWon:750_000,idempotencyKey:'before-risk-change' };
  const accepted = await ledger.transfer(transfer);
  const request = { userId: 'alice', tier: 'high' as const, expectedVersion: 0, idempotencyKey: 'risk-high', caseRef: 'CASE-100' };
  const attempts = await Promise.allSettled([risk.setTransferRisk(request), risk.setTransferRisk({ ...request, idempotencyKey:'risk-racing' })]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  const winner = attempts[0].status === 'fulfilled' ? request : { ...request, idempotencyKey:'risk-racing' };
  assert.deepEqual(await risk.setTransferRisk(winner), {version: 1,tier: 'high',updatedAt: now});
  const tighter = (await ledger.snapshot('alice')).limits;
  assert.deepEqual([tighter.perTransfer,tighter.daily,tighter.monthly,tighter.available], [500_000,1_000_000,2_500_000,250_000]);
  assert.deepEqual(await ledger.transfer(transfer),accepted);
  await assert.rejects(ledger.transfer({...transfer,amountWon:300_000,idempotencyKey:'after-risk-change'}),
    (e: unknown) => e instanceof LedgerError && e.code === 'LIMIT_EXCEEDED');
  await assert.rejects(risk.setTransferRisk({...winner,caseRef:'CASE-OTHER'}), (e: unknown) => e instanceof LedgerError && e.code === 'IDEMPOTENCY_CONFLICT');
  await risk.setTransferRisk({...request,tier:'standard',expectedVersion:1,idempotencyKey:'risk-restored'});
  assert.equal((await ledger.snapshot('alice')).limits.perTransfer,1_000_000);
  assert.equal((await risk.setTransferRisk(winner)).version,1);
  assert.equal((await risk.transferRisk('alice')).version,2);
  await assert.rejects(db.query('DELETE FROM customer_transfer_risk_events'), /immutable|append.only/i);
});

test('member decline history exposes safe reasons with stable pages, owner binding and no raw references', async t => {
  const {db} = await accounts(t);
  async function request(id:string,index:number) {
    const command = {kind:'authorize',eventId:'private-event-' + id + '-' + index,paymentId:'private-payment-' + id + '-' + index,
      userId:id,amountWon:1200,merchantName:'private-merchant'};
    const {rows} = await db.query('SELECT apply_sandbox_card_event($1::jsonb,$2::bigint) AS result',[JSON.stringify(command),now]);
    assert.equal(rows[0].result.declined,true);
  }
  for (let i=0;i<27;i++) await request('alice',i);
  const outbox = new IssuerOutboxStore(db,{now:()=>now});
  await outbox.register({userId:'bobby',providerCardId:'sandbox-card-bobby',initialStatus:'locked'});
  await request('bobby',1);
  const first = await memberCardDeclines(db,'alice');
  assert.equal(first.items.length,25);
  assert.ok(first.nextCursor);
  assert.equal(first.items.every(x=>x.reason==='card_unavailable'),true);
  const boundary=activityBoundary(first.nextCursor,'alice','declines');
  assert.match(boundary!.id,/^[a-f0-9]{64}$/);
  const second=await memberCardDeclines(db,'alice',first.nextCursor);
  assert.equal(second.nextCursor,null);
  assert.equal(second.items.length,2);
  assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,27);
  assert.doesNotMatch(JSON.stringify(first)+JSON.stringify(boundary), /private-|operator|merchantName/);
  assert.deepEqual((await memberCardDeclines(db,'bobby')).items.map(x=>x.reason),['card_locked']);
  await assert.rejects(memberCardDeclines(db,'bobby',first.nextCursor),/처음부터/);
  await assert.rejects(db.query("SELECT * FROM member_card_declines('alice',NULL,NULL,27)"),/INVALID_DECLINE_PAGE/);
});
