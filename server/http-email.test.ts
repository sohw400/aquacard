import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { PoolClient } from 'pg';
import { createApiServer } from './http';
import { LedgerStore } from './ledger';
import { createTestDatabase } from './test-support';
import type { MemberProfile } from '../shared/api';

const origin = 'http://localhost:5173';
const password = 'Aqua-Http-Email-Password42!';
const replacement = 'Aqua-Http-Recovered-Password84!';
type Mail = { purpose: 'email-verification' | 'password-recovery'; userId: string; email: string; token: string; createdAt: number; expiresAt: number };

async function fixture(t: TestContext) {
  const base = await createTestDatabase();
  const store = new LedgerStore(base.database);
  const mail: Mail[] = [];
  let failNext = false;
  const mailQueue = { async enqueue(_client: PoolClient, message: Mail) {
    mail.push({ ...message });
    if (failNext) { failNext = false; throw new Error('Injected queue failure'); }
  } };
  const api = createApiServer(store, { allowedOrigins: [origin], logger: false, mailQueue });
  const disabled = createApiServer(store, { allowedOrigins: [origin], logger: false });
  await api.ready(); await disabled.ready();
  t.after(async () => { try { await api.close(); await disabled.close(); } finally { await base.cleanup(); } });
  async function request(path: string, cookie = '', ownerId = '', body?: unknown, headers: Record<string, string> = {}, withoutQueue = false) {
    return (withoutQueue ? disabled : api).inject({ method: body === undefined ? 'GET' : 'POST', url: `/api${path}`,
      headers: { origin, cookie, ...(ownerId ? { 'x-aqua-account': ownerId } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  }
  async function signup(tag: string) {
    const result = await request('/auth/signup', '', '', { email: `${tag}@example.test`, name: '이메일 인증', tag, password });
    assert.equal(result.statusCode, 201, result.body);
    return { user: result.json<{ user: MemberProfile }>().user, cookie: String(result.headers['set-cookie']).split(';')[0] };
  }
  return { ...base, api, disabled, request, signup, mail, failQueue() { failNext = true; } };
}

test('email HTTP routes require the signed-in account and explicit same-origin POST proof', async (t) => {
  const f = await fixture(t);
  const alice = await f.signup('mailhttp.alice');
  assert.equal(alice.user.emailVerifiedAt, null);
  assert.equal((await f.request('/auth/email')).statusCode, 401);
  assert.equal((await f.request('/auth/email', alice.cookie)).statusCode, 409);
  const before = await f.request('/auth/email', alice.cookie, alice.user.id);
  assert.equal(before.statusCode, 200, before.body);
  assert.deepEqual(before.json(), { email: alice.user.email, verifiedAt: null, canRequest: true });
  assert.equal(before.headers['cache-control'], 'no-store');
  const accepted = await f.request('/auth/email/request', alice.cookie, alice.user.id, {});
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.deepEqual(accepted.json(), { ok: true });
  const token = f.mail[0].token;
  assert.ok(!accepted.body.includes(token));
  assert.equal((await f.request('/auth/email/confirm', alice.cookie, alice.user.id)).statusCode, 404, 'A GET must never consume an email token.');
  const crossSite = await f.request('/auth/email/confirm', alice.cookie, alice.user.id, { token }, { origin: 'https://untrusted.example' });
  assert.equal(crossSite.statusCode, 403);
  assert.equal((await f.request('/session', alice.cookie)).json().user.emailVerifiedAt, null);
  const confirmed = await f.request('/auth/email/confirm', alice.cookie, alice.user.id, { token });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.deepEqual(confirmed.json(), { ok: true });
  const account = (await f.request('/account', alice.cookie)).json();
  assert.equal(typeof account.user.emailVerifiedAt, 'number');
  assert.equal(account.access.status, 'unverified');
  assert.equal(account.access.canTransact, false);
  assert.equal((await f.request('/auth/email', alice.cookie, alice.user.id)).json().canRequest, false);
});

test('a verification code cannot approve another account or be used as a password reset code', async (t) => {
  const f = await fixture(t);
  const alice = await f.signup('mailhttp.owner');
  const bob = await f.signup('mailhttp.foreign');
  await f.request('/auth/email/request', alice.cookie, alice.user.id, {});
  const token = f.mail[0].token;
  const switched = await f.request('/auth/email/confirm', bob.cookie, alice.user.id, { token });
  assert.equal(switched.statusCode, 409);
  assert.equal(switched.json().error.code, 'SESSION_CHANGED');
  const foreign = await f.request('/auth/email/confirm', bob.cookie, bob.user.id, { token });
  assert.equal(foreign.statusCode, 400, foreign.body);
  assert.equal(foreign.json().error.code, 'INVALID_EMAIL_VERIFICATION');
  const wrongPurpose = await f.request('/auth/recovery/confirm', '', '', { token, password: replacement });
  assert.equal(wrongPurpose.statusCode, 400);
  assert.equal(wrongPurpose.json().error.code, 'INVALID_RECOVERY');
  assert.equal((await f.request('/session', alice.cookie)).json().user.emailVerifiedAt, null);
  assert.equal((await f.request('/session', bob.cookie)).json().user.emailVerifiedAt, null);
  const success = await f.request('/auth/email/confirm', alice.cookie, alice.user.id, { token, userId: bob.user.id, email: bob.user.email });
  assert.equal(success.statusCode, 200, success.body);
  assert.equal((await f.request('/session', bob.cookie)).json().user.emailVerifiedAt, null);
});

test('disabling issuance does not block valid email confirmation or password recovery confirmation', async (t) => {
  const f = await fixture(t);
  const alice = await f.signup('mailhttp.outage');
  await f.request('/auth/email/request', alice.cookie, alice.user.id, {});
  const verification = f.mail[0].token;
  const recoveryRequest = await f.request('/auth/recovery/request', '', '', { email: alice.user.email });
  assert.equal(recoveryRequest.statusCode, 202);
  const recovery = f.mail[1].token;
  const snapshot = await f.request('/auth/email', alice.cookie, alice.user.id, undefined, {}, true);
  assert.equal(snapshot.json().canRequest, false);
  const disabled = await f.request('/auth/email/request', alice.cookie, alice.user.id, {}, {}, true);
  assert.equal(disabled.statusCode, 503);
  const confirmed = await f.request('/auth/email/confirm', alice.cookie, alice.user.id, { token: verification }, {}, true);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const reset = await f.request('/auth/recovery/confirm', '', '', { token: recovery, password: replacement }, {}, true);
  assert.equal(reset.statusCode, 200, reset.body);
  assert.match(String(reset.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await f.request('/session', alice.cookie)).json().user, null);
  assert.equal((await f.request('/auth/email/confirm', alice.cookie, alice.user.id, { token: verification })).statusCode, 401);
  const login = await f.request('/auth/login', '', '', { email: alice.user.email, password: replacement });
  assert.equal(login.statusCode, 200);
  assert.equal(typeof login.json().user.emailVerifiedAt, 'number');
});

test('recovery queue failures do not reveal whether the requested account exists', async (t) => {
  const f = await fixture(t);
  const alice = await f.signup('mailhttp.recovery');
  const first = await f.request('/auth/recovery/request', '', '', { email: alice.user.email });
  assert.equal(first.statusCode, 202);
  const prior = f.mail[0].token;
  f.failQueue();
  const known = await f.request('/auth/recovery/request', '', '', { email: alice.user.email });
  const unknown = await f.request('/auth/recovery/request', '', '', { email: 'absent@example.test' });
  assert.equal(known.statusCode, 202, known.body);
  assert.equal(unknown.statusCode, 202, unknown.body);
  assert.deepEqual(known.json(), unknown.json());
  assert.deepEqual(known.json(), { ok: true });
  assert.ok(!known.body.includes(prior));
  const reset = await f.request('/auth/recovery/confirm', '', '', { token: prior, password: replacement });
  assert.equal(reset.statusCode, 200, reset.body);
});
