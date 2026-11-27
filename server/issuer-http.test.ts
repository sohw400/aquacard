import type { CardApplication, CardApplicationSnapshot } from '../shared/api';
import { CardApplicationStore } from './card-applications';
import { approveTestCustomer } from './test-customer-access';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ApiErrorBody, IssuerCardSnapshot, IssuerCardStatusReceipt, MemberProfile } from '../shared/api';
import { createApiServer } from './http';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerStore } from './ledger';
import { createTestDatabase } from './test-support';

const ORIGIN = 'http://localhost:5173';
type MemberSession = { user: MemberProfile; cookie: string };
type RequestOptions = { method?: 'GET' | 'POST'; body?: unknown; cookie?: string; headers?: Record<string, string> };

async function request<T = ApiErrorBody>(server: FastifyInstance, path: string, options: RequestOptions = {}) {
  const response = await server.inject({
    method: options.method ?? 'GET', url: `/api${path}`, remoteAddress: '127.0.0.1',
    headers: { origin: ORIGIN, ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  });
  const setCookie = response.headers['set-cookie'];
  return { status: response.statusCode, data: response.json<T>(), body: response.body, headers: response.headers,
    cookie: (typeof setCookie === 'string' ? setCookie : setCookie?.[0])?.split(';')[0] ?? '' };
}

async function fixture(t: TestContext, production = false) {
  const base = await createTestDatabase();
  const ledger = new LedgerStore(base.database);
  const issuer = new IssuerOutboxStore(base.database);
  const environment = process.env.NODE_ENV;
  let server: FastifyInstance;
  try {
    if (production) process.env.NODE_ENV = 'production';
    server = createApiServer(ledger, { allowedOrigins: [ORIGIN], logger: false });
  } finally {
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
  }
  t.after(async () => { try { await server.close(); } finally { await base.cleanup(); } });
  await server.ready();
  const signup = async (tag: string): Promise<MemberSession> => {
    const response = await request<{ user: MemberProfile }>(server, '/auth/signup', { method: 'POST',
      body: { email: `${tag}@example.test`, name: '상태 동기화 테스트', tag, password: 'Aqua-test-password-42' } });
    assert.equal(response.status, 201, response.body);
    return { user: response.data.user, cookie: response.cookie };
  };
  const registerApproved = async (session: MemberSession) => {
    await approveTestCustomer(base.database, session.user.id);
    return issuer.register({ userId: session.user.id,
      providerCardId: `sandbox-card-${session.user.tag}`, initialStatus: 'active' });
  };
  return { ...base, server, ledger, issuer, signup, registerApproved,
    request: <T = ApiErrorBody>(path: string, options?: RequestOptions) => request<T>(server, path, options) };
}

function command(session: MemberSession, cardId: string, key = 'issuer-request-0001', expectedVersion = 1): RequestOptions {
  return { method: 'POST', cookie: session.cookie,
    headers: { 'x-aqua-account': session.user.id, 'idempotency-key': key },
    body: { cardId, targetStatus: 'locked', expectedVersion } };
}

function viewing(session: MemberSession): RequestOptions {
  return { cookie: session.cookie, headers: { 'x-aqua-account': session.user.id } };
}

test('issuer snapshots are session-owned and omit partner references and internal delivery credentials', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/issuer-card')).status, 401);
  const alice = await f.signup('issueralice'); const bob = await f.signup('issuerbobby');
  const empty = await f.request<IssuerCardSnapshot>('/issuer-card', viewing(alice));
  assert.deepEqual(empty.data, { mode: 'sandbox', canRequestStatus: true, card: null });
  const { cardId } = await f.registerApproved(alice); const other = await f.registerApproved(bob);
  const own = await f.request<IssuerCardSnapshot>(`/issuer-card?userId=${bob.user.id}&cardId=${other.cardId}`, viewing(alice));
  assert.equal(own.status, 200); assert.equal(own.headers['cache-control'], 'no-store');
  assert.equal(own.data.canRequestStatus, true);
  assert.equal(own.data.card?.id, cardId);
  assert.deepEqual([own.data.card?.desiredStatus, own.data.card?.confirmedStatus, own.data.card?.command], ['active', 'active', null]);
  assert.equal((await f.request<IssuerCardSnapshot>('/issuer-card', viewing(bob))).data.card?.id, other.cardId);
  for (const hidden of ['providerCardId', 'sandbox-card-', 'requestKey', 'leaseToken', 'leaseUntil', 'canonical_input', bob.user.id]) assert.equal(own.body.includes(hidden), false, hidden);
});

