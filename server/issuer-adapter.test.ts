import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { createSandboxIssuerAdapter, IssuerAdapterConfigurationError, IssuerLeaseExpiredError } from './issuer-adapter';
import { dispatchIssuerOnce, runIssuerDispatcher } from './issuer-dispatcher-loop';
import { LedgerError } from './errors';
import type { IssuerOutboxClaim, IssuerOutboxFinishResult, IssuerOutboxStore } from './issuer-outbox';

const NOW = Date.UTC(2026, 10, 19, 12);
const KEY = randomBytes(32).toString('base64url');
const CLAIM: IssuerOutboxClaim = {
  id: '1137da6a-56f8-4c87-a521-f7aa903801eb', cardId: '4ab592c3-3256-4301-9cce-879e05a77b92',
  providerCardId: 'sandbox-card-adapter-test', requestKey: 'aqua-d64d3ea3-bf8f-4ff3-b423-66e0399cab14',
  targetStatus: 'locked', phase: 'send', leaseToken: 'b69d667a-7ec3-41c9-89bd-736f726cdcd2',
  version: 2, leaseUntil: NOW + 30_000, expiresAt: NOW + 86_400_000, attemptCount: 1,
};
const successful = (claim = CLAIM) => ({ requestKey: claim.requestKey, cardRef: claim.providerCardId, status: 'succeeded', cardStatus: claim.targetStatus });
const output = (reply: ServerResponse, status: number, body: unknown) => {
  reply.writeHead(status, { 'content-type': 'application/json' }); reply.end(JSON.stringify(body));
};

async function receiver(t: TestContext, handler: (request: IncomingMessage, reply: ServerResponse, body: Buffer) => Promise<void> | void) {
  const failures: unknown[] = [];
  const server = createServer((request, reply) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      await handler(request, reply, Buffer.concat(chunks));
    })().catch((error: unknown) => { failures.push(error); reply.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.deepEqual(failures, []);
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, adapter: (options: { timeoutMs?: number; now?: () => number } = {}) => createSandboxIssuerAdapter({ baseUrl, keyId: 'test-key', signingKey: KEY, now: () => NOW, ...options }) };
}

function verifiedSignature(request: IncomingMessage, body: Buffer) {
  const keyId = request.headers['x-aqua-key-id'];
  const timestamp = request.headers['x-aqua-timestamp'];
  assert.equal(keyId, 'test-key'); assert.equal(timestamp, String(Math.floor(NOW / 1_000)));
  const expected = createHmac('sha256', Buffer.from(KEY, 'base64url'))
    .update(`sandbox.issuer.v1.${keyId}.${timestamp}.${request.method}.${request.url}.`).update(body).digest('hex');
  assert.equal(request.headers['x-aqua-signature'], `v1=${expected}`);
}

test('outbound POST signs exact bytes, path and method and keeps the same provider request key', async (t) => {
  const bodies: string[] = [];
  const provider = await receiver(t, (request, reply, body) => {
    verifiedSignature(request, body);
    assert.equal(request.method, 'POST'); assert.equal(request.url, `/cards/${CLAIM.providerCardId}/status`);
    assert.equal(request.headers['idempotency-key'], CLAIM.requestKey);
    assert.deepEqual(JSON.parse(body.toString()), { requestKey: CLAIM.requestKey, cardRef: CLAIM.providerCardId, targetStatus: CLAIM.targetStatus, expiresAt: CLAIM.expiresAt });
    bodies.push(body.toString()); output(reply, 200, successful());
  });
  const config = { baseUrl: provider.baseUrl, keyId: 'test-key', signingKey: KEY, now: () => NOW };
  const adapter = createSandboxIssuerAdapter(config);
  config.keyId = 'mutated-after-validation';
  assert.deepEqual(await adapter.execute(CLAIM), { kind: 'succeeded' });
  assert.deepEqual(await adapter.execute({ ...CLAIM, attemptCount: 2, version: 4 }), { kind: 'succeeded' });
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
});

