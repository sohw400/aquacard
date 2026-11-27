import { approveTestCustomer } from './test-customer-access';
import { CustomerAccessStore } from './customer-access';
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
import { IssuerOutboxStore } from './issuer-outbox';
import { RewardsStore } from './rewards';
import { createTestDatabase } from './test-support';
import type { AccountSnapshot, MemberProfile, TransferResult } from '../shared/api';

type TestBody = AccountSnapshot & TransferResult & {
  member: MemberProfile;
  error: { code: string; message: string };
  ok: true;
  status: string;
  mode: string;
  useFirst: boolean;
  version: number;
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
    async signupForTransactions(tag: string) {
      const session = await signup(tag);
      await approveTestCustomer(context.database, session.user.id);
      return session;
    },
    request: (path: string, options?: RequestOptions) => request(server, path, options),
    async close() { try { await server.close(); } finally { await context.cleanup(); } },
  };
}

test('active customer status does not bypass email ownership for either transfer participant', async () => {
  const f = await fixture();
  try {
    const sender = await f.signup('email.sender');
    const receiver = await f.signup('email.receiver');
    const access = new CustomerAccessStore(f.database);
    for (const user of [sender.user, receiver.user]) {
      await access.transition({ userId: user.id, status: 'active', expectedVersion: 1,
        idempotencyKey: `email-policy:${user.id}`, reason: 'Isolated HTTP fixture approval without email proof.' });
    }
    await f.store.creditSandbox({ userId: sender.user.id, amountWon: 10_000, idempotencyKey: 'email-policy-funding' });
    const send = (key: string) => f.request('/transfers', {
      method: 'POST', cookie: sender.cookie,
      headers: { 'Idempotency-Key': key, 'X-Aqua-Account': sender.user.id },
      body: { recipientTag: receiver.user.tag, amountWon: 1_000, emailVerifiedAt: Date.now() },
    });
    const blockedSender = await send('email-before-proof');
    assert.equal(blockedSender.status, 403);
    assert.equal(blockedSender.data.error.code, 'EMAIL_VERIFICATION_REQUIRED');
    const account = await f.request('/account', { cookie: sender.cookie });
    assert.equal(account.data.access.status, 'active');
    assert.equal(account.data.access.canTransact, false);
    assert.equal(account.data.user.emailVerifiedAt, null);
    // Trusted fixture proof only. The actual challenge/confirmation flow has separate integration coverage.
    await f.database.query('UPDATE users SET email_verified_at=created_at WHERE id=$1', [sender.user.id]);
    const blockedReceiver = await send('email-recipient-without-proof');
    assert.equal(blockedReceiver.status, 403);
    assert.equal(blockedReceiver.data.error.code, 'EMAIL_VERIFICATION_REQUIRED');
    assert.equal((await f.store.snapshot(sender.user.id)).balanceWon, 10_000);
    assert.equal((await f.store.snapshot(receiver.user.id)).balanceWon, 0);
    await f.database.query('UPDATE users SET email_verified_at=created_at WHERE id=$1', [receiver.user.id]);
    const allowed = await send('email-both-proven');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.balanceWon, 9_000);
  } finally { await f.close(); }
});