test('issuer reads reject a changed shared cookie or absent account header without exposing either card', async (t) => {
  const f = await fixture(t); const alice = await f.signup('issuerreadalice'); const bob = await f.signup('issuerreadbobby');
  const own = await f.registerApproved(alice); const other = await f.registerApproved(bob);
  const before = await f.request<IssuerCardSnapshot>('/issuer-card', viewing(alice));
  assert.equal(before.status, 200); assert.equal(before.data.card?.id, own.cardId);
  for (const options of [
    { ...viewing(alice), cookie: bob.cookie },
    { cookie: alice.cookie },
    { cookie: bob.cookie, headers: { 'x-aqua-account': '' } },
  ]) {
    const denied = await f.request('/issuer-card', options);
    assert.equal(denied.status, 409, denied.body);
    assert.equal(denied.data.error.code, 'SESSION_CHANGED');
    assert.equal(denied.headers['cache-control'], 'no-store');
    for (const hidden of [own.cardId, other.cardId, 'desiredStatus', 'confirmedStatus', 'sandbox-card-']) assert.equal(denied.body.includes(hidden), false, hidden);
  }
  const after = await f.request<IssuerCardSnapshot>('/issuer-card', viewing(bob));
  assert.equal(after.status, 200); assert.equal(after.data.card?.id, other.cardId);
});

test('202 only accepts the desired status; issuer confirmation is separate and the financial ledger is unchanged', async (t) => {
  const f = await fixture(t); const alice = await f.signup('issuerstatus');
  const { cardId } = await f.registerApproved(alice);
  const before = await f.ledger.snapshot(alice.user.id);
  const options = command(alice, cardId);
  const accepted = await f.request<IssuerCardStatusReceipt>('/issuer-card/status', options);
  assert.equal(accepted.status, 202, accepted.body); assert.equal(accepted.data.status, 'pending'); assert.equal(accepted.data.duplicate, false);
  const waiting = await f.request<IssuerCardSnapshot>('/issuer-card', viewing(alice));
  assert.equal(waiting.data.card?.desiredStatus, 'locked'); assert.equal(waiting.data.card?.confirmedStatus, 'active');
  assert.equal(waiting.data.card?.command?.id, accepted.data.id); assert.equal(waiting.data.card?.command?.status, 'pending');
  assert.equal(waiting.data.card?.version, accepted.data.cardVersion);
  for (const hidden of ['providerCardId', 'sandbox-card-', 'requestKey', 'leaseToken', 'leaseUntil', 'canonical_input']) assert.equal(waiting.body.includes(hidden), false, hidden);
  const duplicate = await f.request<IssuerCardStatusReceipt>('/issuer-card/status', options);
  assert.equal(duplicate.status, 202); assert.deepEqual(duplicate.data, { ...accepted.data, duplicate: true });
  const changed = await f.request('/issuer-card/status', { ...options, body: { cardId, targetStatus: 'active', expectedVersion: 1 } });
  assert.equal(changed.status, 409); assert.equal(changed.data.error.code, 'IDEMPOTENCY_CONFLICT');
  const blocked = await f.request('/issuer-card/status', { ...command(alice, cardId, 'issuer-opposite-0001', accepted.data.cardVersion),
    body: { cardId, targetStatus: 'active', expectedVersion: accepted.data.cardVersion } });
  assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OUTBOX_PENDING');
  const claim = await f.issuer.claim(); assert.ok(claim);
  assert.equal((await f.request<IssuerCardSnapshot>('/issuer-card', viewing(alice))).data.card?.confirmedStatus, 'active');
  await f.issuer.finish({ id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version, outcome: { kind: 'succeeded' } });
  const confirmed = await f.request<IssuerCardSnapshot>('/issuer-card', viewing(alice));
  assert.equal(confirmed.data.card?.confirmedStatus, 'locked'); assert.equal(confirmed.data.card?.command?.status, 'succeeded');
  assert.deepEqual(await f.ledger.snapshot(alice.user.id), before);
  const stale = await f.request('/issuer-card/status', command(alice, cardId, 'issuer-stale-0001', accepted.data.cardVersion));
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'OUTBOX_VERSION_CHANGED');
  const replay = await f.request<IssuerCardStatusReceipt>('/issuer-card/status', options);
  assert.equal(replay.status, 202); assert.equal(replay.data.id, accepted.data.id); assert.equal(replay.data.duplicate, true);
  assert.equal((await f.request<IssuerCardSnapshot>('/issuer-card', viewing(alice))).data.card?.confirmedStatus, 'locked');
});

