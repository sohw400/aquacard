import { setTimeout as delay } from 'node:timers/promises';
import { AuthMailPayloadError, decryptAuthMail, type AuthMailKeyring, type AuthMailOutbox, type AuthMailResult } from './auth-mail';
import { AuthMailTransportError, type AuthMailTransport } from './auth-mail-transport';
import { workerHeartbeat } from './worker-liveness';

type Outbox = Pick<AuthMailOutbox, 'claim' | 'finish' | 'stats'>;
/** No network operation runs inside a database transaction. Retries preserve the token. */
export async function dispatchAuthMailOnce(outbox: Outbox, transport: AuthMailTransport, schema: string, keyring: AuthMailKeyring,
  signal: AbortSignal, now: () => number = Date.now): Promise<AuthMailResult | null> {
  if (signal.aborted) return null;
  const claim = await outbox.claim();
  if (!claim) return null;
  const completion = { id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version };
  let message;
  try { message = decryptAuthMail(schema, claim, keyring); }
  catch (error) {
    if (error instanceof AuthMailPayloadError && error.reason === 'key_unavailable') {
      return outbox.finish({ ...completion, outcome: 'retry', errorCode: 'KEY_UNAVAILABLE' });
    }
    return outbox.finish({ ...completion, outcome: 'failed', errorCode: 'PAYLOAD_UNAVAILABLE' });
  }
  if (signal.aborted || claim.expiresAt <= now() || claim.leaseUntil <= now()) {
    // A lease that has already expired belongs to the recovery path. Do not send.
    if (claim.leaseUntil <= now()) return null;
    return outbox.finish({ ...completion, outcome: 'retry', errorCode: 'DELIVERY_UNAVAILABLE' });
  }
  try {
    const timeout = AbortSignal.timeout(Math.min(10_000, Math.max(1, claim.leaseUntil - now() - 1000)));
    const combined = AbortSignal.any([signal, timeout]);
    // The extra race also bounds test/custom transports that ignore AbortSignal.
    let onAbort: () => void = () => {};
    const abort = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AuthMailTransportError(false));
      combined.addEventListener('abort', onAbort, { once: true });
      if (combined.aborted) onAbort();
    });
    try { await Promise.race([transport.send(claim.id, message, combined), abort]); }
    finally { combined.removeEventListener('abort', onAbort); }
  } catch (error) {
    const permanent = error instanceof AuthMailTransportError && error.permanent;
    return outbox.finish({ ...completion, outcome: permanent ? 'failed' : 'retry', errorCode: permanent ? 'DELIVERY_REJECTED' : 'DELIVERY_UNAVAILABLE' });
  }
  return outbox.finish({ ...completion, outcome: 'sent', errorCode: null });
}
export async function runAuthMailWorker(outbox: Outbox, transport: AuthMailTransport, schema: string, keyring: AuthMailKeyring,
  options: { signal: AbortSignal; pollMs: number; report: (event: Record<string, unknown>) => void }): Promise<void> {
  const { signal, pollMs, report } = options;
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error('Invalid auth mail polling interval.');
  const heartbeat = workerHeartbeat('AuthMailWorkerHeartbeat', process.env.AQUA_MONITOR_ENVIRONMENT, report);
  let failures = 0, nextHealth = 0;
  while (!signal.aborted) {
    let processed = false, wait = pollMs;
    try {
      const result = await dispatchAuthMailOnce(outbox, transport, schema, keyring, signal);
      if (!signal.aborted) heartbeat?.();
      failures = 0; processed = result !== null;
      if (result) report({ event: 'auth_mail_processed', ...result });
    } catch {
      failures++; wait = Math.min(30_000, pollMs * 2 ** Math.min(failures, 5));
      report({ event: 'auth_mail_worker_unavailable', retryInMs: wait });
    }
    if (!signal.aborted && Date.now() >= nextHealth) {
      nextHealth = Date.now() + 60_000;
      try { report({ event: 'auth_mail_health', ...await outbox.stats() }); }
      catch { report({ event: 'auth_mail_health_unavailable' }); }
    }
    if (processed && !signal.aborted) continue;
    try { await delay(wait, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; }
  }
}