test('customer access is enforced for both transfer participants and a freeze preserves receipts and account reads', async () => {
  const f = await fixture();
  try {
    const sender = await f.signup('accesssender');
    const receiver = await f.signup('accessreceiver');
    await f.store.creditSandbox({ userId: sender.user.id, amountWon: 10_000, idempotencyKey: 'access-test-funding' });
    const initial = await f.request('/account', { cookie: sender.cookie });
    assert.equal(initial.data.access.status, 'unverified');
    assert.equal(initial.data.access.canTransact, false);
    const send = (key: string) => f.request('/transfers', {
      method: 'POST', cookie: sender.cookie,
      headers: { 'Idempotency-Key': key, 'X-Aqua-Account': sender.user.id },
      body: { recipientTag: receiver.user.tag, amountWon: 1_000, access: { status: 'active' } },
    });
    const denied = await send('access-before-approval');
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error.code, 'CUSTOMER_ACCESS_REQUIRED');
    assert.equal((await f.request('/api/customer/access', {
      method: 'POST', cookie: sender.cookie, body: { status: 'active' },
      headers: { 'X-Aqua-Account': sender.user.id },
    })).status, 404, 'there is no public account approval endpoint');
    await approveTestCustomer(f.database, sender.user.id);
    const recipientDenied = await send('access-recipient-unverified');
    assert.equal(recipientDenied.status, 403);
    assert.equal(recipientDenied.data.error.code, 'CUSTOMER_ACCESS_REQUIRED');
    assert.equal((await f.store.snapshot(receiver.user.id)).balanceWon, 0);
    await approveTestCustomer(f.database, receiver.user.id);
    const accepted = await send('access-approved-transfer');
    assert.equal(accepted.status, 200);
    await new CustomerAccessStore(f.database).transition({
      userId: sender.user.id, status: 'frozen', expectedVersion: 2,
      idempotencyKey: 'access-test-freeze', reason: 'Sandbox policy regression fixture',
    });
    const frozen = await f.request('/account', { cookie: sender.cookie });
    assert.equal(frozen.status, 200);
    assert.equal(frozen.data.access.status, 'frozen');
    assert.equal(frozen.data.access.canTransact, false);
    const blocked = await send('access-new-after-freeze');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error.code, 'CUSTOMER_ACCESS_REQUIRED');
    const replay = await send('access-approved-transfer');
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, accepted.data);
    assert.equal((await f.store.snapshot(receiver.user.id)).balanceWon, 1_000);
  } finally { await f.close(); }
});

test('Fastify sessions isolate accounts and ignore caller-selected sender IDs', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/account')).status, 401);
    assert.deepEqual((await f.request('/session')).data, { user: null });
    const alice = await f.signupForTransactions('alice');
    const bob = await f.signupForTransactions('bobby');
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
    const alice = await f.signupForTransactions('cardalice');
    const bob = await f.signupForTransactions('cardbobby');
    await new IssuerOutboxStore(f.database).register({ userId: alice.user.id, providerCardId: 'sandbox-card-http-alice', initialStatus: 'active' });
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

test('reward preferences require the session owner, version and immutable retry key', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/rewards/preference', { method: 'POST', body: { useFirst: false, expectedVersion: 0 } })).status, 401);
    const alice = await f.signup('rewardalice'); const bob = await f.signup('rewardbobby');
    const options = { method: 'POST' as const, cookie: alice.cookie, headers: { 'Idempotency-Key': 'reward-preference-001', 'X-Aqua-Account': alice.user.id }, body: { useFirst: false, expectedVersion: 0 } };
    const wrongOwner = await f.request('/rewards/preference', { ...options, headers: { ...options.headers, 'X-Aqua-Account': bob.user.id } });
    assert.equal(wrongOwner.status, 409); assert.equal(wrongOwner.data.error.code, 'SESSION_CHANGED');
    const changed = await f.request('/rewards/preference', options);
    assert.equal(changed.status, 200); assert.deepEqual(changed.data, { useFirst: false, version: 1 });
    assert.deepEqual((await f.request('/rewards/preference', options)).data, changed.data);
    const next = await f.request('/rewards/preference', { ...options, headers: { ...options.headers, 'Idempotency-Key': 'reward-preference-002' }, body: { useFirst: true, expectedVersion: 1 } });
    assert.equal(next.status, 200); assert.equal(next.data.version, 2);
    assert.deepEqual((await f.request('/rewards/preference', options)).data, changed.data, 'old response replay must not overwrite the newer preference');
    const stale = await f.request('/rewards/preference', { ...options, headers: { ...options.headers, 'Idempotency-Key': 'reward-preference-003' } });
    assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'PREFERENCE_CHANGED');
    const changedContent = await f.request('/rewards/preference', { ...options, body: { useFirst: true, expectedVersion: 0 } });
    assert.equal(changedContent.status, 409);
    const state = await f.request('/account', { cookie: alice.cookie });
    assert.equal(state.data.rewards.useFirst, true); assert.equal(state.data.rewards.preferenceVersion, 2);
    const other = await f.request('/account', { cookie: bob.cookie });
    assert.equal(other.data.rewards.preferenceVersion, 0);
    const bad = await f.request('/rewards/preference', { ...options, body: { useFirst: 'false', expectedVersion: 2 } });
    assert.equal(bad.status, 400);
  } finally { await f.close(); }
});

