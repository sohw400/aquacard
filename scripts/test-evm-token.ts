import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAbi, type Hex } from 'viem';

export const decimals = 6;
export const abi = parseAbi([
  'constructor(uint256 supply)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address recipient, uint256 value) returns (bool)',
]);

export async function compileMockToken(): Promise<Hex> {
  const { default: solc } = await import('solc');
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
