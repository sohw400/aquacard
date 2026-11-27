import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createTestDatabase } from './test-support';
import { approveTestCustomer } from './test-customer-access';
import { LedgerStore } from './ledger';
import { CardPaymentStore } from './card-payments';
import { IssuerOutboxStore } from './issuer-outbox';
import { RewardsStore } from './rewards';
import { applyReserve, reserveActivity, type ReserveCommand } from './reserve';

const userId = 'member-reserve';
const now = Date.UTC(2025, 10, 26, 1);
async function fixture(t: TestContext) {
  const f = await createTestDatabase();
  t.after(f.cleanup);
  const clock = { now: () => now };
  const ledger = new LedgerStore(f.database, clock), cards = new CardPaymentStore(f.database, clock);
  const rewards = new RewardsStore(f.database, clock);
  await ledger.createUser({ id: userId, email: 'reserve@example.test', tag: 'resmember', name: '테스트', createdAt: now - 10, passwordHash: 'test' });
  await approveTestCustomer(f.database, userId);
  await new IssuerOutboxStore(f.database, clock).register({ userId, providerCardId: 'sandbox-card-reserve', initialStatus: 'active' });
  const command = (key: string, input: ReserveCommand) => applyReserve(f.database, userId, key, input, now);
  const authorize = (id: string, amountWon: number) => cards.apply({ userId, paymentId: id, eventId: id+'-auth', merchantName:'카페', kind:'authorize', amountWon });
  const capture = (id: string, amountWon: number, finalCapture = true) => cards.apply({ userId, paymentId: id, eventId:id+'-capture', kind:'capture', amountWon, finalCapture });
  const reverse = (id: string) => cards.apply({ userId, paymentId: id, eventId:id+'-release', kind:'reverse' });
  const fund = (amountWon: number) => ledger.creditSandbox({ userId, amountWon, idempotencyKey:'seed-member-reserve' });
  return { ...f, ledger, cards, rewards, command, authorize, capture, reverse, fund, snapshot: () => ledger.snapshot(userId) };
}

test('reserve principal moves once, survives retries and cannot be overspent by concurrent withdrawals', async t => {
  const f=await fixture(t);
  await f.fund(1_000);
  const receipt=await f.command('move-one', {kind:'in',amountWon:800});
  assert.deepEqual(receipt,{availableWon:800,autoUse:false,preferenceVersion:0});
  const retries=await Promise.all([f.command('move-one',{kind:'in',amountWon:800}), f.command('move-one',{kind:'in',amountWon:800})]);
  for (const retry of retries) assert.deepEqual(retry,receipt);
  await assert.rejects(f.command('move-one',{kind:'in',amountWon:20}), {code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.authorize('no-fallback',201), {code:'INSUFFICIENT_FUNDS'});
  const out=await Promise.allSettled([f.command('move-out1',{kind:'out',amountWon:600}), f.command('move-out2',{kind:'out',amountWon:600})]);
  assert.equal(out.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await f.snapshot()).balanceWon,800);
  assert.equal((await f.snapshot()).reserve.availableWon,200);
  const state=await f.command('enable-fallback',{kind:'preference',autoUse:true,expectedVersion:0});
  assert.equal(state.preferenceVersion,1);
  await assert.rejects(f.command('stale-fallback',{kind:'preference',autoUse:false,expectedVersion:0}),{code:'PREFERENCE_CHANGED'});
  assert.deepEqual(await f.command('enable-fallback',{kind:'preference',autoUse:true,expectedVersion:0}),state);
  await assert.rejects(f.authorize('too-large',1001),{code:'INSUFFICIENT_FUNDS'});
  assert.deepEqual((await f.snapshot()).reserve,state);
});

test('three-source authorization, partial capture and partial refunds preserve the historical split and settle only gross card cash', async t => {
  const f = await fixture(t);
  await f.fund(1_000);
  await f.command('deposit-reserve',{kind:'in',amountWon:800});
  await f.command('enable-reserve',{kind:'preference',autoUse:true,expectedVersion:0});
  await f.rewards.fundBudget({amountWon:5_000,idempotencyKey:'budget-three'});
  await f.rewards.setProgram({enabled:true,idempotencyKey:'program-three'});
  await f.rewards.grant({userId,amountWon:100,idempotencyKey:'grant-three'});
  const auth = await f.authorize('three',600);
  assert.equal(auth.payment.funding?.principal.authorizedWon,500);
  assert.equal(auth.payment.funding?.reserve?.authorizedWon,300);
  assert.equal(auth.payment.funding?.rewards.authorizedWon,100);
  assert.deepEqual(await f.authorize('three',600),auth);
  assert.equal((await f.snapshot()).reserve.availableWon,500);
  await f.command('disable-reserve',{kind:'preference',autoUse:false,expectedVersion:1});
  const captured=await f.capture('three',360);
  assert.deepEqual(captured.payment.funding?.reserve,{authorizedWon:300,heldWon:0,capturedWon:180,releasedWon:120,refundedWon:0});
  assert.deepEqual(await f.capture('three',360),captured);
  let account=await f.snapshot();
  assert.equal(account.reserve.availableWon,620);
  assert.equal(account.balanceWon,80);
  assert.equal(account.cardPayments[0].funding?.reserve?.releasedWon,120);
  for(const [id,amountWon] of [['refund1',180],['refund2',180]] as const) {
    const refund={kind:'refund',eventId:id,paymentId:'three',userId,amountWon} as const;
    const paid=await f.cards.apply(refund);
    assert.deepEqual(await f.cards.apply(refund),paid);
  }
  account=await f.snapshot();
  assert.equal(account.balanceWon,380);
  assert.equal(account.reserve.availableWon,620);
  assert.equal(account.cardPayments[0].funding?.reserve?.refundedWon,180);
  assert.deepEqual((await f.database.query('SELECT * FROM internal_ledger_findings()')).rows,[]);
  const postings=await f.database.query('SELECT kind,amount_won FROM issuer_statement_postings($1,$2)',[Date.UTC(2025,10,25,15),Date.UTC(2025,10,26,15)]);
  assert.deepEqual(postings.rows.map(p=>p.kind+':'+p.amount_won).sort(),['capture:360','refund:180','refund:180']);
});

