import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import solc from 'solc';
import {
  createTestClient, formatUnits, http, parseAbi, parseUnits, publicActions, walletActions,
  type Address, type LocalAccount, type Hex,
} from 'viem';
import { foundry } from 'viem/chains';
import { verifyEvmTransfer } from '../server/evm-transfer';
import { FundingStore } from '../server/funding-store';
import { CardPaymentStore } from '../server/card-payments';
import { IssuerOutboxStore } from '../server/issuer-outbox';
import type { Database } from '../server/database';
import { LedgerStore } from '../server/ledger';
import { approveTestCustomer } from '../server/test-customer-access';
import { createTestDatabase } from '../server/test-support';
import type { MemberFunding } from '../shared/funding';
import type { SandboxCardEvent } from '../shared/api';
import { startTestEvmNode } from './test-evm-node';

const decimals = 6;
const abi = parseAbi([
  'constructor(uint256 supply)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address recipient, uint256 value) returns (bool)',
]);

async function compileMockToken(): Promise<Hex> {
  const file = 'MockKRWS.sol';
  const content = await readFile(new URL('./fixtures/' + file, import.meta.url), 'utf8');
  const compiled = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { [file]: { content } },
    settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
  })));
  const errors = compiled.errors?.filter((issue: { severity: string }) => issue.severity === 'error') ?? [];
  assert.deepEqual(errors, [], 'Local token compilation failed.');
  const hex = compiled.contracts[file].MockKRWS.evm.bytecode.object;
  assert.match(hex, /^[a-f0-9]+$/);
  return `0x${hex}`;
}

type Verified = Awaited<ReturnType<typeof verifyEvmTransfer>>;

// The synthetic database keeps its own reference format and quote addresses. Within a fresh
// local schema only, the body of each reference is the actual receipt hash and its log index.
function chainReferences(receipt: Verified) {
  return {
    transferRef: `sim-tx:${receipt.transactionHash.slice(2)}:${receipt.logIndex}`,
    blockRef: `sim-block:${receipt.blockHash.slice(2)}`,
  };
}

