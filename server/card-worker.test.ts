import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { Database } from './database';
import { LedgerStore } from './ledger';
import { CardInboxStore } from './card-inbox';
import { createCardIngress } from './card-ingress-http';
import { runCardWorker } from './card-worker-loop';
import { createTestDatabase } from './test-support';
import { grantCardIngressRole, grantCardWorkerRole, verifyCardIngressRole, verifyCardWorkerRole } from './permissions';

async function roles() {
  const f = await createTestDatabase();
  const suffix = randomBytes(10).toString('hex');
  const producerRole = `producer_${suffix}`, workerRole = `worker_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const created: string[] = [];
  const connections: Database[] = [];
  const close = async () => {
    await Promise.all(connections.map((db) => db.close()));
    try {
      for (const role of created) { await f.database.query(`DROP OWNED BY "${role}"`); await f.database.query(`DROP ROLE "${role}"`); }
    } finally { await f.cleanup(); }
  };
  try {
    for (const role of [producerRole, workerRole]) {
      await f.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      created.push(role);
    }
    await grantCardIngressRole(f.database, producerRole);
    await grantCardWorkerRole(f.database, workerRole);
    const url = (role: string) => { const value = new URL(f.connectionString); value.username = role; value.password = password; return value.toString(); };
    const producer = new Database({ connectionString: url(producerRole), schema: f.schema });
    const worker = new Database({ connectionString: url(workerRole), schema: f.schema });
    connections.push(producer, worker);
    const ledger = new LedgerStore(f.database);
    await ledger.createUser({ id: 'alice', email: 'alice@example.test', name: '작업자 테스트', tag: 'alice', passwordHash: 'test-only-hash', createdAt: 1000 });
    await ledger.creditSandbox({ userId: 'alice', amountWon: 10_000, idempotencyKey: 'worker-credit' });
    return { ...f, producerRole, workerRole, producer, worker, ledger, close, workerUrl: url(workerRole) };
  } catch (error) { await close(); throw error; }
}
const authorization = (eventId: string, paymentId: string) => ({ kind: 'authorize' as const, eventId, paymentId, userId: 'alice', amountWon: 3000, merchantName: '작업자 검증 가맹점' });

test('separate receiver and worker logins can only enqueue or consume, with no direct inbox or financial writes', async (t) => {
  const f = await roles(); t.after(f.close);
  await verifyCardIngressRole(f.producer); await verifyCardWorkerRole(f.worker);
  await assert.rejects(verifyCardWorkerRole(f.producer), /separate restricted worker/);
  await assert.rejects(verifyCardWorkerRole(f.database), /separate restricted worker/);
  const producer = new CardInboxStore(f.producer), worker = new CardInboxStore(f.worker);
  const receipt = await producer.enqueue(authorization('role-authorize','role-payment'));
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 10_000);
  await assert.rejects(producer.processNext(), /permission denied/);
  await assert.rejects(worker.enqueue(authorization('forged-worker','forged-worker-payment')), /permission denied/);
  await assert.rejects(f.worker.query("SELECT apply_sandbox_card_event('{}'::jsonb,1000::bigint)"), /permission denied/);
  await assert.rejects(f.worker.query('SELECT * FROM users'), /permission denied/);
  for (const db of [f.producer, f.worker]) {
    await assert.rejects(db.query("SELECT apply_sandbox_card_event('{}'::jsonb,1000::bigint)"), /permission denied/);
    await assert.rejects(db.query('SELECT * FROM users'), /permission denied/);
    for (const table of ['card_event_inbox','card_inbox_attempts','card_inbox_requeues','card_inbox_lanes']) {
      await assert.rejects(db.query(`DELETE FROM ${table}`), /permission denied/);
      await assert.rejects(db.query(`INSERT INTO ${table} DEFAULT VALUES`), /permission denied/);
    }
    await assert.rejects(db.query("SELECT operator_retry_card_inbox('{}'::jsonb,1000::bigint)"), /permission denied/);
  }
  assert.equal((await worker.processNext())?.id, receipt.id);
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 3000);
  assert.equal(await worker.processNext(), null);
  assert.equal((await worker.stats()).applied, '1');
  await f.database.query(`GRANT EXECUTE ON FUNCTION enqueue_sandbox_card_event(jsonb,bigint) TO "${f.workerRole}"`);
  await assert.rejects(verifyCardWorkerRole(f.worker), /separate restricted worker/);
  await f.database.query(`REVOKE EXECUTE ON FUNCTION enqueue_sandbox_card_event(jsonb,bigint) FROM "${f.workerRole}"`);
  await f.database.query(`GRANT EXECUTE ON FUNCTION process_card_inbox(bigint) TO "${f.producerRole}"`);
  await assert.rejects(verifyCardIngressRole(f.producer), /separate restricted ingress/);
  await f.database.query(`REVOKE EXECUTE ON FUNCTION process_card_inbox(bigint) FROM "${f.producerRole}"`);
  await f.database.query(`GRANT SELECT ON users TO "${f.producerRole}"`);
  await assert.rejects(verifyCardIngressRole(f.producer), /separate restricted ingress/);
});

test('worker executable uses its restricted login, processes once across restarts, and shuts down cleanly while idle', { timeout: 20_000 }, async (t) => {
  const f = await roles(); t.after(f.close);
  const key = randomBytes(32);
  const ingress = createCardIngress(new CardInboxStore(f.producer), { keys: { local: key.toString('base64url') }, logger: false });
  t.after(() => ingress.close());
  const address = await ingress.listen({ host: '127.0.0.1', port: 0 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(authorization('cli-authorize','cli-payment'));
  const signature = createHmac('sha256', key).update(`sandbox.cards.v1.local.${timestamp}.`).update(body).digest('hex');
  const received = await fetch(address + '/webhooks/sandbox/cards', { method: 'POST', body, headers: {
    'content-type': 'application/json', 'x-aqua-key-id': 'local', 'x-aqua-timestamp': timestamp, 'x-aqua-signature': `v1=${signature}`,
  } });
  assert.equal(received.status, 202);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 10_000, 'HTTP receipt is not card approval');
  const env = { ...process.env, NODE_ENV: 'development', WORKER_DATABASE_URL: f.workerUrl, DATABASE_SCHEMA: f.schema, AQUA_CARD_WORKER_POLL_MS: '250' };
  for (let run = 0; run < 2; run++) {
    const result = spawnSync(process.execPath, ['--import','tsx','server/card-worker.ts','--once'], { env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout) as { result: { status: string } | null };
    assert.equal(response.result?.status ?? null, run === 0 ? 'applied' : null);
  }
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 7000);
  assert.equal((await f.database.query('SELECT count(*)::text AS n FROM card_inbox_attempts')).rows[0].n, '1');
  const child = spawn(process.execPath, ['--import','tsx','server/card-worker.ts'], { env, stdio: ['ignore','pipe','pipe'] });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '';
  child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
  let stopped = false;
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
    if (!stopped && output.includes('card_inbox_health')) { stopped = true; child.kill('SIGTERM'); }
  });
  const [code, signal] = await exited;
  assert.equal(code, 0, errors); assert.equal(signal, null); assert.equal(stopped, true);
  assert.match(output, /"applied":"1"/);
  assert.doesNotMatch(output + errors, /postgres(?:ql)?:\/\/|password|canonical_input/);
});

test('sandbox enqueue and manual retry refuse production before reading a file or connecting to the database', () => {
  for (const args of [['enqueue','/does-not-exist.json'], ['retry','invalid','0','key','operator reason']]) {
    const result = spawnSync(process.execPath, ['--import','tsx','server/card-inbox-operator.ts',...args], {
      env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /disabled in production/);
    assert.doesNotMatch(result.stderr, /ENOENT|unused:unused|ECONNREFUSED/);
  }
});

test('a failed queue-health scan is not repeated for every successfully processed event', async () => {
  const stop = new AbortController(); let processed = 0; let scans = 0;
  const events: Record<string, unknown>[] = [];
  await runCardWorker({
    async processNext() {
      processed++;
      if (processed === 3) stop.abort();
      return { id: `loop-${processed}`, status: 'applied', attemptCount: 1, cycleAttempts: 1, version: 1, errorCode: null, nextAttemptAt: null };
    },
    async stats() { scans++; throw new Error('private diagnostic that must not be logged'); },
  }, { signal: stop.signal, pollMs: 250, report: (event) => events.push(event) });
  assert.equal(processed, 3); assert.equal(scans, 1);
  assert.equal(events.filter((event) => event.event === 'card_inbox_processed').length, 3);
  assert.equal(events.filter((event) => event.event === 'card_worker_unavailable').length, 0);
  assert.doesNotMatch(JSON.stringify(events), /private diagnostic/);
});
