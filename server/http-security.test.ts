import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { createApiServer } from './http';
import { LedgerStore } from './ledger';
import { createTestDatabase } from './test-support';
import type { SessionSecuritySnapshot } from '../shared/api';

const origin = 'http://localhost:5173';
const password = 'Aqua-security-password-42';
async function fixture(t: TestContext) {
  const context = await createTestDatabase();
  const api = createApiServer(new LedgerStore(context.database), { allowedOrigins: [origin], logger: false });
  await api.ready();
  t.after(async () => { try { await api.close(); } finally { await context.cleanup(); } });
  async function request(path: string, cookie = '', account = '', body?: unknown, extras: Record<string, string> = {}) {
    return api.inject({ method: body === undefined ? 'GET' : 'POST', url: `/api${path}`,
      headers: { origin, cookie, 'x-aqua-account': account, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extras },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  }
  async function signup(tag: string) {
    const response = await request('/auth/signup', '', '', { email: `${tag}@example.com`, name: '보안 테스트', tag, password },
      { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1 secret-marker' });
    assert.equal(response.statusCode, 201, response.body);
    return { user: response.json().user, cookie: String(response.headers['set-cookie']).split(';')[0] };
  }
  return { ...context, api, request, signup };
}

test('security endpoints bind the current account, protect origins, and disclose only public session metadata', async (t) => {
  const f = await fixture(t);
  const alice = await f.signup('security.alice');
  const bob = await f.signup('security.bob');
  assert.equal((await f.request('/auth/sessions')).statusCode, 401);
  assert.equal((await f.request('/auth/sessions', alice.cookie, bob.user.id)).statusCode, 409);
  const response = await f.request('/auth/sessions', alice.cookie, alice.user.id);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<SessionSecuritySnapshot>();
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].current, true);
  assert.equal(body.sessions[0].deviceLabel, 'iPhone · Safari');
  assert.equal(response.headers['cache-control'], 'no-store');
  const secret = alice.cookie.split('=')[1];
  assert.ok(!response.body.includes(secret));
  assert.ok(!response.body.includes(createHash('sha256').update(secret).digest('hex')));
  assert.ok(!response.body.includes('secret-marker'));
  const rejected = await f.request('/auth/sessions/revoke-others', alice.cookie, alice.user.id, {}, { origin: 'https://untrusted.example' });
  assert.equal(rejected.statusCode, 403);
  assert.equal((await f.request('/auth/sessions', alice.cookie, alice.user.id)).json().sessions.length, 1);
  const account = await f.request('/account', alice.cookie);
  assert.equal(account.json().access.status, 'unverified');
  assert.equal(account.json().access.canTransact, false);
  const selfApprove = await f.request('/customer-access', alice.cookie, alice.user.id, { status: 'active' });
  assert.equal(selfApprove.statusCode, 404);
});

test('expired recent authentication requires password verification before remote session revocation', async (t) => {
  const f = await fixture(t);
  const alice = await f.signup('security.reauth');
  const secondLogin = await f.request('/auth/login', '', '', { email: alice.user.email, password }, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0' });
  assert.equal(secondLogin.statusCode, 200);
  const secondCookie = String(secondLogin.headers['set-cookie']).split(';')[0];
  await f.database.query('UPDATE auth_sessions SET reauthenticated_at=NULL WHERE user_id=$1', [alice.user.id]);
  const denied = await f.request('/auth/sessions/revoke-others', alice.cookie, alice.user.id, {});
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'REAUTHENTICATION_REQUIRED');
  const wrong = await f.request('/auth/reauthenticate', alice.cookie, alice.user.id, { password: 'Wrong-password-42' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.code, 'INVALID_PASSWORD');
  assert.equal((await f.request('/session', alice.cookie)).json().user.id, alice.user.id);
  const verified = await f.request('/auth/reauthenticate', alice.cookie, alice.user.id, { password });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.ok(verified.json().reauthenticatedUntil > Date.now());
  const revoked = await f.request('/auth/sessions/revoke-others', alice.cookie, alice.user.id, {});
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().revokedCount, 1);
  assert.equal((await f.request('/session', secondCookie)).json().user, null);
  assert.equal((await f.request('/session', alice.cookie)).json().user.id, alice.user.id);
});

test('session IDs cannot revoke another member, and revoking this session clears its cookie', async (t) => {
  const f = await fixture(t);
  const alice = await f.signup('security.owner');
  const bob = await f.signup('security.foreign');
  const own = (await f.request('/auth/sessions', alice.cookie, alice.user.id)).json<SessionSecuritySnapshot>().sessions[0];
  const foreign = (await f.request('/auth/sessions', bob.cookie, bob.user.id)).json<SessionSecuritySnapshot>().sessions[0];
  const denied = await f.request('/auth/sessions/revoke', alice.cookie, alice.user.id, { sessionId: foreign.id });
  assert.equal(denied.statusCode, 404);
  assert.equal((await f.request('/session', bob.cookie)).json().user.id, bob.user.id);
  const revoked = await f.request('/auth/sessions/revoke', alice.cookie, alice.user.id, { sessionId: own.id });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().revokedCurrent, true);
  assert.match(String(revoked.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await f.request('/auth/sessions', alice.cookie, alice.user.id)).statusCode, 401);
});