test('reserve-only funding works on the legacy no-rewards path; release returns unused funds to Reserve exactly once', async t=>{
  const f=await fixture(t);
  await f.fund(500);
  await f.command('put-reserve',{kind:'in',amountWon:500});
  await f.command('set-reserve',{kind:'preference',autoUse:true,expectedVersion:0});
  const approved=await f.authorize('reserve-only',300);
  assert.equal(approved.payment.funding?.reserve?.heldWon,300);
  const partial=await f.capture('reserve-only',99,false);
  assert.equal(partial.payment.funding?.reserve?.capturedWon,99);
  const released=await f.reverse('reserve-only');
  assert.equal(released.payment.funding?.reserve?.releasedWon,201);
  assert.deepEqual(await f.reverse('reserve-only'),released);
  assert.deepEqual(await f.authorize('reserve-only',300),approved);
  const account=await f.snapshot();
  assert.equal(account.balanceWon,0); assert.equal(account.reserve.availableWon,401);
  const history = await reserveActivity(f.database, userId);
  assert.deepEqual(history.items.map(row => [row.source,row.direction,row.amountWon].join(':')).sort(),
    ['card:in:201','card:out:300','wallet:in:500']);
  assert.deepEqual((await f.database.query('SELECT * FROM internal_ledger_findings()')).rows,[]);
});

test('reserve history pages equal timestamps once and binds each cursor to its owner and journal', async t => {
  const f = await fixture(t);
  await f.fund(1_000);
  for (let i = 0; i < 27; i++) {
    await f.command('movement-' + i, { kind: i % 2 ? 'out' : 'in', amountWon: 1 });
  }
  const first = await reserveActivity(f.database, userId);
  assert.equal(first.items.length, 25);
  assert.ok(first.nextCursor);
  const last = await reserveActivity(f.database, userId, first.nextCursor);
  assert.equal(last.items.length, 2);
  assert.equal(last.nextCursor, null);
  const all = [...first.items, ...last.items];
  assert.equal(new Set(all.map(row => row.id)).size, 27);
  assert.equal(all.filter(row => row.direction === 'out').length, 13);
  assert.ok(all.every(row => row.source === 'wallet' && row.amountWon === 1 && row.createdAt === now));
  assert.deepEqual(await reserveActivity(f.database, 'other-member'), { items: [], nextCursor: null });
  await assert.rejects(reserveActivity(f.database, 'other-member', first.nextCursor), { code: 'INVALID_CURSOR' });
  const otherJournal = Buffer.from(JSON.stringify([userId,'rewards',now,all[0].id])).toString('base64url');
  await assert.rejects(reserveActivity(f.database, userId, otherJournal), { code: 'INVALID_CURSOR' });
});

