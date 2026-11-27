import type { ActivityKind, ActivityPage } from '../shared/account-activity';
import { LedgerError } from './errors';

export function activityBoundary(cursor: string | undefined, owner: string, kind: ActivityKind) {
  if (cursor === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,1500}$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const row = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(row) || row.length !== 4 || row[0] !== owner || row[1] !== kind
        || !Number.isSafeInteger(row[2]) || row[2] < 0 || typeof row[3] !== 'string' || !row[3] || row[3].length > 128) throw new Error();
    return { createdAt: row[2] as number, id: row[3] as string };
  } catch {
    throw new LedgerError(400, 'INVALID_CURSOR', '내역을 처음부터 다시 불러와 주세요.');
  }
}

export const activityPageSize = 25;

export function activityPage<T extends { id: string; createdAt: number }>(owner: string, kind: ActivityKind, rows: T[]): ActivityPage<T> {
  if (rows.length <= activityPageSize) return { items: rows, nextCursor: null };
  const items = rows.slice(0, activityPageSize);
  const last = items[items.length - 1];
  return { items, nextCursor: Buffer.from(JSON.stringify([owner, kind, last.createdAt, last.id])).toString('base64url') };
}
