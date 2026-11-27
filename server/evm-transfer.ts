import {
  createPublicClient, encodeEventTopics, erc20Abi, getAddress, http,
  isAddress, maxUint256, toHex, TransactionReceiptNotFoundError, zeroAddress,
  type Address, type Hash, type TransactionReceipt,
} from 'viem';

export interface EvmTransferRequest {
  rpcUrl: string;
  chainId: number;
  token: string;
  from: string;
  to: string;
  units: bigint;
  decimals: number;
  transactionHash: string;
  /** The log index in the block, as reported by eth_getTransactionReceipt. */
  logIndex: number;
  requiredConfirmations: number;
}

type ErrorCode = 'INVALID_TRANSFER_REQUEST' | 'UNSUPPORTED_TEST_CHAIN' | 'WRONG_CHAIN' | 'RPC_UNAVAILABLE'
  | 'RECEIPT_UNAVAILABLE' | 'TRANSACTION_REVERTED' | 'TRANSFER_MISMATCH' | 'DECIMALS_MISMATCH'
  | 'NON_CANONICAL_TRANSFER' | 'INSUFFICIENT_CONFIRMATIONS';

export class EvmTransferError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}

const isHash = (value: unknown): value is Hash => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

function address(value: string): Address {
  if (typeof value !== 'string' || !isAddress(value) || same(value, zeroAddress)) {
    throw new EvmTransferError('INVALID_TRANSFER_REQUEST');
  }
  return getAddress(value);
}

export async function verifyEvmTransfer(request: EvmTransferRequest) {
  const { chainId, logIndex, units, decimals, requiredConfirmations } = request;
  if (chainId !== 31337 && chainId !== 11155111) throw new EvmTransferError('UNSUPPORTED_TEST_CHAIN');
  if (typeof request.rpcUrl !== 'string' || !URL.canParse(request.rpcUrl)) throw new EvmTransferError('INVALID_TRANSFER_REQUEST');
  const url = new URL(request.rpcUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (chainId === 31337 ? url.protocol !== 'http:' || !loopback : url.protocol !== 'https:')) {
    throw new EvmTransferError('INVALID_TRANSFER_REQUEST');
  }
  const token = address(request.token);
  const from = address(request.from);
  const to = address(request.to);
  if (from === to || !isHash(request.transactionHash) || typeof units !== 'bigint' || units <= 0n || units > maxUint256
    || !Number.isInteger(decimals) || decimals < 0 || decimals > 255
    || !Number.isSafeInteger(logIndex) || logIndex < 0 || logIndex > 0xffff_ffff
    || !Number.isSafeInteger(requiredConfirmations) || requiredConfirmations < 1 || requiredConfirmations > 9_999_999) {
    throw new EvmTransferError('INVALID_TRANSFER_REQUEST');
  }
  const transactionHash = request.transactionHash.toLowerCase() as Hash;
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } });
  const data = toHex(units, { size: 32 });
  function checkReceipt(receipt: TransactionReceipt) {
    if (receipt.status !== 'success') throw new EvmTransferError('TRANSACTION_REVERTED');
    if (!isHash(receipt.blockHash) || typeof receipt.blockNumber !== 'bigint' || !same(receipt.transactionHash, transactionHash)) {
      throw new EvmTransferError('NON_CANONICAL_TRANSFER');
    }
    const matches = receipt.logs.filter(log => log.logIndex === logIndex);
    const log = matches[0];
    if (matches.length !== 1 || !same(log.address, token) || log.topics.length !== topics.length
      || !log.topics.every((topic, i) => same(topic, topics[i] as string)) || !same(log.data, data)) {
      throw new EvmTransferError('TRANSFER_MISMATCH');
    }
    if (log.removed || !same(log.blockHash, receipt.blockHash) || log.blockNumber !== receipt.blockNumber
      || !same(log.transactionHash, transactionHash) || log.transactionIndex !== receipt.transactionIndex) {
      throw new EvmTransferError('NON_CANONICAL_TRANSFER');
    }
  }

  // This client only reads chain state. RPC URLs may contain access tokens in the path or query.
  const client = createPublicClient({ cacheTime: 0, transport: http(url.href, {
    timeout: 10_000, retryCount: 0, fetchOptions: { redirect: 'error' },
  }) });
  try {
    if (await client.getChainId() !== chainId) throw new EvmTransferError('WRONG_CHAIN');
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    checkReceipt(receipt);
    const { blockNumber, blockHash, transactionIndex } = receipt;
    const [head, tokenDecimals] = await Promise.all([
      client.getBlockNumber(), client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals', blockNumber }),
    ]);
    if (tokenDecimals !== decimals) throw new EvmTransferError('DECIMALS_MISMATCH');
    if (head < blockNumber) throw new EvmTransferError('NON_CANONICAL_TRANSFER');
    const depth = head - blockNumber + 1n;
    if (depth < BigInt(requiredConfirmations)) throw new EvmTransferError('INSUFFICIENT_CONFIRMATIONS');

    // Re-read both the canonical block at this height and its receipt after the other RPC calls.
    // The tip can also recede without displacing the transfer block.
    const [block, current, latestHead] = await Promise.all([
      client.getBlock({ blockNumber }), client.getTransactionReceipt({ hash: transactionHash }), client.getBlockNumber(),
    ]);
    checkReceipt(current);
    if (block.number !== blockNumber || !same(block.hash, blockHash) || !same(block.transactions[transactionIndex], transactionHash)
      || !same(current.blockHash, blockHash) || current.blockNumber !== blockNumber || current.transactionIndex !== transactionIndex
      || latestHead < blockNumber) {
      throw new EvmTransferError('NON_CANONICAL_TRANSFER');
    }
    const confirmations = latestHead - blockNumber + 1n;
    if (confirmations < BigInt(requiredConfirmations)) throw new EvmTransferError('INSUFFICIENT_CONFIRMATIONS');
    if (confirmations > BigInt(Number.MAX_SAFE_INTEGER)) throw new EvmTransferError('RPC_UNAVAILABLE');
    return { chainId, token, from, to, units, decimals, transactionHash, logIndex, blockNumber,
      blockHash: blockHash.toLowerCase() as Hash, confirmations: Number(confirmations) };
  } catch (error) {
    if (error instanceof EvmTransferError) throw error;
    if (error instanceof TransactionReceiptNotFoundError) throw new EvmTransferError('RECEIPT_UNAVAILABLE');
    throw new EvmTransferError('RPC_UNAVAILABLE');
  }
}
