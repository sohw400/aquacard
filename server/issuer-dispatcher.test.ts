import { approveTestCustomer } from './test-customer-access';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Database } from './database';
import { LedgerStore } from './ledger';
import { IssuerOutboxStore } from './issuer-outbox';
import { createSandboxIssuerAdapter } from './issuer-adapter';
import { dispatchIssuerOnce } from './issuer-dispatcher-loop';
import { createTestDatabase } from './test-support';
import { grantApplicationRole, grantCardDispatcherRole, verifyApplicationRole, verifyCardDispatcherRole } from './permissions';
import { verifyMigrations } from './migrations';

async function fixture(t: TestContext, now?: number) {
  const base = await createTestDatabase();
  const suffix = randomBytes(10).toString('hex');
  const apiRole = `issuer_api_${suffix}`, dispatcherRole = `dispatch_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const created: string[] = [];
  const connections: Database[] = [];
  t.after(async () => {
    await Promise.all(connections.map((database) => database.close()));
    try {
      for (const role of created) {
        await base.database.query(`DROP OWNED BY "${role}"`);
        await base.database.query(`DROP ROLE "${role}"`);
      }
    } finally { await base.cleanup(); }
  });
  for (const role of [apiRole, dispatcherRole]) {
    await base.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    created.push(role);
  }
  await grantApplicationRole(base.database, apiRole);
  await grantCardDispatcherRole(base.database, dispatcherRole);
  const url = (role: string) => { const result = new URL(base.connectionString); result.username = role; result.password = password; return result.toString(); };
  const apiDb = new Database({ connectionString: url(apiRole), schema: base.schema });
  const dispatcherDb = new Database({ connectionString: url(dispatcherRole), schema: base.schema });
  connections.push(apiDb, dispatcherDb);
  const ledger = new LedgerStore(base.database);
  for (const userId of ['alice', 'bobby']) {
    await ledger.createUser({ id: userId, email: `${userId}@example.test`, name: '발신 작업자 검증', tag: userId,
      passwordHash: 'test-only-hash', createdAt: 1000 });
    await approveTestCustomer(ledger.database, userId);
  }
  const clock = now === undefined ? undefined : () => now;
  const owner = new IssuerOutboxStore(base.database, { now: clock });
  const first = await owner.register({ userId: 'alice', providerCardId: 'sandbox-card-alice', initialStatus: 'active' });
  const second = await owner.register({ userId: 'bobby', providerCardId: 'sandbox-card-bobby', initialStatus: 'active' });
  return { ...base, apiRole, dispatcherRole, apiDb, dispatcherDb, owner, ledger,
    api: new IssuerOutboxStore(apiDb, { now: clock }), dispatcher: new IssuerOutboxStore(dispatcherDb),
    cardId: first.cardId, secondCardId: second.cardId, apiUrl: url(apiRole), dispatcherUrl: url(dispatcherRole) };
}

interface ProviderResult { requestKey: string; cardRef: string; status: 'succeeded'; cardStatus: 'active' | 'locked' }

/** The fixture persists provider results across client worker processes, not across provider restarts. */
async function provider(t: TestContext, behavior: 'respond' | 'lose_first' | 'hold_first' = 'respond') {
  const key = randomBytes(32);
  const operations = new Map<string, ProviderResult>();
  const commands = new Map<string, string>();
  const calls: { method: string; path: string; requestKey: string }[] = [];
  const errors: unknown[] = [];
  let firstPost = true;
  const reply = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const method = request.method ?? '', path = request.url ?? '';
    const timestamp = request.headers['x-aqua-timestamp'];
    assert.equal(request.headers['x-aqua-key-id'], 'local');
    assert.equal(typeof timestamp, 'string');
    const signature = createHmac('sha256', key).update(`sandbox.issuer.v1.local.${timestamp}.${method}.${path}.`).update(body).digest('hex');
    assert.equal(request.headers['x-aqua-signature'], `v1=${signature}`);
    if (method === 'POST') {
      const command = JSON.parse(body.toString('utf8')) as { requestKey: string; cardRef: string; targetStatus: 'active' | 'locked'; expiresAt: number };
      assert.equal(path, `/cards/${command.cardRef}/status`);
      assert.equal(request.headers['idempotency-key'], command.requestKey);
      const result: ProviderResult = { requestKey: command.requestKey, cardRef: command.cardRef, status: 'succeeded', cardStatus: command.targetStatus };
      const existing = operations.get(command.requestKey);
      if (existing) { assert.deepEqual(result, existing); assert.equal(commands.get(command.requestKey), body.toString('utf8')); }
      else {
        assert.equal(Number.isSafeInteger(command.expiresAt), true);
        if (command.expiresAt <= Date.now()) {
          reply(response, 422, { requestKey: command.requestKey, cardRef: command.cardRef, status: 'rejected', code: 'COMMAND_REJECTED' });
          return;
        }
      }
      operations.set(command.requestKey, result);
      commands.set(command.requestKey, body.toString('utf8'));
      calls.push({ method, path, requestKey: command.requestKey });
      if (firstPost) {
        firstPost = false;
        if (behavior === 'lose_first') { response.destroy(); return; }
        if (behavior === 'hold_first') return;
      }
      reply(response, 200, result);
    } else {
      assert.equal(method, 'GET'); assert.equal(body.length, 0);
      const requestKey = path.slice('/operations/'.length);
      assert.equal(path, `/operations/${requestKey}`);
      calls.push({ method, path, requestKey });
      const result = operations.get(requestKey);
      reply(response, result ? 200 : 404, result ?? { requestKey, status: 'not_found', authoritative: true });
    }
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => { errors.push(error); reply(response, 500, { error: 'test fixture rejected a request' }); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, key, calls, operations, errors, adapter: (now?: () => number) => createSandboxIssuerAdapter({
    baseUrl, keyId: 'local', signingKey: key.toString('base64url'), now,
  }) };
}

function child(t: TestContext, env: NodeJS.ProcessEnv, args = ['--once'], entry = 'server/issuer-dispatcher.ts') {
  const processChild = spawn(process.execPath, ['--import', 'tsx', entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  processChild.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  processChild.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    processChild.once('error', reject);
    processChild.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const timer = setTimeout(() => processChild.kill('SIGKILL'), 15_000); timer.unref();
  void finished.then(() => clearTimeout(timer), () => clearTimeout(timer));
  t.after(async () => {
    if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGKILL');
    await finished;
  });
  return { process: processChild, finished, output: () => stdout + stderr };
}

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(20);
  }
}

function environment(f: Awaited<ReturnType<typeof fixture>>, p: Awaited<ReturnType<typeof provider>>): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: 'development', DISPATCHER_DATABASE_URL: f.dispatcherUrl, DATABASE_SCHEMA: f.schema,
    AQUA_ISSUER_SANDBOX_URL: p.baseUrl, AQUA_ISSUER_KEY_ID: 'local', AQUA_ISSUER_SIGNING_KEY: p.key.toString('base64url'), AQUA_ISSUER_POLL_MS: '250' };
}

test('API and dispatcher logins enforce separate producer, consumer and operator privileges', async (t) => {
  const f = await fixture(t);
  await verifyApplicationRole(f.apiDb); await verifyCardDispatcherRole(f.dispatcherDb); await verifyMigrations(f.dispatcherDb);
  await assert.rejects(verifyCardDispatcherRole(f.apiDb), /separate restricted dispatcher/);
  await assert.rejects(verifyCardDispatcherRole(f.database), /separate restricted dispatcher/);
  await f.database.query(`GRANT "${f.apiRole}" TO "${f.dispatcherRole}" WITH INHERIT FALSE, SET TRUE`);
  await assert.rejects(verifyCardDispatcherRole(f.dispatcherDb), /separate restricted dispatcher/);
  await f.database.query(`REVOKE "${f.apiRole}" FROM "${f.dispatcherRole}"`);
  await verifyCardDispatcherRole(f.dispatcherDb);
  await f.database.query(`GRANT "${f.dispatcherRole}" TO "${f.apiRole}" WITH INHERIT FALSE, SET TRUE`);
  await assert.rejects(verifyApplicationRole(f.apiDb), /restricted application/);
  await f.database.query(`REVOKE "${f.dispatcherRole}" FROM "${f.apiRole}"`);
  await verifyApplicationRole(f.apiDb);
  await f.database.query(`GRANT "${f.apiRole}" TO "${f.dispatcherRole}" WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
  assert.equal((await f.dispatcherDb.query<{ can_set: boolean }>('SELECT pg_has_role(current_user,$1,\'SET\') AS can_set', [f.apiRole])).rows[0].can_set, false);
  await assert.rejects(verifyCardDispatcherRole(f.dispatcherDb), /separate restricted dispatcher/);
  await f.database.query(`REVOKE "${f.apiRole}" FROM "${f.dispatcherRole}"`);
  await verifyCardDispatcherRole(f.dispatcherDb);
  await f.database.query(`GRANT "${f.dispatcherRole}" TO "${f.apiRole}" WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
  assert.equal((await f.apiDb.query<{ can_set: boolean }>('SELECT pg_has_role(current_user,$1,\'SET\') AS can_set', [f.dispatcherRole])).rows[0].can_set, false);
  await assert.rejects(verifyApplicationRole(f.apiDb), /restricted application/);
  await f.database.query(`REVOKE "${f.dispatcherRole}" FROM "${f.apiRole}"`);
  await verifyApplicationRole(f.apiDb);
  const receipt = await f.api.requestStatus({ userId: 'alice', cardId: f.cardId, targetStatus: 'locked', expectedVersion: 1, idempotencyKey: 'role-command-001' });
  const before = await f.api.snapshot('alice');
  assert.equal(before.card?.desiredStatus, 'locked'); assert.equal(before.card?.confirmedStatus, 'active');
  assert.doesNotMatch(JSON.stringify(before), /providerCardId|requestKey|leaseToken|sandbox-card/);
  for (const database of [f.apiDb, f.dispatcherDb]) {
    for (const table of ['issuer_cards', 'issuer_outbox', 'issuer_outbox_audit', 'issuer_outbox_completions', 'issuer_outbox_requeues']) {
      await assert.rejects(database.query(`SELECT * FROM ${table}`), /permission denied/);
      await assert.rejects(database.query(`INSERT INTO ${table} DEFAULT VALUES`), /permission denied/);
      await assert.rejects(database.query(`DELETE FROM ${table}`), /permission denied/);
      await assert.rejects(database.query(`TRUNCATE ${table}`), /permission denied/);
    }
    for (const fn of ['register_sandbox_issuer_card', 'operator_retry_issuer_outbox']) {
      await assert.rejects(database.query(`SELECT ${fn}('{}'::jsonb,1000::bigint)`), /permission denied/);
    }
  }
  await assert.rejects(f.apiDb.query('SELECT claim_issuer_outbox(1000::bigint)'), /permission denied/);
  await assert.rejects(f.apiDb.query("SELECT finish_issuer_outbox('{}'::jsonb,1000::bigint)"), /permission denied/);
  await assert.rejects(f.dispatcherDb.query('SELECT * FROM users'), /permission denied/);
  await assert.rejects(f.dispatcherDb.query("SELECT request_issuer_card_status('{}'::jsonb,1000::bigint)"), /permission denied/);
  await assert.rejects(f.dispatcherDb.query("SELECT apply_sandbox_card_event('{}'::jsonb,1000::bigint)"), /permission denied/);
  await assert.rejects(f.dispatcherDb.query("SELECT issuer_card_snapshot('alice')"), /permission denied/);
  const claim = await f.dispatcher.claim(); assert.ok(claim); assert.equal(claim.id, receipt.id);
  await f.dispatcher.finish({ id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version, outcome: { kind: 'succeeded' } });
  assert.equal((await f.api.snapshot('alice')).card?.confirmedStatus, 'locked');
  await f.database.query(`GRANT EXECUTE ON FUNCTION request_issuer_card_status(jsonb,bigint) TO "${f.dispatcherRole}"`);
  await assert.rejects(verifyCardDispatcherRole(f.dispatcherDb), /separate restricted dispatcher/);
  await f.database.query(`REVOKE EXECUTE ON FUNCTION request_issuer_card_status(jsonb,bigint) FROM "${f.dispatcherRole}"`);
  await f.database.query(`GRANT SELECT(id) ON issuer_cards TO "${f.dispatcherRole}"`);
  await assert.rejects(verifyCardDispatcherRole(f.dispatcherDb), /separate restricted dispatcher/);
  await f.database.query(`REVOKE SELECT(id) ON issuer_cards FROM "${f.dispatcherRole}"`);
  await f.database.query(`GRANT SELECT ON issuer_outbox TO "${f.apiRole}"`);
  await assert.rejects(verifyApplicationRole(f.apiDb), /without direct issuer table access/);
});

test('a restarted dispatcher resolves a lost provider reply by lookup and shuts down cleanly while idle', { timeout: 25_000 }, async (t) => {
  const f = await fixture(t); const p = await provider(t, 'lose_first');
  const receipt = await f.api.requestStatus({ userId: 'alice', cardId: f.cardId, targetStatus: 'locked', expectedVersion: 1, idempotencyKey: 'lost-response-001' });
  const env = environment(f, p);
  const first = await child(t, env).finished;
  assert.equal(first.code, 0, first.stderr); assert.equal(first.signal, null);
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0].method, 'POST');
  let state = await f.api.snapshot('alice');
  assert.equal(state.card?.confirmedStatus, 'active'); assert.equal(state.card?.command?.status, 'retry');
  const row = (await f.database.query<{ next_attempt_at: string }>('SELECT next_attempt_at FROM issuer_outbox WHERE id=$1', [receipt.id])).rows[0];
  await delay(Math.max(0, Number(row.next_attempt_at) - Date.now()) + 30);
  const second = await child(t, env).finished;
  assert.equal(second.code, 0, second.stderr); assert.equal(second.signal, null);
  state = await f.api.snapshot('alice');
  assert.equal(state.card?.confirmedStatus, 'locked'); assert.equal(state.card?.command?.status, 'succeeded');
  assert.deepEqual(p.calls.map((call) => call.method), ['POST', 'GET']);
  assert.equal(p.calls[0].requestKey, p.calls[1].requestKey); assert.equal(p.operations.size, 1);
  const idle = child(t, env, []);
  await until(() => idle.output().includes('issuer_outbox_health'), 'The idle dispatcher did not publish health.');
  idle.process.kill('SIGTERM');
  const stopped = await idle.finished;
  assert.equal(stopped.code, 0, stopped.stderr); assert.equal(stopped.signal, null);
  const logs = first.stdout + first.stderr + second.stdout + second.stderr + stopped.stdout + stopped.stderr;
  for (const secret of [f.dispatcherUrl, p.key.toString('base64url'), p.calls[0].requestKey, 'sandbox-card-alice']) assert.equal(logs.includes(secret), false);
  assert.doesNotMatch(logs, /leaseToken|canonical_input|postgres(?:ql)?:\/\//);
  assert.deepEqual(p.errors, []);
});

test('a worker crash after external acceptance leaves no open DB transaction and resumes by fenced lookup', { timeout: 25_000 }, async (t) => {
  const f = await fixture(t); const p = await provider(t, 'hold_first');
  const receipt = await f.api.requestStatus({ userId: 'alice', cardId: f.cardId, targetStatus: 'locked', expectedVersion: 1, idempotencyKey: 'crashed-worker-001' });
  const active = child(t, environment(f, p));
  await until(() => p.operations.size === 1, 'The provider did not accept the first command.');
  // The HTTP response is still pending. Both rows must be unlocked already.
  await f.database.transaction(async (client) => {
    await client.query('SELECT id FROM issuer_outbox WHERE id=$1 FOR UPDATE NOWAIT', [receipt.id]);
    await client.query('SELECT id FROM issuer_cards WHERE id=$1 FOR UPDATE NOWAIT', [f.cardId]);
  });
  const other = await f.api.requestStatus({ userId: 'bobby', cardId: f.secondCardId, targetStatus: 'locked', expectedVersion: 1, idempotencyKey: 'other-worker-001' });
  assert.ok(other.id);
  assert.equal((await f.api.snapshot('alice')).card?.confirmedStatus, 'active');
  active.process.kill('SIGKILL');
  const killed = await active.finished; assert.equal(killed.signal, 'SIGKILL');
  const claimed = (await f.database.query<{ lease_until: string; lease_token: string; version: string }>('SELECT lease_until,lease_token,version FROM issuer_outbox WHERE id=$1', [receipt.id])).rows[0];
  const resumedAt = Number(claimed.lease_until) + 1;
  const restarted = new IssuerOutboxStore(f.dispatcherDb, { now: () => resumedAt });
  // Another card may be picked first. Both operations must finish without another POST for Alice.
  for (let index = 0; index < 2; index++) await dispatchIssuerOnce(restarted, p.adapter(() => resumedAt));
  const state = await f.api.snapshot('alice');
  assert.equal(state.card?.confirmedStatus, 'locked'); assert.equal(state.card?.command?.status, 'succeeded');
  const aliceKey = p.calls[0].requestKey;
  assert.deepEqual(p.calls.filter((call) => call.requestKey === aliceKey).map((call) => call.method), ['POST', 'GET']);
  await assert.rejects(restarted.finish({ id: receipt.id, leaseToken: claimed.lease_token, expectedVersion: Number(claimed.version), outcome: { kind: 'succeeded' } }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_LEASE_LOST');
  assert.deepEqual(p.errors, []);
});

test('the sandbox dispatcher executable refuses production before attempting network or database access', async (t) => {
  const result = await child(t, { ...process.env, NODE_ENV: 'production', DISPATCHER_DATABASE_URL: 'postgresql://private:private@127.0.0.1:1/private',
    AQUA_ISSUER_SANDBOX_URL: 'http://127.0.0.1:1', AQUA_ISSUER_KEY_ID: 'local', AQUA_ISSUER_SIGNING_KEY: randomBytes(32).toString('base64url') }).finished;
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /DISPATCHER_UNAVAILABLE/);
  assert.doesNotMatch(result.stderr, /private:private|ECONNREFUSED|postgres(?:ql)?:\/\//);
});

test('once reports review work and exits two when an expired unsent command cannot be dispatched', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, Date.now() - 86_400_000 - 1000); const p = await provider(t);
  await f.api.requestStatus({ userId: 'alice', cardId: f.cardId, targetStatus: 'locked', expectedVersion: 1, idempotencyKey: 'expired-dispatch-001' });
  const result = await child(t, environment(f, p)).finished;
  assert.equal(result.code, 2, result.stderr); assert.equal(result.signal, null);
  const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines[0].event, 'issuer_dispatch_once'); assert.equal(lines[0].result, null);
  const health = lines.find((line) => line.event === 'issuer_outbox_health');
  assert.equal(health?.needsReview, '1');
  const state = await f.api.snapshot('alice');
  assert.equal(state.card?.confirmedStatus, 'active'); assert.equal(state.card?.desiredStatus, 'locked');
  assert.equal(state.card?.command?.status, 'needs_review');
  assert.equal(state.card?.command?.errorCode, 'IDEMPOTENCY_WINDOW_EXPIRED');
  assert.equal(p.calls.length, 0); assert.deepEqual(p.errors, []);
});

test('operator CLI registers, submits through the API role and inspects safe audit history', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.ledger.createUser({ id: 'carol', email: 'carol@example.test', name: '운영자 명령 검증', tag: 'carol', passwordHash: 'test-only-hash', createdAt: 1000 });
  await approveTestCustomer(f.ledger.database, 'carol');
  const env = { ...process.env, NODE_ENV: 'development', DATABASE_SCHEMA: f.schema, MIGRATION_DATABASE_URL: f.connectionString, DATABASE_URL: f.apiUrl };
  const run = (args: string[], settings: NodeJS.ProcessEnv = env) => child(t, settings, args, 'server/issuer-operator.ts').finished;
  const registered = await run(['register', 'carol', 'sandbox-card-carol', 'active']);
  assert.equal(registered.code, 0, registered.stderr);
  const { cardId } = JSON.parse(registered.stdout) as { cardId: string };
  assert.equal((await f.api.snapshot('carol')).card?.id, cardId);
  const requested = await run(['request', 'carol', cardId, 'locked', '1', 'operator-request-001']);
  assert.equal(requested.code, 0, requested.stderr);
  const receipt = JSON.parse(requested.stdout) as { id: string; status: string };
  assert.equal(receipt.status, 'pending');
  const inspection = await run(['inspect', receipt.id]);
  assert.equal(inspection.code, 0, inspection.stderr);
  const pending = JSON.parse(inspection.stdout) as {
    record: { id: string; status: string; version: string }; history: { kind: string; status: string }[]; recoveries: unknown[]; historyLimit: number;
  };
  assert.equal(pending.record.id, receipt.id); assert.equal(pending.record.status, 'pending'); assert.equal(pending.record.version, '0');
  assert.deepEqual(pending.history.map((row) => row.kind), ['requested']);
  assert.deepEqual(pending.recoveries, []); assert.equal(pending.historyLimit, 100);
  const claim = await f.owner.claim(); assert.ok(claim); assert.equal(claim.id, receipt.id);
  await f.owner.finish({ id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version, outcome: { kind: 'succeeded' } });
  const finished = await run(['inspect', receipt.id]);
  assert.equal(finished.code, 0, finished.stderr);
  const completed = JSON.parse(finished.stdout) as typeof pending;
  assert.equal(completed.record.status, 'succeeded'); assert.equal(completed.history[0].status, 'succeeded');
  assert.equal(completed.history.length, 3); assert.equal(completed.historyLimit, 100);
  const output = inspection.stdout + finished.stdout;
  assert.doesNotMatch(output, /request_key|lease_token|canonical_input|provider_card_id|idempotency_key/);
  for (const secret of [claim.requestKey, claim.leaseToken, 'sandbox-card-carol', 'operator-request-001', f.apiUrl, f.connectionString]) {
    assert.equal(output.includes(secret), false);
  }
  const missingOwner = await run(['inspect', receipt.id], { ...env, MIGRATION_DATABASE_URL: undefined });
  assert.equal(missingOwner.code, 1); assert.equal(missingOwner.stdout, '');
  assert.match(missingOwner.stderr, /Set MIGRATION_DATABASE_URL/);
  const blocked = await run(['request', 'carol', cardId, 'active', '3', 'production-request-001'], {
    ...env, NODE_ENV: 'production', MIGRATION_DATABASE_URL: undefined, DATABASE_URL: 'postgresql://private:private@127.0.0.1:1/private',
  });
  assert.equal(blocked.code, 1); assert.equal(blocked.stdout, '');
  assert.match(blocked.stderr, /disabled in production/); assert.doesNotMatch(blocked.stderr, /private:private|ECONNREFUSED/);
});
