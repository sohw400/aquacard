import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { SandboxCardEvent } from '../shared/api';
import { CardInboxStore, type InboxReceipt } from './card-inbox';
import { IssuerOutboxStore } from './issuer-outbox';
import { createCardIngress } from './card-ingress-http';
import { Database } from './database';
import { LedgerStore } from './ledger';
import { createTestDatabase } from './test-support';

const NOW = Date.UTC(2026, 10, 19, 3);
const ROUTE = '/webhooks/sandbox/cards';
const SECRET = Buffer.alloc(32, 37).toString('base64url');
const PREVIOUS = Buffer.alloc(32, 83).toString('base64url');
const EVENT: SandboxCardEvent = {
  kind: 'authorize', eventId: 'ingress-authorize', paymentId: 'ingress-payment',
  userId: 'alice', amountWon: 5_000, merchantName: '수신 검증 가맹점',
};

function signed(body: Buffer | string, options: { keyId?: string; secret?: string; timestamp?: string } = {}) {
  const keyId = options.keyId ?? 'current';
  const timestamp = options.timestamp ?? String(NOW / 1_000);
  const signature = createHmac('sha256', Buffer.from(options.secret ?? SECRET, 'base64url'))
    .update(`sandbox.cards.v1.${keyId}.${timestamp}.`).update(body).digest('hex');
  return {
    'content-type': 'application/json', 'x-aqua-key-id': keyId,
    'x-aqua-timestamp': timestamp, 'x-aqua-signature': `v1=${signature}`,
  };
}

async function send(server: FastifyInstance, body: Buffer | string, headers = signed(body)) {
  return server.inject({ method: 'POST', url: ROUTE, headers, payload: body });
}

async function fixture(t: TestContext, options: Partial<Parameters<typeof createCardIngress>[1]> = {}) {
  const context = await createTestDatabase();
  const store = new CardInboxStore(context.database, { now: () => NOW });
  const server = createCardIngress(store, { keys: { current: SECRET }, now: () => NOW, logger: false, ...options });
  t.after(async () => { try { await server.close(); } finally { await context.cleanup(); } });
  await server.ready();
  return { ...context, store, server, ledger: new LedgerStore(context.database, { now: () => NOW }) };
}

async function inboxCount(database: Database): Promise<number> {
  return Number((await database.query('SELECT COUNT(*)::text AS count FROM card_event_inbox')).rows[0].count);
}

test('authenticated receipt is durable but does not approve or debit the card before the worker commits', async (t) => {
  const f = await fixture(t);
  await f.ledger.createUser({ id: 'alice', email: 'alice@example.test', name: '수신 테스트 회원', tag: 'alice', passwordHash: 'test-only-hash', createdAt: NOW });
  await new IssuerOutboxStore(f.database, { now: () => NOW }).register({ userId: 'alice', providerCardId: 'sandbox-card-alice', initialStatus: 'active' });
  await f.ledger.creditSandbox({ userId: 'alice', amountWon: 10_000, idempotencyKey: 'ingress-principal' });
  const body = JSON.stringify(EVENT);
  const received = await send(f.server, body);
  assert.equal(received.statusCode, 202, received.body);
  const receipt = received.json<InboxReceipt>();
  assert.deepEqual(Object.keys(receipt).sort(), ['duplicate', 'eventId', 'id', 'receivedAt', 'status']);
  assert.equal(receipt.eventId, EVENT.eventId);
  assert.equal(receipt.status, 'pending');
  assert.equal(receipt.receivedAt, NOW);
  assert.equal(receipt.duplicate, false);
  assert.equal(await inboxCount(f.database), 1);
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 10_000);
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 0);
  assert.equal((await f.ledger.snapshot('alice')).cardPayments.length, 0);

  const duplicate = await send(f.server, body);
  assert.equal(duplicate.statusCode, 202);
  assert.deepEqual(duplicate.json(), { ...receipt, duplicate: true });
  const processed = await f.store.processNext();
  assert.equal(processed?.status, 'applied');
  assert.equal((await f.ledger.snapshot('alice')).balanceWon, 5_000);
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 5_000);
  const afterCommit = await send(f.server, body);
  assert.equal(afterCommit.statusCode, 202);
  assert.deepEqual(afterCommit.json(), { ...receipt, duplicate: true, status: 'applied' });
  assert.equal(await f.store.processNext(), null);
  assert.equal((await f.ledger.snapshot('alice')).heldBalanceWon, 5_000);
});

