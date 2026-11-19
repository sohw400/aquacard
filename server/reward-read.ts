import type { PoolClient } from 'pg';
import type { RewardsSnapshot } from '../shared/api';
import { LedgerError } from './errors';
import { throwRewardError } from './reward-errors';

/** Read inside the caller's snapshot transaction; the SQL function returns at most 50 history rows. */
export async function readRewardsSnapshot(client: PoolClient, userId: string, now: number): Promise<RewardsSnapshot> {
  try {
    const { rows } = await client.query<{ result: RewardsSnapshot }>('SELECT rewards_snapshot($1::text, $2::bigint) AS result', [userId, now]);
    if (!rows[0]?.result) throw new LedgerError(500, 'INVALID_REWARD_LEDGER', '리워드 원장을 확인할 수 없습니다.');
    return rows[0].result;
  } catch (error) { return throwRewardError(error); }
}
