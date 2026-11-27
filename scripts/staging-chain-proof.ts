import assert from 'node:assert/strict';
import {
  createTestClient, encodeFunctionData, getAddress, http, isAddress, keccak256, parseTransaction,
  parseUnits, publicActions, recoverTransactionAddress, toHex, verifyMessage, walletActions, zeroAddress,
  type Address, type Hash, type Hex, type TransactionSerializedEIP1559,
} from 'viem';
import { foundry } from 'viem/chains';
import { verifyEvmTransfer } from '../server/evm-transfer';
import { startTestEvmNode } from './test-evm-node';
import { abi, compileMockToken, decimals } from './test-evm-token';

export interface LocalDepositBinding {
  memberId: string;
  intentId: string;
  destination: string;
  units: string;
  requiredConfirmations: number;
}

export interface LocalDepositProof extends LocalDepositBinding {
  format: 'aqua-local-deposit-v1';
  chainId: 31337;
  token: Address;
  from: Address;
  to: Address;
  decimals: 6;
  transactionHash: Hash;
  blockHash: Hash;
  blockNumber: string;
  logIndex: number;
  confirmations: number;
  rawTransaction: TransactionSerializedEIP1559;
  receiptSignature: Hex;
}

function tokenAmount(binding: LocalDepositBinding) {
  assert.match(binding.memberId, /^[a-zA-Z0-9_-]{1,128}$/);
  assert.match(binding.intentId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(binding.destination, 'aqua-test:ethereum:' + binding.intentId);
  // parseUnits rounds excess precision. Only excess zeroes in the funding quote are exact.
  assert.match(binding.units, /^(0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6}0{0,2})?$/);
  const amount = parseUnits(binding.units, decimals);
  assert.ok(amount > 0n, 'The local deposit must have a positive quantity.');
  assert.ok(Number.isSafeInteger(binding.requiredConfirmations) && binding.requiredConfirmations >= 1
    && binding.requiredConfirmations <= 256, 'Invalid local confirmation depth.');
  return amount;
}

function fundingCommitment(b: LocalDepositBinding) {
  return keccak256(toHex(JSON.stringify([
    'aqua-local-deposit-v1', foundry.id, decimals, b.memberId, b.intentId, b.destination, b.units, b.requiredConfirmations,
  ])));
}

type ObservedReceipt = Pick<LocalDepositProof, 'transactionHash' | 'blockHash' | 'blockNumber' | 'logIndex' | 'confirmations'>;

function receiptMessage(proof: ObservedReceipt) {
  // The chain disappears on shutdown. Keep a signed record of the issuing fixture's live check.
  return JSON.stringify(['aqua-local-receipt-v1', proof.transactionHash, proof.blockHash,
    proof.blockNumber, proof.logIndex, proof.confirmations]);
}

function archiveAddress(value: unknown): Address {
  assert.ok(typeof value === 'string' && isAddress(value) && value !== zeroAddress, 'Invalid archived EVM address.');
  return getAddress(value);
}