test('a changed payload cannot reuse an accepted event ID even with a valid signature', async (t) => {
  const f = await fixture(t);
  assert.equal((await send(f.server, JSON.stringify(EVENT))).statusCode, 202);
  const changed = JSON.stringify({ ...EVENT, amountWon: 6_000 });
  const conflict = await send(f.server, changed);
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json<{ error: { code: string } }>().error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await inboxCount(f.database), 1);
});

test('the signature authenticates the exact UTF-8 bytes before JSON parsing', async (t) => {
  const f = await fixture(t);
  const compact = JSON.stringify(EVENT);
  const spaced = JSON.stringify(EVENT, null, 2);
  const altered = await send(f.server, spaced, signed(compact));
  assert.equal(altered.statusCode, 401, altered.body);
  assert.equal(await inboxCount(f.database), 0);
  assert.equal((await send(f.server, spaced)).statusCode, 202);
  const malformed = '{"not valid JSON"';
  const badAuth = await send(f.server, malformed, { ...signed(malformed), 'x-aqua-signature': 'v1=' + '0'.repeat(64) });
  assert.equal(badAuth.statusCode, 401, 'unauthenticated input must not reach JSON parsing');
  assert.equal((await send(f.server, malformed)).statusCode, 400);
  assert.equal(await inboxCount(f.database), 1);
});

test('timestamp freshness and key rotation permit only explicitly configured signing keys', async (t) => {
  const f = await fixture(t, { keys: { current: SECRET, previous: PREVIOUS } });
  const body = JSON.stringify(EVENT);
  for (const offset of [-301, 301]) {
    assert.equal((await send(f.server, body, signed(body, { timestamp: String(NOW / 1_000 + offset) }))).statusCode, 401);
  }
  assert.equal(await inboxCount(f.database), 0);
  for (const offset of [-300, 300]) {
    assert.equal((await send(f.server, body, signed(body, { timestamp: String(NOW / 1_000 + offset) }))).statusCode, 202);
  }
  assert.equal((await send(f.server, body, signed(body, { keyId: 'previous', secret: PREVIOUS }))).statusCode, 202);
  assert.equal((await send(f.server, body, signed(body, { keyId: 'removed', secret: PREVIOUS }))).statusCode, 401);
  assert.equal((await send(f.server, body, signed(body, { keyId: 'current', secret: PREVIOUS }))).statusCode, 401);
  assert.equal(await inboxCount(f.database), 1);
});

test('missing, malformed and repeated authentication headers fail without writing a receipt', async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify(EVENT);
  const valid = signed(body);
  const invalidHeaders: Record<string, string | string[]>[] = [
    { 'content-type': 'application/json' },
    { ...valid, 'x-aqua-key-id': '' },
    { ...valid, 'x-aqua-key-id': '../current' },
    { ...valid, 'x-aqua-timestamp': 'not-a-time' },
    { ...valid, 'x-aqua-timestamp': `${NOW / 1_000}.5` },
    { ...valid, 'x-aqua-signature': 'v2=' + '0'.repeat(64) },
    { ...valid, 'x-aqua-signature': 'v1=' + 'f'.repeat(63) },
    { ...valid, 'x-aqua-key-id': ['current', 'current'] },
    { ...valid, 'x-aqua-timestamp': [valid['x-aqua-timestamp'], valid['x-aqua-timestamp']] },
    { ...valid, 'x-aqua-signature': [valid['x-aqua-signature'], valid['x-aqua-signature']] },
  ];
  const outcomes = [];
  for (const headers of invalidHeaders) {
    const response = await f.server.inject({ method: 'POST', url: ROUTE, headers, payload: body });
    assert.equal(response.statusCode, 401, response.body);
    outcomes.push(response.body);
  }
  assert.equal(new Set(outcomes).size, 1, 'authentication failures should not disclose which credential check failed');
  assert.equal(await inboxCount(f.database), 0);
});