test('funded rewards remain card-only and the API exposes the original funding split and cashback separately', async () => {
  const f = await fixture();
  try {
    const alice = await f.signupForTransactions('rewardowner'); const bob = await f.signupForTransactions('rewardother');
    await new IssuerOutboxStore(f.database).register({ userId: alice.user.id, providerCardId: 'sandbox-card-http-reward', initialStatus: 'active' });
    const rewards = new RewardsStore(f.database);
    await rewards.fundBudget({ amountWon: 7_040, idempotencyKey: 'http-company-budget' });
    await rewards.setProgram({ enabled: true, idempotencyKey: 'http-enable-rewards' });
    await rewards.grant({ userId: alice.user.id, amountWon: 7_000, idempotencyKey: 'http-reward-grant' });
    await f.store.creditSandbox({ userId: alice.user.id, amountWon: 5_000, idempotencyKey: 'http-principal-funding' });
    const before = await f.request('/account', { cookie: alice.cookie });
    assert.equal(before.data.balanceWon, 5_000); assert.equal(before.data.rewards.availableWon, 7_000);
    const denied = await f.request('/transfers', { method: 'POST', cookie: alice.cookie, headers: { 'Idempotency-Key': 'reward-not-cash-001', 'X-Aqua-Account': alice.user.id }, body: { recipientTag: bob.user.tag, amountWon: 6_000 } });
    assert.equal(denied.status, 409); assert.equal(denied.data.error.code, 'INSUFFICIENT_FUNDS');
    for (const path of ['/rewards/grant', '/rewards/budget', '/rewards/program']) {
      assert.equal((await f.request(path, { method: 'POST', cookie: alice.cookie, body: { amountWon: 1_000_000, enabled: true } })).status, 404);
    }
    const cards = new CardPaymentStore(f.database);
    await cards.apply({ kind: 'authorize', eventId: 'http-reward-auth', paymentId: 'http-reward-payment', userId: alice.user.id, amountWon: 10_000, merchantName: '테스트 서점' });
    const held = await f.request('/account', { cookie: alice.cookie });
    assert.equal(held.data.balanceWon, 2_000); assert.equal(held.data.heldBalanceWon, 3_000);
    assert.equal(held.data.rewards.availableWon, 0); assert.equal(held.data.rewards.heldWon, 7_000);
    assert.equal(held.data.cardPayments[0].funding?.rewards.authorizedWon, 7_000);
    assert.equal(held.data.cardPayments[0].funding?.principal.authorizedWon, 3_000);
    assert.equal(held.data.rewards.cashback.pendingWon, 30);
    await cards.apply({ kind: 'capture', eventId: 'http-reward-capture', paymentId: 'http-reward-payment', userId: alice.user.id, amountWon: 10_000, finalCapture: true });
    const captured = await f.request('/account', { cookie: alice.cookie });
    assert.equal(captured.data.balanceWon, 2_000); assert.equal(captured.data.rewards.availableWon, 30);
    assert.equal(captured.data.rewards.heldWon, 0); assert.equal(captured.data.rewards.cashback.confirmedWon, 30);
    assert.equal(captured.data.cardPayments[0].cashback?.awardedWon, 30);
    // Only ten won of company funding remain. An eligible 19-won award cannot be promised in full.
    await cards.apply({ kind: 'authorize', eventId: 'http-budget-short-auth', paymentId: 'http-budget-short', userId: alice.user.id, amountWon: 2_000, merchantName: '테스트 서점' });
    const history = await f.request('/account/activity/cards', { cookie: alice.cookie });
    const limited = history.data.items.find((payment: { id: string }) => payment.id === 'http-budget-short');
    assert.equal(limited.cashback.reason, 'budget_unavailable');
    assert.equal(limited.cashback.pendingWon, 0);
    assert.equal(limited.heldWon, 2_000);
    const other = await f.request(`/account?userId=${alice.user.id}`, { cookie: bob.cookie });
    assert.equal(other.data.rewards.availableWon, 0); assert.deepEqual(other.data.rewards.history, []);
    assert.equal(captured.body.includes('canonical_input'), false);
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

test('an already-issued recovery code can be consumed while new mail issuance is unavailable', async () => {
  const f = await fixture();
  const withoutDelivery = createApiServer(f.store, { allowedOrigins: [ORIGIN], logger: false });
  try {
    await withoutDelivery.ready();
    const account = await f.signup('recovery.outage');
    assert.equal((await f.request('/auth/recovery/request', { method: 'POST', body: { email: account.user.email } })).status, 202);
    assert.equal(f.mail.length, 1);
    const unavailable = await request(withoutDelivery, '/auth/recovery/request', { method: 'POST', body: { email: account.user.email } });
    assert.equal(unavailable.status, 503);
    const reset = await request(withoutDelivery, '/auth/recovery/confirm', {
      method: 'POST', body: { token: f.mail[0].token, password: 'Replacement-outage-42' },
    });
    assert.equal(reset.status, 200, reset.body);
    assert.equal((await f.request('/account', { cookie: account.cookie })).status, 401);
    assert.equal((await request(withoutDelivery, '/auth/recovery/confirm', {
      method: 'POST', body: { token: f.mail[0].token, password: 'Replacement-outage-43' },
    })).status, 400);
  } finally { await withoutDelivery.close(); await f.close(); }
});

test('concurrent HTTP sends cannot spend the same PostgreSQL balance twice', async () => {
  const f = await fixture();
  try {
    const alice = await f.signupForTransactions('sender');
    const bob = await f.signupForTransactions('target');
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

test('Reserve HTTP commands bind to the signed-in account and replay a completed move without moving funds again', async () => {
  const f = await fixture();
  try {
    const member = await f.signup('reservehttp');
    const send = (path: string, body: object, key: string, account = member.user.id) =>
      f.request(path, { method: 'POST', cookie: member.cookie, body,
        headers: { 'Idempotency-Key': key, 'X-Aqua-Account': account } });
    await f.store.creditSandbox({ userId: member.user.id, amountWon: 3_000, idempotencyKey: 'starting-reserve-balance' });
    const deposit = { direction: 'in', amountWon: 1_000 };
    assert.equal((await send('/reserve/movement', deposit, 'pending-approval')).status, 403);
    await approveTestCustomer(f.database, member.user.id);
    assert.equal((await send('/reserve/movement', deposit, 'wrong-account-key', 'stale-owner')).status, 409);
    assert.equal((await send('/reserve/movement', { ...deposit, userId: 'other' }, 'forged-account')).status, 400);
    const moved = await send('/reserve/movement', deposit, 'valid-movement');
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.data, { availableWon: 1_000, autoUse: false, preferenceVersion: 0 });
    assert.deepEqual((await send('/reserve/movement', deposit, 'valid-movement')).data, moved.data);
    assert.equal((await send('/reserve/movement', { ...deposit, amountWon: 900 }, 'valid-movement')).data.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await send('/reserve/preference', { autoUse: true, expectedVersion: 0 }, 'turn-fallback-on')).status, 200);
    const snapshot = (await f.request('/account', { cookie: member.cookie })).data;
    assert.equal(snapshot.balanceWon, 2_000);
    assert.deepEqual(snapshot.reserve, { availableWon: 1_000, autoUse: true, preferenceVersion: 1 });
  } finally { await f.close(); }
});

test('connected funding requires the session owner and recent authentication before holding a withdrawal',async()=>{
  const f=await fixture();
  try {
    const alice=await f.signup('fundingalice'), bob=await f.signup('fundingbob');
    await approveTestCustomer(f.database,alice.user.id);
    await f.store.creditSandbox({userId:alice.user.id,amountWon:20000,idempotencyKey:'funding-http-seed'});
    const post=(body:unknown,key:string,account=alice.user.id)=>f.request('/funding',{method:'POST',body,cookie:alice.cookie,
      headers:{'X-Aqua-Account':account,'Idempotency-Key':key}});
    const quote={action:'quote',direction:'withdrawal',asset:'USDC',network:'polygon',quantity:'14000',destination:'aqua-test:polygon:my-wallet'};
    assert.equal((await f.request('/funding')).status,401);
    assert.equal((await post(quote,'foreign-quote',bob.user.id)).status,409);
    assert.equal((await post({...quote,operator:true},'bad-quote')).status,400);
    const prepared=await post(quote,'prepare-quote');
    assert.equal(prepared.status,200,prepared.body);
    const row=JSON.parse(prepared.body) as {id:string;status:string};
    assert.equal(row.status,'quoted');
    await f.database.query('UPDATE auth_sessions SET reauthenticated_at=NULL WHERE user_id=$1',[alice.user.id]);
    const accept={action:'accept_withdrawal',id:row.id};
    assert.equal((await post(accept,'accept-quote')).data.error.code,'REAUTHENTICATION_REQUIRED');
    assert.equal((await f.request('/auth/reauthenticate',{method:'POST',cookie:alice.cookie,headers:{'X-Aqua-Account':alice.user.id},body:{password:PASSWORD}})).status,200);
    const held=await post(accept,'accept-quote');
    assert.equal(held.status,200,held.body);
    assert.equal(JSON.parse(held.body).status,'held');
    assert.deepEqual((await post(accept,'accept-quote')).data,held.data);
    assert.equal((await f.request('/funding',{cookie:bob.cookie,headers:{'X-Aqua-Account':bob.user.id}})).body,'[]');
    const cancelled=await post({action:'cancel',id:row.id},'cancel-funding');
    assert.equal(JSON.parse(cancelled.body).status,'cancelled');
    assert.equal((await f.store.snapshot(alice.user.id)).balanceWon,20000);
  } finally {await f.close();}
});

test('card decline history binds the owner to the signed-in member and removes internal decision details', async () => {
  const f = await fixture();
  try {
    const alice = await f.signupForTransactions('history.alice');
    const other = await f.signupForTransactions('history.other');
    const card = new IssuerOutboxStore(f.database);
    await card.register({ userId: alice.user.id, providerCardId: 'sandbox-card-private-member', initialStatus: 'active' });
    await new CustomerAccessStore(f.database).transition({ userId:alice.user.id,status:'frozen',expectedVersion:2,
      idempotencyKey:'freeze-for-test',reason:'Sandbox risk investigation case for test.' });
    await f.database.query('SELECT apply_sandbox_card_event($1::jsonb,$2::bigint)',
      [JSON.stringify({kind:'authorize',eventId:'private-event',paymentId:'private-payment',userId:alice.user.id,
        amountWon:50,merchantName:'private-merchant'}), Date.now()]);
    const url='/account/activity/declines';
    assert.equal((await f.request(url)).status,401);
    const mismatched = await f.request(url,{cookie:other.cookie,headers:{'X-Aqua-Account':alice.user.id}});
    assert.notEqual(mismatched.status,200);
    const empty = await f.request(url,{cookie:other.cookie,headers:{'X-Aqua-Account':other.user.id}});
    assert.deepEqual(JSON.parse(empty.body),{items:[],nextCursor:null});
    const own = await f.request(url,{cookie:alice.cookie,headers:{'X-Aqua-Account':alice.user.id}});
    assert.equal(own.status,200);
    const page=JSON.parse(own.body);
    assert.equal(page.items.length,1);
    assert.equal(page.items[0].reason,'unavailable');
    assert.deepEqual(Object.keys(page.items[0]).sort(),['createdAt','id','reason']);
    assert.doesNotMatch(own.body,/frozen|private-|CUSTOMER_ACCESS_REQUIRED|investigation/i);
    assert.deepEqual((await f.request('/account',{cookie:alice.cookie})).data.cardDeclines,page.items);
    assert.equal((await f.request('/account',{cookie:alice.cookie,headers:{'X-Aqua-View':'summary'}})).data.cardDeclines,undefined);
  } finally { await f.close(); }
});
