import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPublicClient, erc20Abi, formatUnits, http, parseAbiItem, parseUnits, zeroAddress } from 'viem';
import { EvmTransferError, verifyEvmTransfer } from '../server/evm-transfer';

const chainId = 11155111;
const token = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const decimals = 6;
const requiredConfirmations = 12;
const rangeSize = 32n;
const maxRanges = 4;
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const defaultEndpoint = 'https://ethereum-sepolia-rpc.publicnode.com';
const usage = [
  'npm run chain:sepolia -- probe',
  'npm run chain:sepolia -- sample',
  'npm run chain:sepolia -- verify --tx <hash> --log-index <index> --from <address> --to <address> --amount <USDC>',
  'AQUA_SEPOLIA_RPC_URL selects an HTTPS Sepolia endpoint. Amounts support up to six decimal places.',
].join('\n');

class InputError extends Error {}

function endpoint() {
  const value = process.env.AQUA_SEPOLIA_RPC_URL ?? defaultEndpoint;
  if (!URL.canParse(value)) throw new InputError('AQUA_SEPOLIA_RPC_URL must be an HTTPS URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new InputError('AQUA_SEPOLIA_RPC_URL must use HTTPS and omit user information and fragments.');
  }
  return url.href;
}

async function sepoliaClient(rpcUrl: string) {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 12_000, retryCount: 0, fetchOptions: { redirect: 'error' } }),
  });
  if (await client.getChainId() !== chainId) throw new EvmTransferError('WRONG_CHAIN');
  return client;
}

async function probe(rpcUrl: string) {
  const client = await sepoliaClient(rpcUrl);
  const blockNumber = await client.getBlockNumber();
  const code = await client.getCode({ address: token, blockNumber });
  if (!code || code === '0x') throw new InputError('USDC contract code is missing at the selected block.');
  const actualDecimals = await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals', blockNumber });
  if (actualDecimals !== decimals) throw new EvmTransferError('DECIMALS_MISMATCH');
  return { chainId, token, decimals, blockNumber: blockNumber.toString() };
}

type TransferFields = Pick<Parameters<typeof verifyEvmTransfer>[0], 'transactionHash' | 'logIndex' | 'from' | 'to' | 'units'>;

async function verify(rpcUrl: string, transfer: TransferFields) {
  const proof = await verifyEvmTransfer({ rpcUrl, chainId, token, decimals, requiredConfirmations, ...transfer });
  return {
    ...proof, units: proof.units.toString(), amount: formatUnits(proof.units, decimals),
    blockNumber: proof.blockNumber.toString(), requiredConfirmations,
  };
}

async function sample(rpcUrl: string) {
  const client = await sepoliaClient(rpcUrl);
  const head = await client.getBlockNumber();
  let end = head - BigInt(requiredConfirmations) + 1n;
  for (let i = 0; i < maxRanges && end >= 0n; i++) {
    const start = end >= rangeSize ? end - rangeSize + 1n : 0n;
    const logs = await client.getLogs({ address: token, event: transferEvent, fromBlock: start, toBlock: end, strict: true })
      .catch(() => { throw new InputError(`Sepolia RPC could not read USDC logs for blocks ${start} through ${end}.`); });
    for (const log of logs.reverse()) {
      const { from, to, value: units } = log.args;
      if (log.removed || !log.transactionHash || !log.blockHash || log.logIndex === null || log.blockNumber === null ||
          log.blockNumber < start || log.blockNumber > end || log.address.toLowerCase() !== token.toLowerCase() ||
          from === zeroAddress || to === zeroAddress || from === to || units <= 0n) continue;
      const proof = await verify(rpcUrl, { from, to, units, transactionHash: log.transactionHash, logIndex: log.logIndex });
      if (proof.blockNumber !== log.blockNumber.toString() || proof.blockHash !== log.blockHash.toLowerCase()) {
        throw new EvmTransferError('NON_CANONICAL_TRANSFER');
      }
      return { mode: 'sampled_public_transfer', ...proof };
    }
    end = start - 1n;
  }
  throw new InputError('No eligible public USDC transfer in the recent confirmed sample window (up to 128 blocks).');
}

export async function runTestnetCommand(argv: string[]) {
  const [mode, ...args] = argv;
  if (mode === '--help' && !args.length) return usage;
  if (mode === 'probe' && !args.length) return probe(endpoint());
  if (mode === 'sample' && !args.length) return sample(endpoint());
  if (mode !== 'verify') throw new InputError(usage);
  const options = {
    tx: { type: 'string' }, 'log-index': { type: 'string' }, from: { type: 'string' },
    to: { type: 'string' }, amount: { type: 'string' },
  } as const;
  let parsed;
  try { parsed = parseArgs({ args, options, tokens: true, strict: true, allowPositionals: false }); }
  catch { throw new InputError(usage); }
  const { tx, 'log-index': index, from, to, amount } = parsed.values;
  if (parsed.tokens.length !== Object.keys(options).length || !tx || !index || !from || !to || !amount) {
    throw new InputError(usage);
  }
  if (!/^(0|[1-9]\d{0,9})$/.test(index)) throw new InputError('Log index must be a nonnegative integer.');
  if (!/^(0|[1-9]\d{0,77})(\.\d{1,6})?$/.test(amount)) throw new InputError('Specify a positive USDC amount with up to six decimal places.');
  return verify(endpoint(), {
    transactionHash: tx, logIndex: Number(index), from, to, units: parseUnits(amount, decimals),
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTestnetCommand(process.argv.slice(2)).then(result => {
    console.log(typeof result === 'string' ? result : JSON.stringify(result));
  }).catch((error: unknown) => {
    // Provider error messages can include API keys supplied in the endpoint path or query.
    const message = error instanceof InputError || error instanceof EvmTransferError ? error.message : 'RPC_UNAVAILABLE';
    console.error(message);
    process.exitCode = 1;
  });
}
