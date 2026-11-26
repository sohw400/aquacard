import { embeddedMetrics, isMonitorEnvironment } from './operations-monitor-metrics';

type HeartbeatMetric = 'CardWorkerHeartbeat' | 'IssuerDispatcherHeartbeat' | 'AuthMailWorkerHeartbeat';

/** Called after a completed poll. No timer can report progress while that poll is stuck. */
export function workerHeartbeat(
  metric: HeartbeatMetric,
  environment: string | undefined,
  report: (event: Record<string, unknown>) => void,
) {
  if (environment === undefined) return;
  if (!isMonitorEnvironment(environment)) throw new Error('Invalid AQUA_MONITOR_ENVIRONMENT.');
  let nextReport = -Infinity;
  return () => {
    const now = performance.now();
    if (now < nextReport) return;
    nextReport = now + 60_000;
    // A log sink failure must not turn a committed transaction into a retry.
    try { report(embeddedMetrics(environment, [{ name: metric, unit: 'Count', value: 1 }])); }
    catch { /* The missing-heartbeat alarm covers an unavailable log sink. */ }
  };
}
