import type { PoolClient } from 'pg';
import type { ReserveSnapshot } from '../shared/api';
import type { Database } from './database';
import { LedgerError } from './errors';
import type { ReserveMovement } from '../shared/account-activity';
import { activityBoundary, activityPage, activityPageSize } from './activity-cursor';
import { throwRewardError } from './reward-errors';

export type ReserveCommand = { kind: 'in' | 'out'; amountWon: number } | { kind: 'preference'; autoUse: boolean; expectedVersion: number };

export async function readReserve(client: PoolClient, userId: string): Promise<ReserveSnapshot> {
  const result = await client.query<{ result: ReserveSnapshot }>('SELECT reserve_snapshot($1) AS result', [userId]);
  if (!result.rows[0].result) throw new LedgerError(500, 'INVALID_LEDGER', '리저브 원장을 확인할 수 없습니다.');
  return result.rows[0].result;
}

export async function applyReserve(database: Database, userId: string, requestKey: string, command: ReserveCommand, now = Date.now()): Promise<ReserveSnapshot> {
  try {
    const { rows } = await database.query<{ result: ReserveSnapshot }>('SELECT apply_reserve_command($1::jsonb,$2::bigint) AS result',
      [JSON.stringify({ ...command, userId, requestKey }), now]);
    return rows[0].result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (reason === 'INVALID_RESERVE_COMMAND') throw new LedgerError(400, reason, '리저브 요청 내용을 확인해 주세요.');
    if (reason === 'INSUFFICIENT_FUNDS') throw new LedgerError(409, reason, '옮길 수 있는 잔액이 부족해요.');
    if (reason === 'EMAIL_VERIFICATION_REQUIRED' || reason === 'CUSTOMER_ACCESS_REQUIRED') {
      throw new LedgerError(403, reason, '이메일 확인과 거래 승인을 마친 뒤 이용해 주세요.');
    }
    return throwRewardError(error);
  }
}

export async function reserveActivity(database: Database, userId: string, cursor?: string) {
  const before = activityBoundary(cursor, userId, 'reserve');
  const result = await database.query<{ record: ReserveMovement }>(
    'SELECT record FROM member_reserve_activity($1::text,$2::bigint,$3::text,$4::integer) AS record',
    [userId, before?.createdAt ?? null, before?.id ?? null, activityPageSize + 1]);
  return activityPage(userId, 'reserve', result.rows.map(row => row.record));
}