test('lookup signs an empty-body GET and verifies the original target card and status', async (t) => {
  let calls = 0;
  const provider = await receiver(t, (request, reply, body) => {
    verifiedSignature(request, body); calls++;
    assert.equal(request.method, 'GET'); assert.equal(request.url, `/operations/${CLAIM.requestKey}`);
    assert.equal(body.length, 0); assert.equal(request.headers['idempotency-key'], undefined);
    output(reply, 200, successful());
  });
  assert.deepEqual(await provider.adapter().execute({ ...CLAIM, phase: 'lookup' }), { kind: 'succeeded' });
  assert.equal(calls, 1);
});

test('only correlated provider rejections are terminal and pending remains uncertain', async (t) => {
  let mode: 'reject' | 'pending' = 'reject';
  const provider = await receiver(t, (request, reply) => {
    if (mode === 'pending') output(reply, 202, { requestKey: CLAIM.requestKey, cardRef: CLAIM.providerCardId, status: 'pending' });
    else output(reply, request.method === 'POST' ? 422 : 200, { requestKey: CLAIM.requestKey, cardRef: CLAIM.providerCardId, status: 'rejected', code: 'CARD_CLOSED' });
  });
  const adapter = provider.adapter();
  assert.deepEqual(await adapter.execute(CLAIM), { kind: 'rejected', code: 'CARD_CLOSED' });
  assert.deepEqual(await adapter.execute({ ...CLAIM, phase: 'lookup' }), { kind: 'rejected', code: 'CARD_CLOSED' });
  mode = 'pending';
  assert.deepEqual(await adapter.execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_PENDING' });
});

test('only authoritative lookup not_found can permit a later resend', async (t) => {
  let body: unknown = { requestKey: CLAIM.requestKey, status: 'not_found', authoritative: true };
  const provider = await receiver(t, (_request, reply) => output(reply, 404, body));
  const adapter = provider.adapter();
  assert.deepEqual(await adapter.execute({ ...CLAIM, phase: 'lookup' }), { kind: 'not_found' });
  assert.deepEqual(await adapter.execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_INVALID_RESPONSE' });
  for (const invalid of [
    { requestKey: CLAIM.requestKey, status: 'not_found' },
    { requestKey: CLAIM.requestKey, status: 'not_found', authoritative: false },
    { requestKey: 'different', status: 'not_found', authoritative: true },
    { requestKey: CLAIM.requestKey, status: 'not_found', authoritative: true, detail: 'extra' },
    { error: 'not found' },
  ]) {
    body = invalid;
    assert.deepEqual(await adapter.execute({ ...CLAIM, phase: 'lookup' }), { kind: 'uncertain', code: 'PROVIDER_INVALID_RESPONSE' });
  }
});

test('uncorrelated success and extra or nested response data never confirm a command', async (t) => {
  let body: unknown = successful();
  const provider = await receiver(t, (_request, reply) => output(reply, 200, body));
  const adapter = provider.adapter();
  for (const invalid of [
    { ...successful(), requestKey: 'other-key' }, { ...successful(), cardRef: 'sandbox-card-other' },
    { ...successful(), cardStatus: 'active' }, { ...successful(), cardStatus: true },
    { ...successful(), pan: 'not-permitted' }, { ...successful(), details: { internal: true } },
    [successful()], null,
  ]) {
    body = invalid;
    assert.deepEqual(await adapter.execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_INVALID_RESPONSE' });
  }
});

test('invalid JSON, duplicate fields, non-UTF8 and encoded responses remain uncertain', async (t) => {
  let bytes = Buffer.from('{'); let type = 'application/json'; let encoding: string | undefined;
  const provider = await receiver(t, (_request, reply) => {
    reply.writeHead(200, { 'content-type': type, ...(encoding ? { 'content-encoding': encoding } : {}) }); reply.end(bytes);
  });
  const adapter = provider.adapter();
  for (const invalid of [
    Buffer.from('{'), Buffer.from([0xff, 0xfe]),
    Buffer.from(JSON.stringify(successful()).replace('"status":"succeeded"', '"status":"failed","status":"succeeded"')),
    Buffer.from(JSON.stringify(successful()).replace('"status":"succeeded"', '"sta\\u0074us":"failed","status":"succeeded"')),
  ]) { bytes = invalid; assert.deepEqual(await adapter.execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_INVALID_RESPONSE' }); }
  bytes = Buffer.from(JSON.stringify(successful())); type = 'text/plain';
  assert.deepEqual(await adapter.execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_INVALID_RESPONSE' });
  type = 'application/json'; encoding = 'identity';
  assert.deepEqual(await adapter.execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_INVALID_RESPONSE' });
});

test('declared and chunked response sizes are bounded before parsing', async (t) => {
  let chunked = false;
  const provider = await receiver(t, (_request, reply) => {
    reply.writeHead(200, { 'content-type': 'application/json', ...(chunked ? {} : { 'content-length': '20000' }) });
    reply.write(' '.repeat(5_000)); reply.end(' '.repeat(5_000));
  });
  const adapter = provider.adapter();
  assert.deepEqual(await adapter.execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_INVALID_RESPONSE' });
  chunked = true;
  assert.deepEqual(await adapter.execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_INVALID_RESPONSE' });
});

test('redirects cannot send the signing headers or command to another destination', async (t) => {
  let redirected = 0;
  const sink = await receiver(t, (_request, reply) => { redirected++; output(reply, 200, successful()); });
  const provider = await receiver(t, (_request, reply) => { reply.writeHead(307, { location: sink.baseUrl }); reply.end(); });
  assert.deepEqual(await provider.adapter().execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_INVALID_RESPONSE' });
  assert.equal(redirected, 0);
});

test('timeout after provider acceptance includes body reads and resolves by lookup without another POST', async (t) => {
  let effects = 0; let posts = 0; let accepted = false;
  const provider = await receiver(t, (request, reply) => {
    if (request.method === 'POST') {
      posts++; if (!accepted) { effects++; accepted = true; }
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.write('{"requestKey":'); // Headers arrive; the body never finishes.
    } else { assert.equal(accepted, true); output(reply, 200, successful()); }
  });
  const adapter = provider.adapter({ timeoutMs: 500 });
  assert.deepEqual(await adapter.execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_TIMEOUT' });
  assert.deepEqual(await adapter.execute({ ...CLAIM, phase: 'lookup' }), { kind: 'succeeded' });
  assert.equal(posts, 1); assert.equal(effects, 1);
});

test('authentication failures, rate limits and server errors never prove non-execution', async (t) => {
  let status = 500;
  const provider = await receiver(t, (_request, reply) => output(reply, status, { ...successful(), secret: 'must-not-escape' }));
  const adapter = provider.adapter();
  for (const code of [401, 403, 409, 429, 500, 503]) {
    status = code;
    assert.deepEqual(await adapter.execute(CLAIM), { kind: 'uncertain', code: 'PROVIDER_UNAVAILABLE' });
  }
});

test('expired send windows and expired leases cause no HTTP, while lookup remains allowed', async (t) => {
  let requests = 0;
  const provider = await receiver(t, (_request, reply) => { requests++; output(reply, 200, successful()); });
  const adapter = provider.adapter();
  assert.deepEqual(await adapter.execute({ ...CLAIM, expiresAt: NOW }), { kind: 'uncertain', code: 'IDEMPOTENCY_WINDOW_EXPIRED' });
  await assert.rejects(adapter.execute({ ...CLAIM, leaseUntil: NOW }), IssuerLeaseExpiredError);
  assert.equal(requests, 0);
  assert.deepEqual(await adapter.execute({ ...CLAIM, phase: 'lookup', expiresAt: NOW - 1 }), { kind: 'succeeded' });
  assert.equal(requests, 1);
});

test('sandbox configuration refuses remote URLs, URL ambiguities and weak keys', () => {
  const valid = { baseUrl: 'http://127.0.0.1:3005', keyId: 'test-key', signingKey: KEY };
  for (const baseUrl of ['https://issuer.example', 'http://localhost:3005', 'http://127.1:3005', 'http://127.0.0.1',
    'http://user:pass@127.0.0.1:3005', 'http://127.0.0.1:3005/path', 'http://127.0.0.1:3005?x=1', 'http://127.0.0.1:3005#fragment',
    'http://127.0.0.1:70000', ' http://127.0.0.1:3005']) assert.throws(() => createSandboxIssuerAdapter({ ...valid, baseUrl }), IssuerAdapterConfigurationError);
  for (const signingKey of ['', 'short', KEY + '=', Buffer.alloc(31).toString('base64url')]) assert.throws(() => createSandboxIssuerAdapter({ ...valid, signingKey }), IssuerAdapterConfigurationError);
  for (const keyId of ['', 'bad.key', 'a'.repeat(33)]) assert.throws(() => createSandboxIssuerAdapter({ ...valid, keyId }), IssuerAdapterConfigurationError);
  for (const timeoutMs of [0, 9, 5001, NaN]) assert.throws(() => createSandboxIssuerAdapter({ ...valid, timeoutMs }), IssuerAdapterConfigurationError);
});

test('production disables both new and previously constructed sandbox adapters', async () => {
  const options = { baseUrl: 'http://127.0.0.1:3005', keyId: 'test-key', signingKey: KEY, now: () => NOW };
  const adapter = createSandboxIssuerAdapter(options); const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(() => createSandboxIssuerAdapter(options), IssuerAdapterConfigurationError);
    await assert.rejects(adapter.execute(CLAIM), IssuerAdapterConfigurationError);
  } finally { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; }
});

const finished = (id = CLAIM.id): IssuerOutboxFinishResult => ({ id, status: 'succeeded', version: 3, nextAttemptAt: null, errorCode: null });
type DispatchStore = Pick<IssuerOutboxStore, 'claim' | 'finish' | 'stats'>;

test('dispatcher health failure does not delay committed commands or disclose claim details', async () => {
  const stop = new AbortController(); const reports: Record<string, unknown>[] = [];
  let claims = 0; let completions = 0; let health = 0;
  const outbox = {
    async claim() { claims++; return { ...CLAIM, id: `command-${claims}` }; },
    async finish(input: { id: string }) { completions++; if (completions === 2) stop.abort(); return finished(input.id); },
    async stats() { health++; throw new Error('private-db-details'); },
  } as unknown as DispatchStore;
  await runIssuerDispatcher(outbox, { execute: async () => ({ kind: 'succeeded' }) }, { signal: stop.signal, pollMs: 250, report: (event) => reports.push(event) });
  assert.equal(claims, 2); assert.equal(completions, 2); assert.equal(health, 1);
  assert.equal(reports.filter((entry) => entry.event === 'issuer_command_processed').length, 2);
  assert.ok(reports.some((entry) => entry.event === 'issuer_outbox_health_unavailable'));
  for (const privateValue of [CLAIM.requestKey, CLAIM.leaseToken, CLAIM.providerCardId, 'private-db-details']) assert.equal(JSON.stringify(reports).includes(privateValue), false);
});

test('dispatcher shutdown after claim leaves the command for lease recovery without a new HTTP call', async () => {
  const stop = new AbortController(); let calls = 0; let completions = 0;
  const outbox = {
    async claim() { stop.abort(); return CLAIM; }, async finish() { completions++; return finished(); }, async stats() { return {}; },
  } as unknown as DispatchStore;
  const result = await dispatchIssuerOnce(outbox, { async execute() { calls++; return { kind: 'succeeded' }; } }, stop.signal);
  assert.deepEqual(result, { id: CLAIM.id, status: 'deferred', errorCode: 'DISPATCHER_STOPPING' });
  assert.equal(calls, 0); assert.equal(completions, 0);
  assert.equal(await dispatchIssuerOnce(outbox, { async execute() { throw new Error('not called'); } }, stop.signal), null);
});

test('dispatcher reports stale claims without applying a late provider result', async () => {
  let completions = 0;
  const outbox = { async claim() { return CLAIM; }, async finish() { completions++; throw new LedgerError(409, 'OUTBOX_LEASE_LOST', 'stale'); }, async stats() { return {}; } } as unknown as DispatchStore;
  const expected = { id: CLAIM.id, status: 'lease_lost', errorCode: 'OUTBOX_LEASE_LOST' };
  assert.deepEqual(await dispatchIssuerOnce(outbox, { async execute() { throw new IssuerLeaseExpiredError(); } }), expected);
  assert.equal(completions, 0);
  assert.deepEqual(await dispatchIssuerOnce(outbox, { async execute() { return { kind: 'succeeded' }; } }), expected);
  assert.equal(completions, 1);
});
