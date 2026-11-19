import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApiServer } from './http';
import { Database } from './database';
import { LedgerStore } from './ledger';
import { CardPaymentStore } from './card-payments';
import { createTestDatabase } from './test-support';
import type { AccountSnapshot, MemberProfile, TransferResult } from '../shared/api';

type TestBody = AccountSnapshot & TransferResult & {
  member: MemberProfile;
  error: { code: string; message: string };
  ok: true;
  status: string;
  mode: string;
};
type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  headers?: Record<string, string>;
};
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'Aqua-test-password-42';

async function request(server: FastifyInstance, path: string, { method = 'GET', body, rawBody, cookie = '', headers: extras = {} }: RequestOptions = {}) {
  const response = await server.inject({
    method,
    url: path.startsWith('/api') ? path : `/api${path}`,
    headers: {
      Origin: ORIGIN,
      ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extras,
    },
    ...(rawBody !== undefined ? { payload: rawBody } : body !== undefined ? { payload: JSON.stringify(body) } : {}),
    remoteAddress: '127.0.0.1',
  });
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, String(value));
  }
  return {
    status: response.statusCode,
    data: response.json<TestBody>(),
    cookie: headers.get('set-cookie')?.split(';')[0] ?? '',
    headers,
    body: response.body,
  };
}

async function fixture(options: { secureCookies?: boolean; recovery?: boolean; staticDir?: string; logger?: Parameters<typeof createApiServer>[1]['logger'] } = {}) {
  const context = await createTestDatabase();
  const store = new LedgerStore(context.database);
  const mail: { email: string; token: string }[] = [];
  const server = createApiServer(store, {
    allowedOrigins: [ORIGIN],
    secureCookies: options.secureCookies,
    staticDir: options.staticDir,
    logger: options.logger ?? false,
    ...(options.recovery !== false ? { deliverRecovery: async (email: string, token: string) => { mail.push({ email, token }); } } : {}),
  });
  try { await server.ready(); }
  catch (error) { await server.close(); await context.cleanup(); throw error; }
  async function signup(tag: string) {
    const response = await request(server, '/auth/signup', { method: 'POST', body: { email: `${tag}@example.com`, name: `회원${tag}`, tag, password: PASSWORD } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return { ...response, user: response.data.user };
  }
  return {
    ...context, store, server, signup, mail,
    request: (path: string, options?: RequestOptions) => request(server, path, options),
    async close() { try { await server.close(); } finally { await context.cleanup(); } },
  };
}

test('Fastify sessions isolate accounts and ignore caller-selected sender IDs', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/account')).status, 401);
    assert.deepEqual((await f.request('/session')).data, { user: null });
    const alice = await f.signup('alice');
    const bob = await f.signup('bobby');
    const cookie = alice.headers.get('set-cookie') ?? '';
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\/api(?:;|$)/);
    assert.equal(alice.headers.get('cache-control'), 'no-store');
    assert.equal(alice.headers.get('x-content-type-options'), 'nosniff');
    assert.equal('passwordHash' in alice.user, false);
    assert.equal('token' in alice.data, false);
    assert.equal((await f.request('/account', { cookie: alice.cookie })).data.balanceWon, 0);
    await f.store.creditSandbox({ userId: alice.user.id, amountWon: 30_000, idempotencyKey: 'fund-alice-0001' });
    const lookup = await f.request('/members?tag=bobby', { cookie: alice.cookie });
    assert.equal(lookup.status, 200);
    assert.equal(lookup.data.member.email, undefined);
    assert.match(lookup.data.member.name, /\*/);
    assert.equal((await f.request(`/account?userId=${alice.user.id}`, { cookie: bob.cookie })).data.balanceWon, 0);
    const transfer = await f.request('/transfers', {
      method: 'POST', cookie: alice.cookie,
      headers: { 'Idempotency-Key': 'send-alice-0001', 'X-Aqua-Account': alice.user.id },
      body: { recipientTag: 'bobby', amountWon: 12_000, senderId: bob.user.id },
    });
    assert.equal(transfer.status, 200, JSON.stringify(transfer.data));
    assert.equal(transfer.data.balanceWon, 18_000);
    assert.equal((await f.request('/account', { cookie: bob.cookie })).data.balanceWon, 12_000);
    const retry = await f.request('/transfers', {
      method: 'POST', cookie: alice.cookie,
      headers: { 'Idempotency-Key': 'send-alice-0001', 'X-Aqua-Account': alice.user.id },
      body: { recipientTag: 'bobby', amountWon: 12_000 },
    });
    assert.equal(retry.data.transfer.id, transfer.data.transfer.id);
    assert.equal((await f.request('/account', { cookie: bob.cookie })).data.transactions.length, 1);
    const conflict = await f.request('/transfers', {
      method: 'POST', cookie: alice.cookie,
      headers: { 'Idempotency-Key': 'send-alice-0001', 'X-Aqua-Account': alice.user.id },
      body: { recipientTag: 'bobby', amountWon: 13_000 },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error.code, 'IDEMPOTENCY_CONFLICT');
    const changedSession = await f.request('/transfers', {
      method: 'POST', cookie: bob.cookie,
      headers: { 'Idempotency-Key': 'old-screen-intent', 'X-Aqua-Account': alice.user.id },
      body: { recipientTag: 'alice', amountWon: 1_000 },
    });
    assert.equal(changedSession.status, 409);
    assert.equal(changedSession.data.error.code, 'SESSION_CHANGED');
    assert.equal((await f.store.snapshot(bob.user.id)).balanceWon, 12_000);
    assert.equal((await f.request('/auth/logout', { method: 'POST', cookie: bob.cookie, headers: { 'X-Aqua-Account': alice.user.id }, body: {} })).status, 409);
    assert.equal((await f.request('/account', { cookie: bob.cookie })).status, 200);
    const logout = await f.request('/auth/logout', { method: 'POST', cookie: alice.cookie, headers: { 'X-Aqua-Account': alice.user.id }, body: {} });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/i);
    assert.equal((await f.request('/account', { cookie: alice.cookie })).status, 401);
    const relogin = await f.request('/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: PASSWORD } });
    assert.equal((await f.request('/account', { cookie: relogin.cookie })).data.balanceWon, 18_000);
  } finally { await f.close(); }
});