test('Reserve accrual preserves exact rate intervals and principal changes; budget delays cannot block withdrawal or pay twice', async t => {
  const f = await fixture(t);
  const reserve = 1_000_000_000_000n;
  const period = 315_360_000_000_000n;
  const rate = async (basis: number, version: number, key: string) =>
    (await f.database.query('SELECT set_reserve_reward_rate($1,$2,$3) AS value', [basis,version,key])).rows[0].value;
  const settle = async () => (await f.database.query('SELECT settle_next_reserve_reward() AS value')).rows[0].value;
  await f.fund(Number(reserve));
  await f.command('reserve-pool-in', { kind:'in', amountWon:Number(reserve) });
  assert.equal((await f.snapshot()).reserve.accrual, undefined);
  assert.deepEqual(await settle(), {status:'idle'});
  await f.rewards.setProgram({ enabled:true,idempotencyKey:'start-program' });
  const initial = await rate(1_000,0,'first-rate');
  assert.deepEqual(await rate(1_000,0,'first-rate'),initial);
  await assert.rejects(rate(1_200,0,'first-rate'), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(rate(1_200,0,'stale-rate'), /PREFERENCE_CHANGED/);
  await f.database.query('SELECT pg_sleep(0.025)');
  await rate(600,1,'second-rate');
  await f.database.query('SELECT pg_sleep(0.025)');
  await f.command('half-out', {kind:'out',amountWon:Number(reserve/2n)});
  const halfWeight = BigInt((await f.database.query('SELECT last_weight FROM reserve_reward_accruals WHERE user_id=$1',[userId])).rows[0].last_weight);
  await f.database.query('SELECT pg_sleep(0.025)');
  await rate(0,2,'pause-rate');
  const rows = (await f.database.query('SELECT rate_bps,effective_ms,start_weight FROM reserve_reward_rates ORDER BY version')).rows;
  assert.equal(BigInt(rows[1].start_weight),0n);
  const stopWeight = (BigInt(rows[2].effective_ms)-BigInt(rows[1].effective_ms))*1_000n
    + (BigInt(rows[3].effective_ms)-BigInt(rows[2].effective_ms))*600n;
  const gross = (reserve*halfWeight+(reserve/2n)*(stopWeight-halfWeight))/period;
  assert.ok(gross>0n);
  assert.equal((await f.snapshot()).reserve.accrual?.pendingWon,gross.toString());
  assert.deepEqual(await settle(),{status:'deferred',code:'REWARD_BUDGET_UNAVAILABLE'});
  await f.command('remaining-out', {kind:'out',amountWon:Number(reserve/2n)});
  assert.equal((await f.snapshot()).balanceWon,Number(reserve));
  assert.equal((await f.snapshot()).reserve.accrual?.pendingWon,gross.toString());
  await f.rewards.fundBudget({amountWon:Number(gross),idempotencyKey:'fund-covered-rewards'});
  // Advance just the disposable worker retry deadline, without changing the earned interval.
  await f.database.query("UPDATE reserve_reward_accruals SET retry_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",[userId]);
  const results = await Promise.all([settle(),settle()]);
  assert.deepEqual(results.map(r=>r.status).sort(),['idle','paid']);
  assert.equal(results.find(r=>r.status==='paid').amountWon,Number(gross));
  assert.deepEqual(await settle(),{status:'idle'});
  const after=await f.snapshot();
  assert.equal(after.reserve.availableWon,0);
  assert.equal(after.rewards.availableWon,Number(gross));
  assert.equal(after.rewards.history[0].origin,'reserve');
  assert.equal(after.reserve.accrual,undefined);
  assert.deepEqual((await f.database.query('SELECT * FROM internal_ledger_findings()')).rows,[]);
});

test('a Reserve payout offsets debt from a refunded cashback purchase using the ordinary backed reward ledger', async t => {
  const f = await fixture(t);
  const principal=1_000_000_000_000;
  await f.fund(principal+10_000);
  await f.rewards.fundBudget({amountWon:1_000_000,idempotencyKey:'offset-company-fund'});
  await f.rewards.setProgram({enabled:true,idempotencyKey:'offset-company-on'});
  await f.authorize('earned',10_000);
  await f.capture('earned',10_000);
  await f.authorize('spent',100);
  await f.capture('spent',100);
  await f.cards.apply({userId,paymentId:'earned',eventId:'unearned-refund',kind:'refund',amountWon:10_000});
  assert.equal((await f.snapshot()).rewards.adjustmentDueWon,100);
  await f.command('offset-reserve-in',{kind:'in',amountWon:principal});
  await f.database.query("SELECT set_reserve_reward_rate(4000,0,'offset-rate-on')");
  await f.database.query('SELECT pg_sleep(0.05)');
  await f.database.query("SELECT set_reserve_reward_rate(0,1,'offset-rate-off')");
  const paid=(await f.database.query('SELECT settle_next_reserve_reward() AS report')).rows[0].report;
  assert.equal(paid.status,'paid'); assert.equal(paid.offsetWon,100);
  const account=await f.snapshot();
  assert.equal(account.rewards.adjustmentDueWon,0);
  assert.equal(account.rewards.availableWon,paid.amountWon-100);
  assert.equal(account.balanceWon,10_000); assert.equal(account.reserve.availableWon,principal);
  assert.deepEqual((await f.database.query('SELECT * FROM internal_ledger_findings()')).rows,[]);
});

test('principal kept in Reserve still counts toward the member aggregate maximum on a new incoming credit', async t => {
  const f = await fixture(t);
  await f.fund(Number.MAX_SAFE_INTEGER);
  await f.command('move-maximum',{kind:'in',amountWon:Number.MAX_SAFE_INTEGER-1});
  await assert.rejects(f.ledger.creditSandbox({userId,amountWon:1,idempotencyKey:'over-aggregate-limit'}),{code:'RECIPIENT_BALANCE_LIMIT'});
  await f.command('return-maximum',{kind:'out',amountWon:Number.MAX_SAFE_INTEGER-1});
  assert.equal((await f.snapshot()).balanceWon, Number.MAX_SAFE_INTEGER);
  assert.equal((await f.snapshot()).reserve.availableWon, 0);
});
