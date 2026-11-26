import type { Database } from './database';

export interface QueueSignals {
  dueCount: number;
  oldestDueSeconds: number;
  recentFailures: number;
  needsReview: number;
  blockedCount: number;
}

export type QueueHealth = Record<'cardInbox' | 'issuerOutbox' | 'authMail', QueueSignals>;

/** A single read-only statement takes all queue measurements from the same PostgreSQL snapshot. */
export async function readQueueHealth(database: Database, nowMs = Date.now()): Promise<QueueHealth> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8.64e15) throw new Error('Invalid queue monitor time.');
  const { rows } = await database.query<{ snapshot: QueueHealth }>(
    'SELECT read_queue_health($1::bigint) AS snapshot', [nowMs],
  );
  const snapshot = rows[0].snapshot;
  for (const queue of [snapshot.cardInbox, snapshot.issuerOutbox, snapshot.authMail]) {
    for (const value of [queue.dueCount, queue.oldestDueSeconds, queue.recentFailures, queue.needsReview, queue.blockedCount]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid queue monitor measurement.');
    }
  }
  return snapshot;
}
