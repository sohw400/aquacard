import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { EvmTransferError, verifyEvmTransfer, type EvmTransferRequest } from './evm-transfer';

const token = '0x' + '11'.repeat(20);
const from = '0x' + '22'.repeat(20);
const to = '0x' + '33'.repeat(20);
const transactionHash = '0x' + 'aa'.repeat(32);
const blockHash = '0x' + 'bb'.repeat(32);
const replacement = '0x' + 'cc'.repeat(32);
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const quantity = (value: bigint) => '0x' + value.toString(16).padStart(64, '0');
const defaults: EvmTransferRequest = {
  rpcUrl: 'http://127.0.0.1:1', chainId: 31337, token, from, to, units: 1_234_567n, decimals: 6,
  transactionHash, logIndex: 2, requiredConfirmations: 12,
};
const event = {
  address: token, topics: [transferTopic, quantity(BigInt(from)), quantity(BigInt(to))], data: quantity(defaults.units),
  blockNumber: '0x14', blockHash, transactionHash, transactionIndex: '0x1', logIndex: '0x2', removed: false,
};
const receipt = {
  blockNumber: '0x14', blockHash, status: '0x1', transactionHash, transactionIndex: '0x1',
  cumulativeGasUsed: '0xabc', gasUsed: '0xabc', logs: [event],
};
const block = { number: '0x14', hash: blockHash, transactions: [replacement, transactionHash] };
type Method = 'eth_chainId' | 'eth_getTransactionReceipt' | 'eth_blockNumber' | 'eth_call' | 'eth_getBlockByNumber';

function baseline(method: Method) {
  switch (method) {
    case 'eth_chainId': return '0x7a69';
    case 'eth_getTransactionReceipt': return receipt;
    case 'eth_blockNumber': return '0x1f'; // Included at 20, tip 31: 12 confirmations.
    case 'eth_call': return quantity(6n);
    case 'eth_getBlockByNumber': return block;
  }
}

