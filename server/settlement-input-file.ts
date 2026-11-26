import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const maxBytes = 4 * 1024 * 1024;

export class SettlementInputError extends Error {
  constructor(readonly code: 'STATEMENT_FILE_UNAVAILABLE' | 'INVALID_STATEMENT_FORMAT') {
    super(code);
    this.name = 'SettlementInputError';
  }
}

async function readStatementBytes(path: string): Promise<Buffer> {
  // Open nonblocking before fstat so a FIFO without a writer cannot stall the command.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) throw new Error('Invalid file.');
    const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (BigInt(offset) !== before.size || before.size !== after.size || before.ctimeNs !== after.ctimeNs) {
      throw new Error('File changed during read.');
    }
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

function hasRepeatedMember(source: string, decoded: unknown): boolean {
  // In valid JSON each unquoted colon introduces an object member. Parsing
  // collapses repeated names, including ones spelled using Unicode escapes.
  let members = 0;
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '"') inString = !inString;
    else if (inString && source[i] === '\\') i++;
    else if (!inString && source[i] === ':') members++;
  }
  const stack: unknown[] = [decoded];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    const children: unknown[] = Object.values(node);
    if (!Array.isArray(node)) members -= children.length;
    for (const child of children) {
      if (child !== null && typeof child === 'object') stack.push(child);
    }
  }
  return members !== 0;
}

export async function readSettlementInput<T>(
  path: string, parse: (value: unknown) => T,
): Promise<{ value: T; sha256: string }> {
  let bytes: Buffer;
  try { bytes = await readStatementBytes(path); }
  catch { throw new SettlementInputError('STATEMENT_FILE_UNAVAILABLE'); }
  let source: string;
  let decoded: unknown;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    decoded = JSON.parse(source);
  } catch { throw new SettlementInputError('INVALID_STATEMENT_FORMAT'); }

  const value = parse(decoded);
  if (hasRepeatedMember(source, decoded)) throw new SettlementInputError('INVALID_STATEMENT_FORMAT');
  return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
}
