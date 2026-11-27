import type { PoolClient } from 'pg';
import type { Database } from './database';
import { activityBoundary, activityPage, activityPageSize } from './activity-cursor';
import type { RewardRecord, RewardsSnapshot } from '../shared/api';
import { LedgerError } from './errors';
import { throwRewardError } from './reward-errors';

/** Read inside the caller's snapshot transaction; the SQL function returns at most 50 history rows. */
export async function readRewardsSnapshot(client: PoolClient, userId: string, now: number, summary = false): Promise<RewardsSnapshot> {
  try {
    const { rows } = await client.query<{ result: RewardsSnapshot }>(summary
      ? 'SELECT member_reward_summary($1::text, $2::bigint) AS result'
      : 'SELECT rewards_snapshot($1::text, $2::bigint) AS result', [userId, now]);
    if (!rows[0]?.result) throw new LedgerError(500, 'INVALID_REWARD_LEDGER', '리워드 원장을 확인할 수 없습니다.');
    return rows[0].result;
  } catch (error) { return throwRewardError(error); }
}


export async function rewardActivity(client: Pick<Database, 'query'>, userId: string, cursor?: string) {
  const after = activityBoundary(cursor, userId, 'rewards');
  const result = await client.query<{ record: RewardRecord }>(
    'SELECT record FROM member_reward_activity($1::text,$2::bigint,$3::text,$4::integer) AS record',
    [userId, after?.createdAt ?? null, after?.id ?? null, activityPageSize + 1]);
  return activityPage(userId, 'rewards', result.rows.map(row => row.record));
}