test('issuer commands require the matching session, allowed origin and owned card', async (t) => {
  const f = await fixture(t); const alice = await f.signup('issuerauth'); const bob = await f.signup('issuerother');
  const { cardId } = await f.registerApproved(alice); const other = await f.registerApproved(bob);
  const options = command(alice, cardId);
  assert.equal((await f.request('/issuer-card/status', { ...options, cookie: '' })).status, 401);
  const origin = await f.request('/issuer-card/status', { ...options, headers: { ...options.headers, origin: 'https://untrusted.example' } });
  assert.equal(origin.status, 403); assert.equal(origin.data.error.code, 'ORIGIN_REJECTED');
  const switched = await f.request('/issuer-card/status', { ...options, cookie: bob.cookie });
  assert.equal(switched.status, 409); assert.equal(switched.data.error.code, 'SESSION_CHANGED');
  const absentHeader = await f.request('/issuer-card/status', { ...options, headers: { 'idempotency-key': 'issuer-no-owner-001' } });
  assert.equal(absentHeader.status, 409); assert.equal(absentHeader.data.error.code, 'SESSION_CHANGED');
  const ownership = await f.request('/issuer-card/status', command(alice, other.cardId));
  assert.equal(ownership.status, 404); assert.equal(ownership.data.error.code, 'OUTBOX_CARD_NOT_FOUND');
  assert.equal((await f.request<IssuerCardSnapshot>('/issuer-card', viewing(bob))).data.card?.command, null);
  assert.equal((await f.request<IssuerCardSnapshot>('/issuer-card', viewing(alice))).data.card?.command, null);
});

test('issuer status input rejects extra identities, provider data, invalid versions and missing request keys', async (t) => {
  const f = await fixture(t); const alice = await f.signup('issuerinput'); const { cardId } = await f.registerApproved(alice);
  const options = command(alice, cardId);
  for (const [key, value] of Object.entries({ userId: 'another-user', providerCardId: 'sandbox-card-other', url: 'https://example.test', leaseToken: 'caller-token', confirmedStatus: 'locked', expectedUserId: alice.user.id })) {
    const response = await f.request('/issuer-card/status', { ...options, body: { cardId, targetStatus: 'locked', expectedVersion: 1, [key]: value } });
    assert.equal(response.status, 400, key); assert.equal(response.data.error.code, 'INVALID_INPUT');
  }
  for (const body of [null, [], 'locked', { cardId, targetStatus: 'closed', expectedVersion: 1 },
    { cardId, targetStatus: 'locked', expectedVersion: '1' }, { cardId, targetStatus: 'locked', expectedVersion: 0 },
    { cardId, targetStatus: 'locked', expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { cardId: 'not-a-card', targetStatus: 'locked', expectedVersion: 1 }]) {
    assert.equal((await f.request('/issuer-card/status', { ...options, body })).status, 400, JSON.stringify(body));
  }
  const missingKey = await f.request('/issuer-card/status', { ...options, headers: { 'x-aqua-account': alice.user.id } });
  assert.equal(missingKey.status, 400); assert.equal(missingKey.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await f.request<IssuerCardSnapshot>('/issuer-card', viewing(alice))).data.card?.command, null);
});