async function exercise(db: Database,
  node: Awaited<ReturnType<typeof startTestEvmNode>>, bytecode: Hex) {
  const chain = createTestClient({
    chain: foundry, mode: 'anvil', transport: http(node.rpcUrl), cacheTime: 0, pollingInterval: 50,
  }).extend(publicActions).extend(walletActions);
  const [payer, custody, recipient] = node.accounts;
  const supply = parseUnits('25000', decimals);
  const deployment = await chain.deployContract({ account: payer, abi, bytecode, args: [supply] });
  const deployed = await chain.waitForTransactionReceipt({ hash: deployment });
  assert.equal(deployed.status, 'success');
  assert.ok(deployed.contractAddress);
  const token = deployed.contractAddress;

  const funding = new FundingStore(db);
  const ledger = new LedgerStore(db);
  const user = 'evm-drill-member';
  await ledger.createUser({ id: user, name: '체인 시험 회원', email: 'evm@example.test',
    tag: 'evmdrill', passwordHash: 'fixture-only', createdAt: Date.now() });
  await approveTestCustomer(db, user);
  const balance = async () => (await ledger.snapshot(user)).balanceWon;
  const tokenBalance = (address: Address) => chain.readContract({ address: token, abi, functionName: 'balanceOf', args: [address] });
  const event = (op: MemberFunding, action: string, eventId: string, evidence: Record<string, unknown> = {}) =>
    funding.event({ id: op.id, action, eventId, ...evidence });

  // The routing table is private to this run. Bind each accepted synthetic address before
  // broadcasting anything. Never choose the expected recipient from an incoming receipt.
  const routes = new Map<string, Address>();
  async function send(op: MemberFunding, sender: LocalAccount) {
    const to = routes.get(op.destination);
    assert.ok(to, 'A local receiving account must be assigned to this funding destination.');
    const units = parseUnits(op.units, decimals);
    const transactionHash = await chain.writeContract({
      account: sender, address: token, abi, functionName: 'transfer', args: [to, units],
    });
    const receipt = await chain.waitForTransactionReceipt({ hash: transactionHash });
    assert.equal(receipt.status, 'success');
    assert.equal(receipt.logs.length, 1);
    return { rpcUrl: node.rpcUrl, chainId: foundry.id, token, from: sender.address,
      to, units, decimals, transactionHash, logIndex: receipt.logs[0].logIndex };
  }
  async function observe(op: MemberFunding, receipt: Verified, key: string) {
    return event(op, 'observe', key, { ...chainReferences(receipt), asset: op.asset, network: op.network,
      units: formatUnits(receipt.units, decimals), destination: op.destination });
  }

  const deposit = await funding.intent(user, 'deposit-quote', {
    action: 'quote', direction: 'deposit', network: 'ethereum', asset: 'KRWS', quantity: '25000',
  });
  assert.equal(deposit.requiredConfirmations, 12);
  routes.set(deposit.destination, custody.address);
  assert.equal((await funding.intent(user, 'deposit-accept', { action: 'accept_deposit', id: deposit.id })).status, 'awaiting');
  const snapshotId = await chain.snapshot();
  const orphanTx = await send(deposit, payer);
  const orphan = await verifyEvmTransfer({ ...orphanTx, requiredConfirmations: 1 });
  assert.equal((await observe(deposit, orphan, 'observe-original')).status, 'observed');
  await assert.rejects(verifyEvmTransfer({ ...orphanTx, requiredConfirmations: deposit.requiredConfirmations }),
    { code: 'INSUFFICIENT_CONFIRMATIONS' });
  assert.equal(await balance(), 0);

  await chain.revert({ id: snapshotId });
  await chain.mine({ blocks: 1 });
  const canonicalBlock = await chain.getBlock({ blockNumber: orphan.blockNumber });
  assert.notEqual(canonicalBlock.hash, orphan.blockHash);
  await assert.rejects(verifyEvmTransfer({ ...orphanTx, requiredConfirmations: 1 }),
    { code: 'RECEIPT_UNAVAILABLE' });
  assert.equal(await tokenBalance(custody.address), 0n);
  assert.equal((await event(deposit, 'reorg', 'orphaned-receipt', chainReferences(orphan))).status, 'awaiting');
  assert.equal(await balance(), 0);
  console.log('Deposit held at 1/12 confirmations. Orphaned transfer discarded with 0 TEST_KRW posted.');

  const depositTx = await send(deposit, payer);
  const first = await verifyEvmTransfer({ ...depositTx, requiredConfirmations: 1 });
  await observe(deposit, first, 'observe-replacement');
  await chain.mine({ blocks: deposit.requiredConfirmations - 1 });
  const confirmed = await verifyEvmTransfer({ ...depositTx, requiredConfirmations: deposit.requiredConfirmations });
  const confirm = await event(deposit, 'confirm', 'confirm-deposit', {
    ...chainReferences(confirmed), confirmations: confirmed.confirmations,
  });
  assert.equal(confirm.status, 'confirmed');
  assert.equal(await balance(), 0);
  const credit = () => event(deposit, 'convert', 'credit-after-confirm');
  const [posted, repeated] = await Promise.all([credit(), credit()]);
  assert.equal(posted.status, 'credited');
  assert.deepEqual(posted, repeated);
  assert.equal(await tokenBalance(custody.address), supply);
  assert.equal(await balance(), 25_000);
  console.log('Confirmed deposit: 25,000 MockKRWS, wallet 25,000 TEST_KRW after replay.', confirmed.transactionHash);

  const destination = 'aqua-test:ethereum:local-recipient';
  routes.set(destination, recipient.address);
  const withdrawal = await funding.intent(user, 'withdraw-quote', {
    action: 'quote', direction: 'withdrawal', network: 'ethereum', asset: 'KRWS', quantity: '14000', destination,
  });
  assert.equal(withdrawal.networkFeeWon, 2_800);
  assert.equal(withdrawal.units, '11200');
  assert.equal((await funding.intent(user, 'withdraw-accept', { action: 'accept_withdrawal', id: withdrawal.id })).status, 'held');
  assert.equal(await balance(), 11_000);
  assert.equal((await event(withdrawal, 'dispatch', 'dispatch-withdrawal')).status, 'dispatched');
  const withdrawalTx = await send(withdrawal, custody);
  await assert.rejects(verifyEvmTransfer({ ...withdrawalTx, requiredConfirmations: withdrawal.requiredConfirmations }),
    { code: 'INSUFFICIENT_CONFIRMATIONS' });
  await chain.mine({ blocks: withdrawal.requiredConfirmations - 1 });
  const delivered = await verifyEvmTransfer({ ...withdrawalTx, requiredConfirmations: withdrawal.requiredConfirmations });
  const settle = () => event(withdrawal, 'settle', 'settled-withdrawal', { dispatchKey: withdrawal.id,
    proofRef: `sim-proof:${delivered.blockHash.slice(2)}`, transferRef: chainReferences(delivered).transferRef });
  assert.equal((await settle()).status, 'settled');
  await settle();
  assert.equal(await balance(), 11_000);
  assert.equal(await tokenBalance(recipient.address), parseUnits('11200', decimals));
  assert.equal(await tokenBalance(custody.address), parseUnits('13800', decimals));

  const deposits = await db.query('SELECT phase, amount_won::text FROM funding_cash_postings WHERE funding_id=$1', [deposit.id]);
  assert.deepEqual(deposits.rows, [{ phase: 'credit', amount_won: '25000' }]);
  const withdrawals = await db.query('SELECT phase, amount_won::text FROM funding_cash_postings WHERE funding_id=$1 ORDER BY phase', [withdrawal.id]);
  assert.deepEqual(withdrawals.rows, [
    { phase: 'hold', amount_won: '14000' }, { phase: 'network_fee', amount_won: '2800' }, { phase: 'settle', amount_won: '11200' },
  ]);
  console.log('Settled withdrawal: 11,200 MockKRWS received, 2,800 TEST_KRW network fee, wallet 11,000 TEST_KRW.', delivered.transactionHash);

  const tipBeforeCard = (await chain.getBlock()).hash;
  await new IssuerOutboxStore(db).register({ userId: user, providerCardId: 'sandbox-card-evm-drill', initialStatus: 'active' });
  const cards = new CardPaymentStore(db);
  const payment = { paymentId: 'evm-drill-payment', userId: user, amountWon: 3_000 };
  const authorization: SandboxCardEvent = {
    ...payment, kind: 'authorize', eventId: 'evm-drill-authorize', merchantName: '체험 가맹점',
  };
  const capture: SandboxCardEvent = { ...payment, kind: 'capture', eventId: 'evm-drill-capture', finalCapture: true };
  const authorized = await cards.apply(authorization);
  assert.equal(authorized.payment.status, 'authorized');
  assert.deepEqual([authorized.balanceWon, authorized.heldBalanceWon], [8_000, 3_000]);
  const captured = await cards.apply(capture);
  assert.equal(captured.payment.status, 'captured');
  assert.deepEqual([captured.balanceWon, captured.heldBalanceWon], [8_000, 0]);
  const reopened = new CardPaymentStore(db);
  assert.deepEqual(await reopened.apply(authorization), authorized);
  assert.deepEqual(await reopened.apply(capture), captured);
  const afterCard = await new LedgerStore(db).snapshot(user);
  assert.deepEqual([afterCard.balanceWon, afterCard.heldBalanceWon, afterCard.cardPayments.length], [8_000, 0, 1]);
  assert.equal((await chain.getBlock()).hash, tipBeforeCard, 'Card authorization and capture must not broadcast on-chain.');
  assert.equal((await db.query('SELECT * FROM internal_ledger_findings()')).rowCount, 0);
  console.log('Sandbox card authorized and captured 3,000 TEST_KRW; wallet 8,000, card hold 0, no new on-chain transaction.');
}

async function run() {
  assert.notEqual(process.env.NODE_ENV, 'production', 'This command starts a disposable local fixture.');
  const connection = new URL(process.env.TEST_DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname)
    && !connection.search && !connection.hash, 'Set TEST_DATABASE_URL to a local PostgreSQL database without URL overrides.');
  const bytecode = await compileMockToken();
  const fixture = await createTestDatabase();
  try {
    const node = await startTestEvmNode();
    try { await exercise(fixture.database, node, bytecode); } finally { await node.close(); }
  } finally { await fixture.cleanup(); }
}
await run();
