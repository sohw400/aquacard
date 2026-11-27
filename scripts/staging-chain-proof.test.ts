import assert from 'node:assert/strict';
import test from 'node:test';
import { issueLocalDepositProof, validateLocalDepositProof } from './staging-chain-proof';

test('the archived local deposit retains its signed funding intent, token transfer and observed receipt', async () => {
  const intentId = 'd48d282d-11a3-4c48-9d55-b83abc27d7e0';
  const binding = { memberId: 'staging-member', intentId, destination: 'aqua-test:ethereum:' + intentId,
    units: '1000.123456', requiredConfirmations: 12 };
  const issued = await issueLocalDepositProof(binding);
  const proof = JSON.parse(JSON.stringify(issued));
  assert.equal(proof.confirmations, 12);
  assert.deepEqual(await validateLocalDepositProof(proof, binding), issued);

  // Even if the readable fields of the proof and its expected binding are both rewritten,
  // reassigning the same signed transfer to another member or quote must fail.
  const other = { ...binding, memberId: 'other-member' };
  await assert.rejects(validateLocalDepositProof({ ...proof, ...other }, other), /another deposit/);
  const nextId = '949eaf12-fa4c-48d6-934c-a7fd65681a05';
  const next = { ...binding, intentId: nextId, destination: 'aqua-test:ethereum:' + nextId };
  await assert.rejects(validateLocalDepositProof({ ...proof, ...next }, next), /another deposit/);

  for (const fields of [
    { blockNumber: '3' }, { blockHash: '0x' + '1'.repeat(64) }, { confirmations: 13 }, { logIndex: 1 },
    { transactionHash: '0x' + '2'.repeat(64) }, { from: proof.to, to: proof.from },
    { receiptSignature: '0x' + '0'.repeat(130) }, { chainId: 1 },
  ]) {
    await assert.rejects(validateLocalDepositProof({ ...proof, ...fields }, binding));
  }
  const short = { ...binding, units: '1000.123455' };
  await assert.rejects(validateLocalDepositProof({ ...proof, ...short }, short));
  const imprecise = { ...binding, units: '1000.1234567' };
  await assert.rejects(validateLocalDepositProof({ ...proof, ...imprecise }, imprecise));
  await assert.rejects(issueLocalDepositProof({ ...binding, units: '0.000000' }));
});
