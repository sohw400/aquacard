import type { QueueHealth } from './queue-health';

export const MONITOR_NAMESPACE = 'AquaCard/Operations';
export interface MetricDatum { name: string; value: number; unit: 'Count' | 'Seconds' }

export function isMonitorEnvironment(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value);
}

export function embeddedMetrics(environment: string, metrics: MetricDatum[], timestamp = Date.now()) {
  return {
    _aws: { Timestamp: timestamp, CloudWatchMetrics: [{ Namespace: MONITOR_NAMESPACE,
      Dimensions: [['Environment']], Metrics: metrics.map(({ name, unit }) => ({ Name: name, Unit: unit })) }] },
    Environment: environment,
    ...Object.fromEntries(metrics.map(({ name, value }) => [name, value])),
  };
}

export interface MonitorObservation {
  ledgerFindings?: number;
  budget?: { budgetLow: boolean; unfunded24h: number };
  queues?: QueueHealth;
  failedChecks: ('connection' | 'migrations' | 'role' | 'ledger' | 'budget' | 'queues' | 'shutdown' | 'deadline')[];
}

const queuePrefixes = { cardInbox: 'CardInbox', issuerOutbox: 'IssuerOutbox', authMail: 'AuthMail' } as const;

export function monitorResult(environment: string, observation: MonitorObservation) {
  const { ledgerFindings, queues, budget, failedChecks } = observation;
  const complete = ledgerFindings !== undefined && queues !== undefined && budget !== undefined && failedChecks.length === 0;
  const metrics: MetricDatum[] = [{ name: 'MonitorHealthy', value: Number(complete), unit: 'Count' }];
  let incident = (ledgerFindings ?? 0) > 0;
  if (ledgerFindings !== undefined) metrics.push({ name: 'LedgerFindings', value: ledgerFindings, unit: 'Count' });
  if (budget) metrics.push({ name: 'RewardBudgetLow', value: Number(budget.budgetLow), unit: 'Count' },
    { name: 'UnfundedCashbackAuthorizations24h', value: budget.unfunded24h, unit: 'Count' });
  if (queues) {
    for (const key of ['cardInbox', 'issuerOutbox', 'authMail'] as const) {
      const queue = queues[key];
      const prefix = queuePrefixes[key];
      metrics.push(
        { name: prefix + 'DueCount', value: queue.dueCount, unit: 'Count' },
        { name: prefix + 'OldestDueSeconds', value: queue.oldestDueSeconds, unit: 'Seconds' },
        { name: prefix + 'FailureCount', value: queue.recentFailures, unit: 'Count' },
        { name: prefix + 'ReviewCount', value: queue.needsReview, unit: 'Count' },
      );
      incident ||= queue.recentFailures > 0 || queue.needsReview > 0;
    }
    metrics.push({ name: 'CardInboxBlockedCount', value: queues.cardInbox.blockedCount, unit: 'Count' });
  }
  const exitCode = complete ? (incident ? 1 : 0) : 2;
  return { exitCode, event: { ...embeddedMetrics(environment, metrics), failedChecks } };
}