test('issuer command rate limiting isolates members and duplicate requests do not create more commands', async (t) => {
  const f = await fixture(t); const alice = await f.signup('issuerrate'); const { cardId } = await f.registerApproved(alice);
  const options = command(alice, cardId);
  for (let index = 0; index < 20; index++) assert.equal((await f.request('/issuer-card/status', options)).status, 202);
  const limited = await f.request('/issuer-card/status', options);
  assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '60');
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM issuer_outbox')).rows[0].count, 1);
  const bob = await f.signup('issuerrateother'); const other = await f.registerApproved(bob);
  assert.equal((await f.request('/issuer-card/status', command(bob, other.cardId))).status, 202);
});

test('production API refuses sandbox issuer writes while preserving safe status inspection', async (t) => {
  const f = await fixture(t, true); const alice = await f.signup('issuerprod'); const { cardId } = await f.registerApproved(alice);
  const denied = await f.request('/issuer-card/status', command(alice, cardId));
  assert.equal(denied.status, 403); assert.equal(denied.data.error.code, 'SANDBOX_DISABLED');
  const snapshot = await f.request<IssuerCardSnapshot>('/issuer-card', viewing(alice));
  assert.equal(snapshot.status, 200); assert.equal(snapshot.data.mode, 'sandbox'); assert.equal(snapshot.data.canRequestStatus, false); assert.equal(snapshot.data.card?.command, null);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS count FROM issuer_outbox')).rows[0].count, 0);
});


test('card application routes bind changes to the signed-in member; only the separate provider and eventual member activation can issue a card', async t => {
  const f = await fixture(t);
  const alice = await f.signup('newcardalice');
  const bob = await f.signup('newcardbobby');
  const submit = (member: MemberSession, body: unknown, key = 'new-application') => ({
    method:'POST' as const, cookie:member.cookie, body,
    headers:{'x-aqua-account':member.user.id,'idempotency-key':key},
  });
  const before = await f.request<CardApplicationSnapshot>('/card-application',viewing(alice));
  assert.deepEqual(before.data,{application:null,canApply:false,canActivate:false});
  await approveTestCustomer(f.database,alice.user.id);
  assert.equal((await f.request<CardApplicationSnapshot>('/card-application',viewing(alice))).data.canApply,true);
  const forged = await f.request('/card-application',submit(alice,{form:'virtual',userId:bob.user.id}));
  assert.equal(forged.status,400);
  const requested = await f.request<CardApplication>('/card-application',submit(alice,{form:'virtual'}));
  assert.equal(requested.status,201,requested.body);
  assert.equal(requested.data.status,'submitted');
  assert.deepEqual((await f.request<CardApplication>('/card-application',submit(alice,{form:'virtual'}))).data,requested.data);
  assert.deepEqual((await f.request<CardApplicationSnapshot>('/card-application',viewing(bob))).data.application,null);
  const issuer = new CardApplicationStore(f.database);
  for (const [index, action] of (['approve','issue'] as const).entries()) {
    await issuer.providerEvent({action,applicationId:requested.data.id,eventId:action,expectedVersion:index+1});
  }
  const body = {applicationId:requested.data.id,expectedVersion:3};
  assert.equal((await f.request('/card-application/activate',submit(bob,body,'wrong-member'))).status,404);
  const activated = await f.request<CardApplication>('/card-application/activate',submit(alice,body,'activate-member'));
  assert.equal(activated.status,200,activated.body);
  assert.equal(activated.data.status,'active');
});

test('the production HTTP mode exposes status with both sandbox application actions disabled', async t => {
  const f=await fixture(t,true);
  const alice=await f.signup('readonlycard');
  await approveTestCustomer(f.database,alice.user.id);
  const read = await f.request<CardApplicationSnapshot>('/card-application',viewing(alice));
  assert.deepEqual(read.data,{application:null,canApply:false,canActivate:false});
  const attempted=await f.request('/card-application',{method:'POST',cookie:alice.cookie,body:{form:'virtual'},
    headers:{'x-aqua-account':alice.user.id,'idempotency-key':'blocked-attempt'}});
  assert.equal(attempted.status,403);
});
