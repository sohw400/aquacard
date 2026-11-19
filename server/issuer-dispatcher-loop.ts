import { setTimeout as delay } from 'node:timers/promises';
import type { IssuerOutboxStore, IssuerOutboxFinishResult } from './issuer-outbox';
import { IssuerLeaseExpiredError, type IssuerAdapter } from './issuer-adapter';
import { LedgerError } from './errors';

type DispatchStore = Pick<IssuerOutboxStore, 'claim' | 'finish' | 'stats'>;
export type IssuerDispatchResult = IssuerOutboxFinishResult | { id: string; status: 'lease_lost' | 'deferred'; errorCode: string } | null;

/** The claim transaction has committed before execute performs any external I/O. */
export async function dispatchIssuerOnce(outbox: DispatchStore, adapter: IssuerAdapter, signal?: AbortSignal): Promise<IssuerDispatchResult> {
  if (signal?.aborted) return null;
  const claim = await outbox.claim();
  if (!claim) return null;
  // A claimed but unsent request is recovered through lookup after the lease expires.
  if (signal?.aborted) return { id: claim.id, status: 'deferred', errorCode: 'DISPATCHER_STOPPING' };
  try {
    const outcome = await adapter.execute(claim);
    return await outbox.finish({ id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version, outcome });
  } catch (error) {
    if (error instanceof IssuerLeaseExpiredError || (error instanceof LedgerError && error.code === 'OUTBOX_LEASE_LOST')) {
      return { id: claim.id, status: 'lease_lost', errorCode: 'OUTBOX_LEASE_LOST' };
    }
    // An ambiguous COMMIT or unanticipated adapter failure is recovered by the existing lease.
    throw error;
  }
}

export async function runIssuerDispatcher(outbox: DispatchStore, adapter: IssuerAdapter, options: {
  signal: AbortSignal; pollMs: number; report: (event: Record<string, unknown>) => void;
}): Promise<void> {
  const { signal, pollMs, report } = options;
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error('Dispatcher poll interval must be between 250 and 60000 ms.');
  let failures = 0; let nextHealth = 0;
  while (!signal.aborted) {
    let waitMs = pollMs; let processed = false;
    try {
      const result = await dispatchIssuerOnce(outbox, adapter, signal);
      failures = 0;
      if (result) report({ event: 'issuer_command_processed', ...result });
      processed = result !== null;
    } catch {
      failures++;
      waitMs = Math.min(30_000, pollMs * 2 ** Math.min(failures, 5));
      report({ event: 'issuer_dispatcher_unavailable', retryInMs: waitMs });
    }
    if (!signal.aborted && Date.now() >= nextHealth) {
      nextHealth = Date.now() + 60_000;
      try { report({ event: 'issuer_outbox_health', ...await outbox.stats() }); }
      catch { report({ event: 'issuer_outbox_health_unavailable' }); }
    }
    if (processed && !signal.aborted) continue;
    try { await delay(waitMs, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