/** Set the RPC behavior per scenario, including different receipts for the first and last read. */
async function withRpc(run: (url: string, respond: (handler: (method: Method, call: number, params: unknown[]) => unknown) => void) => Promise<void>) {
  let reply: (method: Method, call: number, params: unknown[]) => unknown = baseline;
  const counts = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part as Buffer);
    const { method, id, params = [] } = JSON.parse(Buffer.concat(chunks).toString());
    const call = (counts.get(method) || 0) + 1;
    counts.set(method, call);
    const result = reply(method, call, params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result === undefined
      ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'RPC method unavailable' } }
      : { jsonrpc: '2.0', id, result }));
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  try {
    await run('http://127.0.0.1:' + (server.address() as AddressInfo).port, (handler) => { counts.clear(); reply = handler; });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const hasCode = (code: string) => (error: unknown) => error instanceof EvmTransferError && error.code === code;

test('checks the exact indexed transfer against its receipt, historical contract and canonical block', async () => {
  await withRpc(async (rpcUrl, respond) => {
    const calls: { method: Method; params: unknown[] }[] = [];
    respond((method, _n, params) => { calls.push({ method, params }); return baseline(method); });
    const result = await verifyEvmTransfer({ ...defaults, rpcUrl });
    assert.deepEqual(result, {
      chainId: 31337, token, from, to, units: 1_234_567n, decimals: 6, transactionHash, logIndex: 2,
      blockNumber: 20n, blockHash, confirmations: 12,
    });
    assert.equal(calls.filter(({ method }) => method === 'eth_getTransactionReceipt').length, 2);
    assert.deepEqual(calls.find(({ method }) => method === 'eth_getBlockByNumber')?.params, ['0x14', false]);
    assert.deepEqual(calls.find(({ method }) => method === 'eth_call')?.params, [{ data: '0x313ce567', to: token }, '0x14']);
  });
});

test('rejects missing, mismatched, insufficiently confirmed and reorganized transfers', async () => {
  type Scenario = [string, Method, unknown | ((n: number) => unknown), string];
  const scenarios: Scenario[] = [
    ['chain ID', 'eth_chainId', '0x1', 'WRONG_CHAIN'],
    ['pending receipt', 'eth_getTransactionReceipt', null, 'RECEIPT_UNAVAILABLE'],
    ['reverted', 'eth_getTransactionReceipt', { ...receipt, status: '0x0' }, 'TRANSACTION_REVERTED'],
    ['wrong token', 'eth_getTransactionReceipt', { ...receipt, logs: [{ ...event, address: to }] }, 'TRANSFER_MISMATCH'],
    ['wrong sender', 'eth_getTransactionReceipt', { ...receipt, logs: [{ ...event, topics: [transferTopic, event.topics[2], event.topics[2]] }] }, 'TRANSFER_MISMATCH'],
    ['wrong beneficiary', 'eth_getTransactionReceipt', { ...receipt, logs: [{ ...event, topics: [transferTopic, event.topics[1], event.topics[1]] }] }, 'TRANSFER_MISMATCH'],
    ['wrong event signature', 'eth_getTransactionReceipt', { ...receipt, logs: [{ ...event, topics: [replacement, ...event.topics.slice(1)] }] }, 'TRANSFER_MISMATCH'],
    ['wrong units', 'eth_getTransactionReceipt', { ...receipt, logs: [{ ...event, data: quantity(defaults.units + 1n) }] }, 'TRANSFER_MISMATCH'],
    ['wrong block-wide index', 'eth_getTransactionReceipt', { ...receipt, logs: [{ ...event, logIndex: '0x1' }] }, 'TRANSFER_MISMATCH'],
    ['ambiguous index', 'eth_getTransactionReceipt', { ...receipt, logs: [event, event] }, 'TRANSFER_MISMATCH'],
    ['removed', 'eth_getTransactionReceipt', { ...receipt, logs: [{ ...event, removed: true }] }, 'NON_CANONICAL_TRANSFER'],
    ['other transaction', 'eth_getTransactionReceipt', { ...receipt, logs: [{ ...event, transactionHash: replacement }] }, 'NON_CANONICAL_TRANSFER'],
    ['receipt changed between reads', 'eth_getTransactionReceipt', (n: number) => n === 1 ? receipt : {
      ...receipt, blockHash: replacement, logs: [{ ...event, blockHash: replacement }],
    }, 'NON_CANONICAL_TRANSFER'],
    ['orphaned block', 'eth_getBlockByNumber', { ...block, hash: replacement }, 'NON_CANONICAL_TRANSFER'],
    ['transaction missing from canonical block', 'eth_getBlockByNumber', { ...block, transactions: [transactionHash, replacement] }, 'NON_CANONICAL_TRANSFER'],
    ['wrong token precision', 'eth_call', quantity(18n), 'DECIMALS_MISMATCH'],
    ['one block short', 'eth_blockNumber', '0x1e', 'INSUFFICIENT_CONFIRMATIONS'],
    ['shorter canonical tip during verification', 'eth_blockNumber', (n: number) => n === 1 ? '0x1f' : '0x1e', 'INSUFFICIENT_CONFIRMATIONS'],
  ];
  await withRpc(async (rpcUrl, respond) => {
    for (const [name, changed, value, code] of scenarios) {
      respond((method, count) => method === changed ? (typeof value === 'function' ? value(count) : value) : baseline(method));
      await assert.rejects(verifyEvmTransfer({ ...defaults, rpcUrl }), hasCode(code), name);
    }
  });
});

test('accepts only explicit test networks and bounded nonzero transfer inputs', async () => {
  for (const bad of [
    { chainId: 1 }, { rpcUrl: 'http://example.test' }, { chainId: 11155111, rpcUrl: 'http://example.test' },
    { rpcUrl: 'invalid' }, { rpcUrl: 'http://me:secret@localhost' }, { logIndex: -1 }, { units: 0n },
    { units: 1n << 256n }, { decimals: 256 }, { to: from }, { from: '0x' + '00'.repeat(20) },
    { transactionHash: '0xabc' }, { requiredConfirmations: 0 },
  ]) {
    await assert.rejects(verifyEvmTransfer({ ...defaults, ...bad }), error => error instanceof EvmTransferError
      && ['INVALID_TRANSFER_REQUEST', 'UNSUPPORTED_TEST_CHAIN'].includes(error.code));
  }
  await assert.rejects(verifyEvmTransfer({ ...defaults, rpcUrl: 'http://127.0.0.1:1/private-credential' }), hasCode('RPC_UNAVAILABLE'));
});
