import { setTimeout as delay } from 'node:timers/promises';
import type { CardInboxStore } from './card-inbox';
import { workerHeartbeat } from './worker-liveness';

export interface CardWorkerOptions {
  signal: AbortSignal;
  pollMs: number;
  report: (event: Record<string, unknown>) => void;
}

/** One awaited DB transaction at a time. Shutdown never abandons an active commit. */
export async function runCardWorker(inbox: Pick<CardInboxStore, 'processNext' | 'stats'>, { signal, pollMs, report }: CardWorkerOptions): Promise<void> {
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error('Worker poll interval must be between 250 and 60000 ms.');
  const heartbeat = workerHeartbeat('CardWorkerHeartbeat', process.env.AQUA_MONITOR_ENVIRONMENT, report);
  let failures = 0;
  let nextHealth = 0;
  while (!signal.aborted) {
    let waitMs = pollMs;
    let processed = false;
    try {
      const result = await inbox.processNext();
      if (!signal.aborted) heartbeat?.();
      failures = 0;
      if (result) report({ event: 'card_inbox_processed', ...result });
      processed = result !== null;
    } catch {
      // A lost COMMIT reply is resolved from durable inbox state on the next pass.
      // SQL errors, connection strings, payloads and HMAC secrets never enter logs.
      failures++;
      waitMs = Math.min(30_000, pollMs * 2 ** Math.min(failures, 5));
      report({ event: 'card_worker_unavailable', retryInMs: waitMs });
    }
    if (!signal.aborted && Date.now() >= nextHealth) {
      // A metrics outage must not trigger an expensive scan after every event
      // or turn a committed payment into a reported processing failure.
      nextHealth = Date.now() + 60_000;
      try { report({ event: 'card_inbox_health', ...await inbox.stats() }); }
      catch { report({ event: 'card_inbox_health_unavailable' }); }
    }
    if (processed && !signal.aborted) continue;
    try { await delay(waitMs, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
