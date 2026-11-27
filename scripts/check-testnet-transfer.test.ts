import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { runTestnetCommand } from './check-testnet-transfer';

const token = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const sender = '0x' + '1'.repeat(40);
const recipient = '0x' + '2'.repeat(40);
const transactionHash = '0x' + '3'.repeat(64);
const blockHash = '0x' + '4'.repeat(64);
const word = (value: bigint) => '0x' + value.toString(16).padStart(64, '0');
const topics = [
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  word(BigInt(sender)), word(BigInt(recipient)),
];
const location = { transactionHash, transactionIndex: '0x0', blockHash, blockNumber: '0xbe' };
const transfer = { ...location, address: token, topics, data: word(10_250_000n), logIndex: '0x1', removed: false };
const verifyArgs = ['verify', '--tx', transactionHash, '--log-index', '1', '--from', sender, '--to', recipient, '--amount', '10.25'];

function mockRpc(t: TestContext, overrides: Record<string, () => unknown> = {}) {
  const replies: Record<string, () => unknown> = {
    eth_chainId: () => '0xaa36a7', eth_blockNumber: () => '0x100',
    eth_getCode: () => '0xaa', eth_call: () => word(6n),
    eth_getTransactionReceipt: () => ({ ...location, status: '0x1', logs: [transfer] }),
    eth_getBlockByNumber: () => ({ number: location.blockNumber, hash: blockHash, transactions: [transactionHash] }),
    ...overrides,
  };
  const calls: { method: string; params: unknown[] }[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ method, params });
    assert.ok(Object.hasOwn(replies, method), 'unexpected RPC method: ' + method);
    return Response.json({ jsonrpc: '2.0', id, result: replies[method]() });
  });
  return calls;
}

test('probe verifies the pinned network and checks code and decimals at the same height', async t => {
  const calls = mockRpc(t);
  assert.deepEqual(await runTestnetCommand(['probe']), { chainId: 11155111, token, decimals: 6, blockNumber: '256' });
  assert.deepEqual(calls.map(call => call.method), ['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call']);
  assert.equal(calls[2].params[1], '0x100');
  assert.equal(calls[3].params[1], '0x100');
});

test('mainnet is rejected before reading contract code or logs', async t => {
  const calls = mockRpc(t, { eth_chainId: () => '0x1' });
  for (const args of [['probe'], ['sample'], verifyArgs]) {
    await assert.rejects(runTestnetCommand(args), /WRONG_CHAIN/);
  }
  assert.deepEqual(calls.map(call => call.method), Array(3).fill('eth_chainId'));
});

test('verify preserves six-decimal precision and rejects ambiguous quantities before reading the chain', async t => {
  const calls = mockRpc(t);
  for (const amount of ['0.0000001', '10.2500000', '1e2', '-1', '0']) {
    await assert.rejects(runTestnetCommand([...verifyArgs.slice(0, -1), amount]));
  }
  await assert.rejects(runTestnetCommand([...verifyArgs, '--amount', '10.26']));
  assert.equal(calls.length, 0);
  assert.deepEqual(await runTestnetCommand(verifyArgs), {
    chainId: 11155111, token, decimals: 6, from: sender, to: recipient, units: '10250000', amount: '10.25',
    transactionHash, logIndex: 1, blockNumber: '190', blockHash, confirmations: 67, requiredConfirmations: 12,
  });
});

test('sample skips mints, removed and pending logs, then verifies a past transfer with the receipt', async t => {
  let range = 0;
  const recent = { ...transfer, blockNumber: '0xe1' };
  const skip = [
    { ...recent, topics: [topics[0], word(0n), topics[2]] },
    { ...recent, topics: [topics[0], topics[1], word(0n)] },
    { ...recent, data: word(0n) },
    { ...recent, removed: true },
    { ...recent, transactionHash: null },
  ];
  const calls = mockRpc(t, { eth_getLogs: () => ++range === 1 ? skip : [transfer] });
  const sample = await runTestnetCommand(['sample']);
  assert.deepEqual(sample, { mode: 'sampled_public_transfer', ...await runTestnetCommand(verifyArgs) as object });
  const scans = calls.filter(call => call.method === 'eth_getLogs').map(call => call.params[0]);
  assert.deepEqual(scans, [
    { address: token, topics: [topics[0]], fromBlock: '0xd6', toBlock: '0xf5' },
    { address: token, topics: [topics[0]], fromBlock: '0xb6', toBlock: '0xd5' },
  ]);
  assert.equal(calls.filter(call => call.method === 'eth_getTransactionReceipt').length, 4);
});

test('sample stops after a bounded search and reports an unreadable range separately', async t => {
  let limited = false;
  const calls = mockRpc(t, { eth_getLogs: () => { if (limited) throw new Error('upstream details'); return []; } });
  await assert.rejects(runTestnetCommand(['sample']), /No eligible public USDC transfer/);
  assert.equal(calls.filter(call => call.method === 'eth_getLogs').length, 4);
  limited = true;
  await assert.rejects(runTestnetCommand(['sample']), /could not read USDC logs for blocks 214 through 245/);
  assert.equal(calls.filter(call => call.method === 'eth_getLogs').length, 5);
});

test('sample rejects a log whose receipt now belongs to another block', async t => {
  let range = 0;
  mockRpc(t, { eth_getLogs: () => ++range === 1 ? [] : [{ ...transfer, blockHash: '0x' + '5'.repeat(64) }] });
  await assert.rejects(runTestnetCommand(['sample']), /NON_CANONICAL_TRANSFER/);
});
