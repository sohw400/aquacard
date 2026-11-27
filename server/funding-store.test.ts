import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase } from './test-support';
import { approveTestCustomer } from './test-customer-access';
import { FundingStore } from './funding-store';
import { LedgerStore } from './ledger';
import { applyReserve } from './reserve';
import type { FundingInput, MemberFunding } from '../shared/funding';
import { LedgerError } from './errors';

const failure = (code:string) => (error:unknown) => error instanceof LedgerError && error.code===code;
test('synthetic funding uses exact quotes, locks withdrawals, reconciles unknown outcomes and prevents duplicate or reorganized credits',async t=>{
  const f=await createTestDatabase();t.after(f.cleanup);
  let now=Date.UTC(2026,0,1);
  const funding=new FundingStore(f.database,()=>now);
  const ledger=new LedgerStore(f.database,{now:()=>now});
  const user='fund-test';
  await ledger.createUser({id:user,email:'fund@example.test',name:'체험회원',tag:'fundmember',passwordHash:'test-only',createdAt:now});
  const intent=(key:string,input:FundingInput)=>funding.intent(user,key,input);
  const makeDeposit=(key:string)=>intent(key,{action:'quote',direction:'deposit',asset:'BTC',network:'bitcoin',quantity:'0.0012'});
  await assert.rejects(makeDeposit('deposit-before'),failure('CUSTOMER_ACCESS_REQUIRED'));
  await approveTestCustomer(f.database,user);
  const d=await makeDeposit('deposit-create');
  assert.equal(d.grossWon,180000);
  assert.deepEqual(await makeDeposit('deposit-create'),d);
  const confirm=(o:MemberFunding,key:string)=>intent(key,{action:o.direction==='deposit'?'accept_deposit':'accept_withdrawal',id:o.id});
  await confirm(d,'accept-deposit');
  const event=(o:MemberFunding,action:string,eventId:string,extra={})=>funding.event({id:o.id,action,eventId,...extra});
  const observe=(o:MemberFunding,ref:string,block:string,key:string)=>event(o,'observe',key,{asset:o.asset,network:o.network,
    units:o.units,destination:o.destination,transferRef:ref,blockRef:block});
  const ref='sim-tx:deposit-a:0';
  const old='sim-block:orphan', finalBlock='sim-block:confirmed';
  const evidence=(blockRef:string)=>({transferRef:ref,blockRef});
  await observe(d,ref,old,'observe-before');
  await event(d,'reorg','discard-block',evidence(old));
  await assert.rejects(observe(d,ref,old,'stale-observation'),failure('FUNDING_STATE_CONFLICT'));
  await observe(d,ref,finalBlock,'observe-again');
  await assert.rejects(event(d,'confirm','not-enough',{...evidence(finalBlock),confirmations:1}),failure('FUNDING_CONFIRMATIONS_REQUIRED'));
  await event(d,'confirm','finality-achieved',{...evidence(finalBlock),confirmations:2});
  const credit=await Promise.all([event(d,'convert','credit-deposit'),event(d,'convert','credit-deposit')]);
  assert.deepEqual(credit[0],credit[1]);
  const balance=async()=>Number((await f.database.query("SELECT balance_won FROM ledger_accounts WHERE id=$1",['user:'+user])).rows[0].balance_won);
  assert.equal(await balance(),180000);
  const another=await makeDeposit('other-deposit');await confirm(another,'accept-another');
  await assert.rejects(observe(another,ref,finalBlock,'duplicate-transfer'),failure('FUNDING_DUPLICATE_TRANSFER'));
  const withdraw=()=>intent('withdraw-quote',{action:'quote',direction:'withdrawal',asset:'USDC',network:'polygon',quantity:'14000',destination:'aqua-test:polygon:my-wallet'});
  const w=await withdraw();
  assert.deepEqual([w.priceWon,w.grossWon,w.feeWon,w.networkFeeWon,w.netWon,w.units],[1400,14000,70,140,13790,'9.85']);
  await confirm(w,'accept-withdraw');assert.equal(await balance(),166000);
  await event(w,'dispatch','dispatch-first');await event(w,'unknown','outcome-unknown');
  await assert.rejects(intent('cancel-unknown',{action:'cancel',id:w.id}),failure('FUNDING_STATE_CONFLICT'));
  const adapter={dispatchKey:w.id,proofRef:'sim-proof:lookup-first'};
  await event(w,'not_sent','retry-permitted',adapter);
  await event(w,'dispatch','dispatch-retry');
  const success={dispatchKey:w.id,proofRef:'sim-proof:second',transferRef:'sim-tx:withdraw-a:0'};
  await event(w,'settle','settled-a',success);await event(w,'settle','settled-a',success);
  assert.equal(await balance(),166000);
  const history=await new FundingStore(f.database).history(user);
  assert.equal(history.find(row=>row.id===w.id)?.status,'settled');
  assert.deepEqual(await funding.history('other-account'),[]);
  await event(d,'reorg','final-reorg',evidence(finalBlock));
  await assert.rejects(event(d,'compensate','reverse-spent'),failure('FUNDING_BALANCE_LOW'));
  await ledger.creditSandbox({userId:user,amountWon:14000,idempotencyKey:'recover-funds'});
  await event(d,'compensate','reverse-spent');
  assert.equal(await balance(),0);
  assert.equal((await f.database.query('SELECT * FROM internal_ledger_findings()')).rowCount,0);
  const stale=await makeDeposit('old-quote');
  now+=60000;
  await assert.rejects(confirm(stale,'accept-expired'),failure('FUNDING_QUOTE_EXPIRED'));
});

