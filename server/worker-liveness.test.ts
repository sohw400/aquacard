import assert from 'node:assert/strict';
import test from 'node:test';
import { runAuthMailWorker } from './auth-mail-dispatch';
import { runCardWorker } from './card-worker-loop';
import { runIssuerDispatcher } from './issuer-dispatcher-loop';
import { workerHeartbeat } from './worker-liveness';

test('heartbeats are opt-in, report the first completed poll and limit each process to one per minute', t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const samples: Record<string, unknown>[] = [];
  const report = (sample: Record<string, unknown>) => { samples.push(sample); };
  assert.equal(workerHeartbeat('CardWorkerHeartbeat', undefined, report), undefined);
  assert.throws(() => workerHeartbeat('CardWorkerHeartbeat', 'wrong dimension', report), /AQUA_MONITOR_ENVIRONMENT/);
  const record = workerHeartbeat('CardWorkerHeartbeat', 'stage-kr', report)!;
  record();
  elapsed = 59_999;
  record();
  assert.equal(samples.length, 1);
  elapsed = 60_000;
  record();
  assert.equal(samples.length, 2);
  assert.deepEqual(Object.keys(samples[0]).sort(), ['CardWorkerHeartbeat', 'Environment', '_aws'].sort());
  assert.equal(samples[0].Environment, 'stage-kr');
  assert.equal(samples[0].CardWorkerHeartbeat, 1);
  const aws = samples[0]._aws as { Timestamp: number; CloudWatchMetrics: unknown[] };
  assert.ok(aws.Timestamp > 0);
  assert.deepEqual(aws.CloudWatchMetrics, [{
    Namespace: 'AquaCard/Operations', Dimensions: [['Environment']],
    Metrics: [{ Name: 'CardWorkerHeartbeat', Unit: 'Count' }],
  }]);

  let writes = 0;
  const unavailable = workerHeartbeat('CardWorkerHeartbeat', 'stage-kr', () => { writes++; throw new Error('sink failed'); })!;
  assert.doesNotThrow(unavailable);
  unavailable();
  assert.equal(writes, 1);
});

type Poll = () => Promise<null>;
type Worker = (poll: Poll, options: {
  signal: AbortSignal; pollMs: number; report: (event: Record<string, unknown>) => void;
}) => Promise<void>;

const stats = async () => ({
  pending: '0', inFlight: '0', retry: '0', applied: '0', succeeded: '0', needsReview: '0',
  failed: '0', sent: '0', discarded: '0', deadLetter: '0', due: '0', oldestPendingAt: null,
});
const unexpected = () => { throw new Error('An idle worker cannot dispatch or complete a job.'); };
const workers: Record<string, Worker> = {
  CardWorkerHeartbeat: (poll, options) => runCardWorker({ processNext: poll, stats }, options),
  IssuerDispatcherHeartbeat: (poll, options) => runIssuerDispatcher(
    { claim: poll, finish: unexpected, stats }, { execute: unexpected }, options),
  AuthMailWorkerHeartbeat: (poll, options) => runAuthMailWorker(
    { claim: poll, finish: unexpected, stats }, { send: unexpected }, 'test',
    { activeKeyId: 'test', keys: new Map() }, options),
};

test('only a completed poll can report a worker heartbeat even when a separate health read succeeds', async t => {
  const original = process.env.AQUA_MONITOR_ENVIRONMENT;
  process.env.AQUA_MONITOR_ENVIRONMENT = 'stage-kr';
  t.after(() => {
    if (original === undefined) delete process.env.AQUA_MONITOR_ENVIRONMENT;
    else process.env.AQUA_MONITOR_ENVIRONMENT = original;
  });
  for (const [name, run] of Object.entries(workers)) {
    await t.test(name, async () => {
      for (const success of [true, false]) {
        const stop = new AbortController();
        const samples: Record<string, unknown>[] = [];
        let resolvePoll!: (value: null) => void;
        let rejectPoll!: (error: Error) => void;
        const pendingPoll = new Promise<null>((resolve, reject) => { resolvePoll = resolve; rejectPoll = reject; });
        const running = run(() => pendingPoll, {
          signal: stop.signal, pollMs: 250, report: event => {
            samples.push(event);
            if (typeof event.event === 'string' && event.event.endsWith('_health')) stop.abort();
          },
        });
        assert.equal(samples.length, 0);
        if (success) resolvePoll(null);
        else rejectPoll(new Error('poll unavailable'));
        await running;
        assert.equal(samples.filter(event => event[name] === 1).length, success ? 1 : 0);
        assert.equal(samples.some(event => typeof event.event === 'string' && event.event.endsWith('_health')), true);
      }
    });
  }
});
