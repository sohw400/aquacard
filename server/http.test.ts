import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApiServer } from './http';
import { LedgerStore } from './ledger';
import type { AccountSnapshot, MemberProfile, TransferResult } from '../shared/api';

type TestBody = AccountSnapshot & TransferResult & { member: MemberProfile };

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'Aqua-test-password-42';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aqua-api-'));
  const store = new LedgerStore(join(directory, 'db.sqlite'));
  const mail: { email: string; token: string }[] = [];
  const server = createApiServer(store, { allowedOrigins: [ORIGIN], deliverRecovery: async (email, token) => { mail.push({ email, token }); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  async function request(path: string, { method = 'GET', body, cookie = '', headers = {} }: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
    const response = await fetch(`${url}/api${path}`, {
      method, headers: { Origin: ORIGIN, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as TestBody, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '', headers: response.headers };
  }
  async function signup(tag: string) {
    const response = await request('/auth/signup', { method: 'POST', body: { email: `${tag}@example.com`, name: `회원${tag}`, tag, password: PASSWORD } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return { ...response, user: response.data.user };
  }
  return { store, server, url, request, signup, mail, async close() { await new Promise<void>((done, fail) => { server.close((error) => error ? fail(error) : done()); server.closeAllConnections(); }); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('HTTP sessions isolate accounts; no browser state or caller-selected user controls the ledger', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/account')).status, 401);
    assert.deepEqual((await f.request('/session')).data, { user: null });
    const alice = await f.signup('alice');
    const bob = await f.signup('bobby');
    assert.match(alice.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
    assert.equal(alice.headers.get('cache-control'), 'no-store');
    assert.equal('passwordHash' in alice.user, false);
    assert.equal('token' in alice.data, false);
    assert.equal((await f.request('/account', { cookie: alice.cookie })).data.balanceWon, 0);
    f.store.creditSandbox({ userId: alice.user.id, amountWon: 30_000, idempotencyKey: 'fund-alice-0001' });
    const lookup = await f.request('/members?tag=bobby', { cookie: alice.cookie });
    assert.equal(lookup.status, 200);
    assert.equal(lookup.data.member.email, undefined);
    assert.match(lookup.data.member.name, /\*/);
    assert.equal((await f.request(`/account?userId=${alice.user.id}`, { cookie: bob.cookie })).data.balanceWon, 0);
    const transfer = await f.request('/transfers', { method: 'POST', cookie: alice.cookie, headers: { 'Idempotency-Key': 'send-alice-0001', 'X-Aqua-Account': alice.user.id }, body: { recipientTag: 'bobby', amountWon: 12_000, senderId: bob.user.id } });
    assert.equal(transfer.status, 200, JSON.stringify(transfer.data));
    assert.equal(transfer.data.balanceWon, 18_000);
    assert.equal((await f.request('/account', { cookie: bob.cookie })).data.balanceWon, 12_000);
    const retry = await f.request('/transfers', { method: 'POST', cookie: alice.cookie, headers: { 'Idempotency-Key': 'send-alice-0001', 'X-Aqua-Account': alice.user.id }, body: { recipientTag: 'bobby', amountWon: 12_000 } });
    assert.equal(retry.data.transfer.id, transfer.data.transfer.id);
    assert.equal((await f.request('/account', { cookie: bob.cookie })).data.transactions.length, 1);
    const conflict = await f.request('/transfers', { method: 'POST', cookie: alice.cookie, headers: { 'Idempotency-Key': 'send-alice-0001', 'X-Aqua-Account': alice.user.id }, body: { recipientTag: 'bobby', amountWon: 13_000 } });
    assert.equal(conflict.status, 409);
    const changedSession = await f.request('/transfers', { method: 'POST', cookie: bob.cookie, headers: { 'Idempotency-Key': 'old-screen-intent', 'X-Aqua-Account': alice.user.id }, body: { recipientTag: 'alice', amountWon: 1_000 } });
    assert.equal(changedSession.status, 409);
    assert.equal((changedSession.data as unknown as { error: { code: string } }).error.code, 'SESSION_CHANGED');
    assert.equal(f.store.snapshot(bob.user.id).balanceWon, 12_000);
    assert.equal((await f.request('/auth/logout', { method: 'POST', cookie: bob.cookie, headers: { 'X-Aqua-Account': alice.user.id }, body: {} })).status, 409);
    assert.equal((await f.request('/auth/logout', { method: 'POST', cookie: alice.cookie, headers: { 'X-Aqua-Account': alice.user.id }, body: {} })).status, 200);
    assert.equal((await f.request('/account', { cookie: alice.cookie })).status, 401);
    assert.equal((await f.request('/account', { cookie: bob.cookie })).status, 200);
    const relogin = await f.request('/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: PASSWORD } });
    assert.equal((await f.request('/account', { cookie: relogin.cookie })).data.balanceWon, 18_000);
  } finally { await f.close(); }
});

test('origin, JSON type, request size, input and idempotency key are enforced at HTTP boundary', async () => {
  const f = await fixture();
  try {
    const signup = { email: 'origin@example.com', name: '테스트회원', tag: 'origin', password: PASSWORD };
    assert.equal((await f.request('/auth/signup', { method: 'POST', body: signup, headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await f.request('/auth/signup', { method: 'POST', body: signup, headers: { Origin: '' } })).status, 403);
    assert.equal((await f.request('/auth/signup', { method: 'POST', body: signup, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await f.request('/auth/signup', { method: 'POST', body: { ...signup, name: 'x'.repeat(20_000) } })).status, 413);
    const invalidJson = await fetch(`${f.url}/api/auth/signup`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalidJson.status, 400);
    const account = await f.signup('origin');
    assert.equal((await f.request('/transfers', { method: 'POST', cookie: account.cookie, headers: { 'X-Aqua-Account': account.user.id }, body: { recipientTag: 'bobby', amountWon: 1000 } })).status, 400);
    assert.equal((await f.request('/transfers', { method: 'POST', cookie: account.cookie, headers: { 'Idempotency-Key': 'invalid-amount', 'X-Aqua-Account': account.user.id }, body: { recipientTag: 'bobby', amountWon: '1000' } })).status, 400);
    assert.equal((await f.request('/credit', { method: 'POST', cookie: account.cookie, body: { amountWon: 1_000_000 } })).status, 404);
    assert.equal((await f.request('/account', { cookie: account.cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.request('/auth/signup', { method: 'PUT', body: signup })).status, 405);
  } finally { await f.close(); }
});

test('recovery returns no secret and revokes old sessions; token cannot be reused', async () => {
  const f = await fixture();
  try {
    const account = await f.signup('recover');
    const unknown = await f.request('/auth/recovery/request', { method: 'POST', body: { email: 'absent@example.com' } });
    const known = await f.request('/auth/recovery/request', { method: 'POST', body: { email: 'recover@example.com' } });
    assert.equal(known.status, 202);
    assert.deepEqual(known.data, unknown.data);
    assert.equal(f.mail.length, 1);
    const changed = 'Replacement-password-42';
    const reset = await f.request('/auth/recovery/confirm', { method: 'POST', body: { token: f.mail[0].token, password: changed } });
    assert.equal(reset.status, 200, JSON.stringify(reset.data));
    assert.equal((await f.request('/account', { cookie: account.cookie })).status, 401);
    assert.notEqual((await f.request('/auth/recovery/confirm', { method: 'POST', body: { token: f.mail[0].token, password: changed } })).status, 200);
    assert.equal((await f.request('/auth/login', { method: 'POST', body: { email: 'recover@example.com', password: changed } })).status, 200);
    assert.equal((await f.request('/auth/login', { method: 'POST', body: { email: 'recover@example.com', password: PASSWORD } })).status, 401);
  } finally { await f.close(); }
});

test('concurrent HTTP sends cannot spend the same balance twice', async () => {
  const f = await fixture();
  try {
    const alice = await f.signup('sender');
    const bob = await f.signup('target');
    f.store.creditSandbox({ userId: alice.user.id, amountWon: 15_000, idempotencyKey: 'http-race-funding' });
    const results = await Promise.all(['http-race-one', 'http-race-two'].map((key) => f.request('/transfers', { method: 'POST', cookie: alice.cookie, headers: { 'Idempotency-Key': key, 'X-Aqua-Account': alice.user.id }, body: { recipientTag: 'target', amountWon: 10_000 } })));
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.equal(f.store.snapshot(alice.user.id).balanceWon, 5_000);
    assert.equal(f.store.snapshot(bob.user.id).balanceWon, 10_000);
  } finally { await f.close(); }
});