test('account responses expose owned card holds and prevent spending them through member transfers', async () => {
  const f = await fixture();
  try {
    const alice = await f.signup('cardalice');
    const bob = await f.signup('cardbobby');
    await f.store.creditSandbox({ userId: alice.user.id, amountWon: 100_000, idempotencyKey: 'card-http-seed' });
    const cards = new CardPaymentStore(f.database);
    await cards.apply({ kind: 'authorize', eventId: 'http-auth-event', paymentId: 'http-payment', userId: alice.user.id, amountWon: 80_000, merchantName: '테스트 서점' });
    const own = await f.request('/account', { cookie: alice.cookie });
    assert.equal(own.status, 200);
    assert.equal(own.data.balanceWon, 20_000);
    assert.equal(own.data.heldBalanceWon, 80_000);
    assert.equal(own.data.totalBalanceWon, 100_000);
    assert.equal(own.data.limits.available, 20_000);
    assert.equal(own.data.cardPayments.length, 1);
    assert.equal(own.data.cardPayments[0].merchantName, '테스트 서점');
    assert.equal(own.data.cardPayments[0].status, 'authorized');
    assert.equal(own.body.includes('http-auth-event'), false);
    assert.equal(own.body.includes('request_payload'), false);
    const other = await f.request(`/account?userId=${alice.user.id}`, { cookie: bob.cookie });
    assert.deepEqual(other.data.cardPayments, []);
    assert.equal(other.data.heldBalanceWon, 0);
    const sent = await f.request('/transfers', { method: 'POST', cookie: alice.cookie, headers: { 'Idempotency-Key': 'card-hold-transfer', 'X-Aqua-Account': alice.user.id }, body: { recipientTag: 'cardbobby', amountWon: 25_000 } });
    assert.equal(sent.status, 409);
    assert.equal(sent.data.error.code, 'INSUFFICIENT_FUNDS');
    for (const path of ['/card-events', '/cards/authorize', '/cards/refund']) {
      const response = await f.request(path, { method: 'POST', cookie: alice.cookie, body: { paymentId: 'http-payment', amountWon: 80_000 } });
      assert.equal(response.status, 404);
    }
    await cards.apply({ kind: 'capture', eventId: 'http-capture-event', paymentId: 'http-payment', userId: alice.user.id, amountWon: 60_000, finalCapture: true });
    const captured = await f.request('/account', { cookie: alice.cookie });
    assert.equal(captured.data.balanceWon, 40_000);
    assert.equal(captured.data.heldBalanceWon, 0);
    assert.equal(captured.data.cardPayments[0].releasedWon, 20_000);
    assert.equal(captured.data.cardPayments[0].status, 'captured');
    assert.equal(captured.data.transactions.length, 1, 'card legs must not appear as member transfers');
  } finally { await f.close(); }
});