test('concurrent synthetic withdrawals share one spendable balance and release a confirmed rejection exactly once', async t => {
  const f = await createTestDatabase();
  t.after(f.cleanup);
  const ledger = new LedgerStore(f.database);
  const funding = new FundingStore(f.database);
  const user = 'funding-race';
  await ledger.createUser({ id: user, email: 'race@example.test', name: '출금회원', tag: 'fundingrace',
    passwordHash: 'test-only', createdAt: Date.now() });
  await approveTestCustomer(f.database, user);
  await ledger.creditSandbox({ userId: user, amountWon: 20_000, idempotencyKey: 'race-initial-credit' });
  const input: FundingInput = { action: 'quote', direction: 'withdrawal', asset: 'USDC', network: 'polygon',
    quantity: '14000', destination: 'aqua-test:polygon:my-wallet' };
  const quotes = await Promise.all(['race-quote-one', 'race-quote-two'].map(key => funding.intent(user, key, input)));
  const results = await Promise.allSettled(quotes.map((quote, i) =>
    funding.intent(user, 'race-accept-' + i, { action: 'accept_withdrawal', id: quote.id })));
  const claimed = results.find(r => r.status === 'fulfilled');
  const rejected = results.find(r => r.status === 'rejected');
  assert.ok(claimed, 'A single withdrawal must be held');
  assert.ok(rejected, 'The second withdrawal must be declined');
  assert.equal(rejected.reason.code, 'FUNDING_BALANCE_LOW', rejected.reason.message);
  const balance = async () => Number((await f.database.query('SELECT balance_won FROM ledger_accounts WHERE id=$1', ['user:' + user])).rows[0].balance_won);
  assert.equal(await balance(), 6_000);
  const id = claimed.value.id;
  await assert.rejects(funding.intent('other-account', 'race-other-owner', { action: 'cancel', id }), failure('FUNDING_NOT_FOUND'));
  await funding.event({ id, eventId: 'race-dispatch', action: 'dispatch' });
  await funding.event({ id, eventId: 'race-unknown', action: 'unknown' });
  const proof = { id, eventId: 'race-reject', action: 'reject', dispatchKey: id, proofRef: 'sim-proof:rejected' };
  await Promise.all([funding.event(proof), funding.event(proof)]);
  assert.equal(await balance(), 20_000);
  const records = await funding.history(user);
  assert.equal(records.find(row => row.id === id)?.status, 'released');
  const recipient = 'fundingreceiver';
  await ledger.createUser({ id: recipient, email: 'fund-receiver@example.test', name: '수신회원', tag: recipient,
    passwordHash: 'test-only', createdAt: Date.now() });
  await approveTestCustomer(f.database, recipient);
  const third = await funding.intent(user, 'race-shared-quote', input);
  const competing = await Promise.allSettled([
    funding.intent(user, 'race-shared-accept', { action: 'accept_withdrawal', id: third.id }),
    applyReserve(f.database, user, 'race-shared-reserve', { kind: 'in', amountWon: 14_000 }),
    ledger.transfer({ senderId: user, recipientTag: recipient, amountWon: 14_000, idempotencyKey: 'race-shared-transfer' }),
  ]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of competing) {
    if (result.status === 'rejected') assert.ok(result.reason instanceof LedgerError
      && ['FUNDING_BALANCE_LOW', 'INSUFFICIENT_FUNDS'].includes(result.reason.code), result.reason.message);
  }
  assert.equal(await balance(), 6_000);
  assert.equal((await f.database.query('SELECT * FROM internal_ledger_findings()')).rowCount, 0);
});