test('body size, media type, encoding and the normalized event schema are enforced before persistence', async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify(EVENT);
  const large = JSON.stringify({ ...EVENT, merchantName: 'a'.repeat(17_000) });
  assert.equal((await send(f.server, large)).statusCode, 413);
  for (const headers of [
    { ...signed(body), 'content-type': 'text/plain' },
    { ...signed(body), 'content-type': 'application/json; charset=utf-16' },
    { ...signed(body), 'content-encoding': 'gzip' },
  ]) {
    const response = await f.server.inject({ method: 'POST', url: ROUTE, headers, payload: body });
    assert.equal(response.statusCode, 415, response.body);
  }
  for (const invalid of [
    `${body}\n${body}`,
    JSON.stringify({ ...EVENT, cardNumber: 'sandbox-forbidden-pan-field' }),
    JSON.stringify({ ...EVENT, metadata: { unsafe: 'no arbitrary provider payload' } }),
    JSON.stringify({ ...EVENT, amountWon: 1.1 }),
    JSON.stringify([EVENT]),
  ]) assert.equal((await send(f.server, invalid)).statusCode, 400);
  const invalidUtf8 = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  assert.equal((await send(f.server, invalidUtf8)).statusCode, 400);
  assert.equal(await inboxCount(f.database), 0);
});

test('the sandbox ingress exposes no status, replay or customer mutation endpoints', async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify(EVENT);
  for (const path of ['/api/account', '/api/transfers', '/webhooks/sandbox/cards/status', '/webhooks/sandbox/cards/requeue']) {
    const response = await f.server.inject({ method: 'POST', url: path, headers: signed(body), payload: body });
    assert.equal(response.statusCode, 404);
  }
  assert.equal((await f.server.inject({ method: 'GET', url: ROUTE })).statusCode, 404);
  assert.equal(await inboxCount(f.database), 0);
});

test('ingress logs omit signing secrets, signatures, request bodies and raw database errors', async (t) => {
  const context = await createTestDatabase();
  const closedDatabase = new Database({ connectionString: context.connectionString, schema: context.schema });
  const lines: string[] = [];
  const server = createCardIngress(new CardInboxStore(closedDatabase, { now: () => NOW }), {
    keys: { current: SECRET }, now: () => NOW,
    logger: { stream: { write: (line: string) => { lines.push(line); } } },
  });
  t.after(async () => { try { await server.close(); await closedDatabase.close(); } finally { await context.cleanup(); } });
  await server.ready();
  await closedDatabase.close();
  const body = JSON.stringify({ ...EVENT, merchantName: 'private-merchant-log-marker' });
  const credentials = signed(body);
  const response = await server.inject({ method: 'POST', url: ROUTE + '?private=query-secret-marker', headers: {
    ...credentials, cookie: 'private-cookie-marker', authorization: 'Bearer private-authorization-marker',
  }, payload: body });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(await inboxCount(context.database), 0);
  const output = lines.join('');
  for (const secret of [SECRET, credentials['x-aqua-signature'], 'private-merchant-log-marker', 'query-secret-marker', 'private-cookie-marker', 'private-authorization-marker']) {
    assert.equal(output.includes(secret), false, `request logs must omit ${secret.slice(0, 12)}`);
  }
  assert.doesNotMatch(response.body + output, /Cannot use a pool after calling end|postgresql:\/\/|SELECT enqueue_sandbox_card_event/);
  assert.ok(output.includes('503'), 'safe operational status should remain observable');
});

test('sandbox ingress startup refuses production before inspecting signing keys or database credentials', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/card-ingress.ts'], {
    env: { ...process.env, NODE_ENV: 'production', AQUA_CARD_WEBHOOK_KEYS: 'invalid-private-key-config', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /disabled in production/i);
  assert.doesNotMatch(result.stderr, /unused:unused|invalid-private-key-config|ECONNREFUSED/);
});

test('ingress configuration requires one or two identified canonical 32-byte signing keys', async (t) => {
  const context = await createTestDatabase();
  t.after(context.cleanup);
  const store = new CardInboxStore(context.database, { now: () => NOW });
  const invalidKeys: Record<string, string>[] = [
    {},
    { one: SECRET, two: PREVIOUS, three: SECRET },
    { 'unsafe.key': SECRET },
    { current: Buffer.alloc(31).toString('base64url') },
    { current: SECRET + '=' },
    { current: 'not-a-key' },
  ];
  for (const keys of invalidKeys) assert.throws(() => createCardIngress(store, { keys, logger: false }));
});