test('exact Origin, Fetch Metadata, JSON type, body limit and strict schema protect mutations', async () => {
  const f = await fixture();
  try {
    const signup = { email: 'origin@example.com', name: '테스트회원', tag: 'origin', password: PASSWORD };
    for (const origin of ['https://untrusted.example', 'http://localhost:5173.attacker.example', '', 'null']) {
      assert.equal((await f.request('/auth/signup', { method: 'POST', body: signup, headers: { Origin: origin } })).status, 403);
    }
    assert.equal((await f.request('/auth/signup', { method: 'POST', body: signup, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.request('/auth/signup', { method: 'POST', body: signup, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await f.request('/auth/signup', { method: 'POST', body: { ...signup, name: 'x'.repeat(20_000) } })).status, 413);
    const invalid = await f.request('/auth/signup', { method: 'POST', rawBody: '{' });
    assert.equal(invalid.status, 400);
    assert.equal(typeof invalid.data.error.message, 'string');
    assert.equal(invalid.body.includes('SyntaxError'), false);
    for (const body of [null, [], true, 12, 'object-required']) assert.equal((await f.request('/auth/signup', { method: 'POST', body })).status, 400);
    const account = await f.signup('origin');
    const actor = { 'X-Aqua-Account': account.user.id };
    assert.equal((await f.request('/transfers', { method: 'POST', cookie: account.cookie, headers: actor, body: { recipientTag: 'bobby', amountWon: 1_000 } })).status, 400);
    assert.equal((await f.request('/transfers', { method: 'POST', cookie: account.cookie, headers: { ...actor, 'Idempotency-Key': 'invalid-amount' }, body: { recipientTag: 'bobby', amountWon: '1000' } })).status, 400);
    assert.equal((await f.request('/transfers', { method: 'POST', cookie: account.cookie, headers: { ...actor, 'Idempotency-Key': 'fractional-amount' }, body: { recipientTag: 'bobby', amountWon: 1_000.5 } })).status, 400);
    assert.equal((await f.request('/credit', { method: 'POST', cookie: account.cookie, body: { amountWon: 1_000_000 } })).status, 404);
    assert.equal((await f.request('/account', { cookie: account.cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.request('/auth/signup', { method: 'PUT', body: signup })).status, 405);
    assert.equal((await f.request('/account', { cookie: account.cookie })).headers.get('access-control-allow-origin'), null);
    assert.equal((await f.request('/session', { cookie: 'aqua_session=not-a-session' })).data.user, null);
  } finally { await f.close(); }
});

test('secure mode cookie attributes and unauthenticated logout preserve the auth contract', async () => {
  const f = await fixture({ secureCookies: true });
  try {
    const account = await f.signup('secure');
    const cookie = account.headers.get('set-cookie') ?? '';
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /(?:^|;\s*)Secure(?:;|$)/i);
    assert.equal(account.headers.get('strict-transport-security'), 'max-age=31536000');
    const logout = await f.request('/auth/logout', { method: 'POST', body: {} });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/i);
  } finally { await f.close(); }
});

test('recovery returns no secret and revokes every old session; a used token cannot be replayed', async () => {
  const f = await fixture();
  try {
    const account = await f.signup('recover');
    const second = await f.request('/auth/login', { method: 'POST', body: { email: 'recover@example.com', password: PASSWORD } });
    const unknown = await f.request('/auth/recovery/request', { method: 'POST', body: { email: 'absent@example.com' } });
    const known = await f.request('/auth/recovery/request', { method: 'POST', body: { email: 'recover@example.com' } });
    assert.equal(known.status, 202);
    assert.deepEqual(known.data, unknown.data);
    assert.deepEqual(known.data, { ok: true });
    assert.equal(f.mail.length, 1);
    const changed = 'Replacement-password-42';
    const reset = await f.request('/auth/recovery/confirm', { method: 'POST', body: { token: f.mail[0].token, password: changed } });
    assert.equal(reset.status, 200, JSON.stringify(reset.data));
    assert.equal((await f.request('/account', { cookie: account.cookie })).status, 401);
    assert.equal((await f.request('/account', { cookie: second.cookie })).status, 401);
    assert.notEqual((await f.request('/auth/recovery/confirm', { method: 'POST', body: { token: f.mail[0].token, password: changed } })).status, 200);
    assert.equal((await f.request('/auth/login', { method: 'POST', body: { email: 'recover@example.com', password: changed } })).status, 200);
    assert.equal((await f.request('/auth/login', { method: 'POST', body: { email: 'recover@example.com', password: PASSWORD } })).status, 401);
  } finally { await f.close(); }
});

test('recovery is explicitly unavailable when no delivery provider is configured', async () => {
  const f = await fixture({ recovery: false });
  try {
    const response = await f.request('/auth/recovery/request', { method: 'POST', body: { email: 'nobody@example.com' } });
    assert.equal(response.status, 503);
    assert.equal(response.data.error.code, 'RECOVERY_UNAVAILABLE');
    assert.equal('token' in response.data, false);
  } finally { await f.close(); }
});

test('concurrent HTTP sends cannot spend the same PostgreSQL balance twice', async () => {
  const f = await fixture();
  try {
    const alice = await f.signup('sender');
    const bob = await f.signup('target');
    await f.store.creditSandbox({ userId: alice.user.id, amountWon: 15_000, idempotencyKey: 'http-race-funding' });
    const results = await Promise.all(['http-race-one', 'http-race-two'].map((key) => f.request('/transfers', {
      method: 'POST', cookie: alice.cookie,
      headers: { 'Idempotency-Key': key, 'X-Aqua-Account': alice.user.id },
      body: { recipientTag: 'target', amountWon: 10_000 },
    })));
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.equal(results.filter((result) => result.status === 409 && result.data.error.code === 'INSUFFICIENT_FUNDS').length, 1);
    assert.equal((await f.store.snapshot(alice.user.id)).balanceWon, 5_000);
    assert.equal((await f.store.snapshot(bob.user.id)).balanceWon, 10_000);
  } finally { await f.close(); }
});

test('member lookup throttling is shared by separate Fastify instances through PostgreSQL', async () => {
  const f = await fixture();
  const second = createApiServer(new LedgerStore(f.database), { allowedOrigins: [ORIGIN], logger: false });
  try {
    await second.ready();
    const alice = await f.signup('searcher');
    await f.signup('searchtarget');
    for (let index = 0; index < 30; index++) {
      const response = await request(index % 2 ? second : f.server, '/members?tag=searchtarget', { cookie: alice.cookie });
      assert.equal(response.status, 200, `lookup ${index + 1}`);
    }
    const limited = await request(second, '/members?tag=searchtarget', { cookie: alice.cookie });
    assert.equal(limited.status, 429);
    assert.equal(limited.data.error.code, 'RATE_LIMITED');
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal(limited.headers.get('access-control-allow-origin'), null);
  } finally { await second.close(); await f.close(); }
});

test('health checks PostgreSQL readiness and returns 503 when its pool is unavailable', async () => {
  const f = await fixture();
  const isolatedPool = new Database({ connectionString: f.connectionString, schema: f.schema, maxConnections: 1 });
  const second = createApiServer(new LedgerStore(isolatedPool), { allowedOrigins: [ORIGIN], logger: false });
  try {
    const healthy = await f.request('/health');
    assert.equal(healthy.status, 200);
    assert.deepEqual(healthy.data, { status: 'ok', mode: 'sandbox' });
    await second.ready();
    assert.equal((await request(second, '/health')).status, 200);
    await isolatedPool.close();
    const unavailable = await request(second, '/health');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.data.error.code, 'DATABASE_UNAVAILABLE');
    assert.equal(unavailable.body.includes('pool'), false);
  } finally { await second.close(); await isolatedPool.close(); await f.close(); }
});

test('static plugin serves files and SPA routes while API paths remain JSON errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aqua-static-'));
  const root = join(directory, 'public');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Aqua static test</title>');
  await writeFile(join(root, 'app.js'), 'globalThis.aquaStaticTest = true;');
  await writeFile(join(directory, 'outside.txt'), 'outside-static-root');
  const f = await fixture({ staticDir: root });
  try {
    const home = await f.server.inject({ method: 'GET', url: '/' });
    assert.equal(home.statusCode, 200);
    assert.match(home.headers['content-type'] ?? '', /text\/html/);
    assert.match(home.body, /Aqua static test/);
    const homeHead = await f.server.inject({ method: 'HEAD', url: '/' });
    assert.equal(homeHead.statusCode, 200);
    assert.match(homeHead.headers['content-type'] ?? '', /text\/html/);
    assert.equal(homeHead.body, '');
    assert.equal(homeHead.headers['content-length'], home.headers['content-length']);
    const html = await f.server.inject({ method: 'GET', url: '/wallet' });
    assert.equal(html.statusCode, 200);
    assert.match(html.headers['content-type'] ?? '', /text\/html/);
    assert.match(html.body, /Aqua static test/);
    const asset = await f.server.inject({ method: 'GET', url: '/app.js' });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers['content-type'] ?? '', /javascript/);
    const head = await f.server.inject({ method: 'HEAD', url: '/app.js' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    const account = await f.signup('statictest');
    for (const url of ['/api/unknown', '/api', '/api/unknown.js']) {
      const response = await f.server.inject({ method: 'GET', url, headers: { Cookie: account.cookie } });
      assert.equal(response.statusCode, 404);
      assert.match(response.headers['content-type'] ?? '', /application\/json/);
      assert.equal(response.body.includes('<!doctype'), false);
    }
    const missing = await f.server.inject({ method: 'GET', url: '/missing.js' });
    assert.equal(missing.statusCode, 404);
    const traversal = await f.server.inject({ method: 'GET', url: '/%2e%2e%2foutside.txt' });
    assert.ok([400, 403, 404].includes(traversal.statusCode), `path traversal must be a client error, received ${traversal.statusCode}`);
    assert.equal(traversal.body.includes('outside-static-root'), false);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('OpenAPI publishes route contracts without exposing runtime authentication data', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/openapi.json');
    assert.equal(response.status, 200);
    const document = JSON.parse(response.body) as { openapi: string; info: { version: string }; paths: Record<string, unknown> };
    assert.match(document.openapi, /^3\./);
    assert.ok(document.info.version);
    for (const path of ['/api/session', '/api/account', '/api/transfers', '/api/auth/signup', '/api/auth/recovery/request']) assert.ok(document.paths[path], `${path} must be documented`);
    assert.equal(response.body.includes(PASSWORD), false);
    assert.equal(response.body.includes('passwordHash'), false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { await f.close(); }
});

test('structured request logs omit query strings, credentials, cookies and recovery tokens', async () => {
  const lines: string[] = [];
  const f = await fixture({ logger: { stream: { write: (line: string) => { lines.push(line); } } } });
  try {
    const account = await f.signup('logmember');
    await f.request('/members?tag=logmember&email=private-log-address@example.com', {
      cookie: account.cookie, headers: { Authorization: 'Bearer private-authorization-marker' },
    });
    await f.request('/auth/recovery/request', { method: 'POST', body: { email: 'logmember@example.com' } });
    f.server.log.info({
      password: 'private-password-marker', token: 'private-token-marker', cookie: 'private-cookie-marker',
      authorization: 'private-authorization-marker', body: { password: PASSWORD },
      req: { method: 'POST', headers: { cookie: account.cookie }, body: { token: f.mail[0].token } },
    }, 'redaction boundary');
    const output = lines.join('');
    for (const secret of [PASSWORD, account.cookie, f.mail[0].token, 'logmember@example.com', 'private-log-address@example.com', 'private-authorization-marker', 'private-password-marker', 'private-token-marker', 'private-cookie-marker']) {
      assert.equal(output.includes(secret), false, 'logs must not contain request secrets');
    }
    const records = lines.flatMap((line) => line.trim().split('\n').filter(Boolean).map((part) => JSON.parse(part) as Record<string, unknown>));
    const completed = records.find((record) => record.path === '/api/members' && record.statusCode === 200);
    assert.ok(completed, 'request logs should retain safe method, route and status fields');
    assert.equal(completed.method, 'GET');
    assert.equal(typeof completed.requestId, 'string');
    assert.equal(typeof completed.durationMs, 'number');
  } finally { await f.close(); }
});