export async function validateLocalDepositProof(value: unknown, binding: LocalDepositBinding): Promise<LocalDepositProof> {
  const amount = tokenAmount(binding);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Missing local deposit proof.');
  const proof = value as Partial<LocalDepositProof>;
  assert.equal(proof.format, 'aqua-local-deposit-v1');
  assert.equal(proof.chainId, foundry.id);
  assert.equal(proof.decimals, decimals);
  for (const field of ['memberId', 'intentId', 'destination', 'units', 'requiredConfirmations'] as const) {
    assert.equal(proof[field], binding[field], 'Archived proof does not match the deposit ' + field + '.');
  }

  const token = archiveAddress(proof.token);
  const from = archiveAddress(proof.from);
  const to = archiveAddress(proof.to);
  assert.equal(new Set([token, from, to]).size, 3);
  const { transactionHash, blockHash, blockNumber, logIndex, confirmations, rawTransaction, receiptSignature } = proof;
  assert.ok(typeof blockHash === 'string' && /^0x[a-f0-9]{64}$/.test(blockHash));
  assert.ok(typeof blockNumber === 'string' && /^[1-9][0-9]{0,19}$/.test(blockNumber));
  assert.ok(typeof logIndex === 'number' && Number.isSafeInteger(logIndex) && logIndex >= 0 && logIndex < 1_000_000);
  assert.ok(typeof confirmations === 'number' && Number.isSafeInteger(confirmations)
    && confirmations >= binding.requiredConfirmations && confirmations <= 9_999_999);
  assert.ok(typeof receiptSignature === 'string' && /^0x[0-9a-f]{130}$/.test(receiptSignature));
  assert.ok(typeof rawTransaction === 'string' && /^0x02(?:[0-9a-f]{2}){1,1024}$/.test(rawTransaction));
  assert.ok(transactionHash && transactionHash === keccak256(rawTransaction), 'Signed transaction hash differs.');

  const tx = parseTransaction(rawTransaction);
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.chainId, foundry.id);
  assert.equal(archiveAddress(tx.to), token);
  assert.equal(tx.value ?? 0n, 0n);
  assert.equal(tx.data, encodeFunctionData({ abi, functionName: 'transfer', args: [to, amount] }));
  assert.equal(tx.accessList?.length, 1);
  assert.equal(archiveAddress(tx.accessList[0].address), to);
  assert.deepEqual(tx.accessList[0].storageKeys, [fundingCommitment(binding)], 'Signed transaction belongs to another deposit.');
  assert.equal(await recoverTransactionAddress({ serializedTransaction: rawTransaction }), from);
  const receipt = { transactionHash, blockHash, blockNumber, logIndex, confirmations };
  assert.ok(await verifyMessage({ address: from, message: receiptMessage(receipt), signature: receiptSignature }),
    'Local confirmation signature differs.');
  const { memberId, intentId, destination, units, requiredConfirmations } = binding;
  return { format: 'aqua-local-deposit-v1', chainId: foundry.id, decimals, memberId, intentId,
    destination, units, requiredConfirmations, token, from, to, ...receipt, rawTransaction, receiptSignature };
}

export async function issueLocalDepositProof(binding: LocalDepositBinding): Promise<LocalDepositProof> {
  assert.notEqual(process.env.NODE_ENV, 'production', 'This proof requires a disposable local chain.');
  const amount = tokenAmount(binding);
  const bytecode = await compileMockToken();
  const node = await startTestEvmNode();
  try {
    const chain = createTestClient({ chain: foundry, mode: 'anvil', transport: http(node.rpcUrl),
      cacheTime: 0, pollingInterval: 50 }).extend(publicActions).extend(walletActions);
    const [payer, custody] = node.accounts;
    const deployment = await chain.deployContract({ account: payer, abi, bytecode, args: [amount] });
    const contractReceipt = await chain.waitForTransactionReceipt({ hash: deployment });
    assert.equal(contractReceipt.status, 'success');
    const token = contractReceipt.contractAddress;
    assert.ok(token);
    // The recipient is selected before broadcasting. The signed access list also binds the
    // transfer to this specific member and funding quote without changing ERC-20 calldata.
    const to = custody.address;
    const hash = await chain.writeContract({ type: 'eip1559', account: payer, address: token,
      abi, functionName: 'transfer', args: [to, amount], accessList: [{ address: to, storageKeys: [fundingCommitment(binding)] }] });
    const mined = await chain.waitForTransactionReceipt({ hash });
    assert.equal(mined.logs.length, 1);
    if (binding.requiredConfirmations > 1) await chain.mine({ blocks: binding.requiredConfirmations - 1 });
    const checked = await verifyEvmTransfer({ rpcUrl: node.rpcUrl, chainId: foundry.id, token, from: payer.address,
      to, units: amount, decimals, transactionHash: hash, logIndex: mined.logs[0].logIndex,
      requiredConfirmations: binding.requiredConfirmations });
    const receipt = { transactionHash: checked.transactionHash, blockHash: checked.blockHash,
      blockNumber: checked.blockNumber.toString(), logIndex: checked.logIndex, confirmations: checked.confirmations };
    const rawTransaction = await chain.getRawTransaction({ hash });
    const receiptSignature = await payer.signMessage({ message: receiptMessage(receipt) });
    return await validateLocalDepositProof({ format: 'aqua-local-deposit-v1', chainId: foundry.id, decimals,
      ...binding, token, from: payer.address, to, ...receipt, rawTransaction, receiptSignature }, binding);
  } finally { await node.close(); }
}
