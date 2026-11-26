import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runAuthMailWorker } from '../server/auth-mail-dispatch.ts';
import { runCardWorker } from '../server/card-worker-loop.ts';
import { runIssuerDispatcher } from '../server/issuer-dispatcher-loop.ts';
import { monitorResult } from '../server/operations-monitor-metrics.ts';

// cfn-lint decodes short YAML tags (!Ref and !Sub) to their CloudFormation forms.
const template = JSON.parse(execFileSync(process.env.CFN_LINT_PYTHON || 'python3', ['-c', [
  'from cfnlint.decode import decode',
  'import json, sys',
  'template, errors = decode(sys.argv[1])',
  'if errors: raise ValueError(errors)',
  'print(json.dumps(template))',
].join('\n'), 'infra/operations-monitoring.yaml'], { encoding: 'utf8' }));

const environment = 'kr-staging';
process.env.AQUA_MONITOR_ENVIRONMENT = environment;
const queue = { dueCount: 12, oldestDueSeconds: 650, recentFailures: 1, needsReview: 1, blockedCount: 0 };
const queues = {
  cardInbox: { ...queue, blockedCount: 2 },
  issuerOutbox: queue,
  authMail: { ...queue, needsReview: 0 },
};
const scheduled = monitorResult(environment, { ledgerFindings: 1, queues, failedChecks: [] }).event;

async function idleWorkerEvent(run) {
  const stop = new AbortController();
  const timeout = AbortSignal.timeout(2_000);
  const signal = AbortSignal.any([stop.signal, timeout]);
  let heartbeat;
  await run({ signal, pollMs: 250, report(event) {
    if (event._aws) {
      heartbeat = event;
      stop.abort();
    }
  } });
  assert.ok(heartbeat, 'Idle worker finished without emitting a heartbeat');
  return heartbeat;
}
const empty = async () => null;
const stats = async () => ({});
const outbox = { claim: empty, stats };
const workerEvents = {
  WatchCardWorker: await idleWorkerEvent(options => runCardWorker({ processNext: empty, stats }, options)),
  WatchIssuerDispatcher: await idleWorkerEvent(options => runIssuerDispatcher(outbox, {}, options)),
  WatchAuthMailWorker: await idleWorkerEvent(options => runAuthMailWorker(outbox, {}, 'test', {}, options)),
};
const metrics = new Map();
for (const event of [scheduled, ...Object.values(workerEvents)]) {
  assert.equal(event.Environment, environment);
  const [group] = event._aws.CloudWatchMetrics;
  assert.deepEqual(group.Dimensions, [['Environment']]);
  for (const metric of group.Metrics) metrics.set(metric.Name, group.Namespace);
}

const resources = template.Resources;
const alarms = Object.values(resources).filter(resource => resource.Type === 'AWS::CloudWatch::Alarm');
const watched = new Set();
for (const { Properties: alarm } of alarms) {
  assert.deepEqual(alarm.AlarmActions, [{ Ref: 'AlarmTopicArn' }]);
  assert.deepEqual(alarm.OKActions, alarm.AlarmActions);
  const inputs = alarm.Metrics?.filter(query => query.MetricStat).map(query => query.MetricStat.Metric) ?? [alarm];
  for (const { MetricName, Namespace, Dimensions } of inputs) {
    assert.ok(metrics.has(MetricName), 'No producer emitted alarm metric ' + MetricName);
    assert.equal(Namespace, metrics.get(MetricName), MetricName);
    assert.deepEqual(Dimensions, [{ Name: 'Environment', Value: { Ref: 'Environment' } }]);
    watched.add(MetricName);
  }
}
// Depth provides triage context. All nonzero incident metrics in this fixture need a route.
for (const { Name: name } of scheduled._aws.CloudWatchMetrics[0].Metrics) {
  if (scheduled[name] > 0 && !name.endsWith('DueCount')) {
    assert.ok(watched.has(name), 'Missing alarm for ' + name);
  }
}
function verifyAbsenceAlarm(alarm) {
  assert.equal(alarm.Statistic, 'SampleCount');
  assert.equal(alarm.ComparisonOperator, 'LessThanThreshold');
  assert.equal(alarm.Threshold, 1);
  assert.equal(alarm.TreatMissingData, 'breaching');
}
verifyAbsenceAlarm(resources.MissingMonitorAlarm.Properties);
assert.equal(resources.MissingMonitorAlarm.Properties.MetricName, 'MonitorHealthy');
assert.equal(resources.MonitorErrorAlarm.Properties.MetricName, 'MonitorHealthy');
assert.equal(resources.MonitorErrorAlarm.Properties.Statistic, 'Minimum');
assert.equal(resources.MonitorErrorAlarm.Properties.Threshold, 1);
assert.equal(resources.MonitorErrorAlarm.Properties.ComparisonOperator, 'LessThanThreshold');
for (const [condition, event] of Object.entries(workerEvents)) {
  const relevant = alarms.filter(alarm => alarm.Condition === condition);
  assert.equal(relevant.length, 1, condition);
  const [metric] = event._aws.CloudWatchMetrics[0].Metrics;
  assert.equal(relevant[0].Properties.MetricName, metric.Name, condition);
  verifyAbsenceAlarm(relevant[0].Properties);
}
console.log(`Verified ${alarms.length} CloudWatch alarms against monitor and worker output.`);
