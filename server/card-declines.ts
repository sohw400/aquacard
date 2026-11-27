import type { CardDeclinePage, CardDeclineRecord } from '../shared/account-activity';
import { activityBoundary, activityPage, activityPageSize } from './activity-cursor';
import type { Database } from './database';
import { LedgerError } from './errors';

export async function memberCardDeclines(database: Pick<Database, 'query'>, userId: string, cursor?: string): Promise<CardDeclinePage> {
  const boundary = activityBoundary(cursor, userId, 'declines');
  if (boundary && (!/^[0-9a-f]{64}$/.test(boundary.id) || boundary.createdAt > 8.64e15)) {
    throw new LedgerError(400, 'INVALID_CURSOR', '내역을 처음부터 다시 불러와 주세요.');
  }
  const { rows } = await database.query<{ id: string; created_at: string; reason: CardDeclineRecord['reason'] }>(
    'SELECT * FROM member_card_declines($1::text,$2::bigint,$3::text,$4::integer)',
    [userId,boundary?.createdAt ?? null,boundary?.id ?? null,activityPageSize + 1]);
  return activityPage(userId, 'declines', rows.map(row => ({ id: row.id, createdAt: Number(row.created_at), reason: row.reason })));
}
