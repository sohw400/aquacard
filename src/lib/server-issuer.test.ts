import assert from 'node:assert/strict';
import test from 'node:test';
import type { IssuerCardSnapshot } from '../../shared/api';
import { ApiError, api } from '../server/api';
import {
  clearIssuerIntent, issuerIntentPrefix, issuerRequestWasRejected, issuerSnapshotDoesNotRegress,
  newIssuerIntentKey, parseIssuerReceipt, parseIssuerSnapshot, readIssuerIntents, storeIssuerIntent, type IssuerIntent,
} from '../server/issuerIntent';

const CARD = '11111111-1111-4111-8111-111111111111';
const COMMAND = '22222222-2222-4222-8222-222222222222';
const first: IssuerIntent = { key: 'request-1111111111111111', cardId: CARD, targetStatus: 'locked', expectedVersion: 1, createdAt: 1_800_000_000_000 };
const second: IssuerIntent = { ...first, key: 'request-2222222222222222', targetStatus: 'active', createdAt: first.createdAt + 1 };
const keyOf = (owner: string, key = first.key) => issuerIntentPrefix(owner) + key;

function storageFixture() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return { values, storage, close() {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  } };
}

function snapshot(): IssuerCardSnapshot {
  return { mode: 'sandbox', canRequestStatus: true, card: { id: CARD, desiredStatus: 'locked', confirmedStatus: 'active', version: 2,
    updatedAt: first.createdAt, command: { id: COMMAND, status: 'pending', phase: 'send', attemptCount: 0,
      errorCode: null, createdAt: first.createdAt, updatedAt: first.createdAt } } };
}

test('issuer requests survive a new reader without crossing account prefixes or retaining account data', () => {
  const f = storageFixture();
  try {
    storeIssuerIntent('alice', first);
    storeIssuerIntent('alice.other', second);
    assert.deepEqual(readIssuerIntents('alice'), { status: 'ready', intents: [first] });
    assert.deepEqual(readIssuerIntents('alice.other'), { status: 'ready', intents: [second] });
    assert.deepEqual(readIssuerIntents('bob'), { status: 'ready', intents: [] });
    assert.deepEqual(Object.keys(JSON.parse(f.values.get(keyOf('alice'))!)).sort(), ['cardId', 'createdAt', 'expectedVersion', 'key', 'targetStatus']);
    assert.equal([...f.values.values()].some((value) => /alice|balance|cookie|provider|lease/i.test(value)), false);
  } finally { f.close(); }
});

test('concurrent tab requests keep separate keys and a late acknowledgement removes only its own intent', () => {
  const f = storageFixture();
  try {
    storeIssuerIntent('alice', second);
    storeIssuerIntent('alice', first);
    assert.deepEqual(readIssuerIntents('alice'), { status: 'ready', intents: [first, second] });
    clearIssuerIntent('alice', first);
    assert.deepEqual(readIssuerIntents('alice'), { status: 'ready', intents: [second] });
    clearIssuerIntent('alice', first);
    assert.deepEqual(readIssuerIntents('alice'), { status: 'ready', intents: [second] });
    storeIssuerIntent('bob', first);
    clearIssuerIntent('alice', second);
    assert.deepEqual(readIssuerIntents('bob'), { status: 'ready', intents: [first] });
  } finally { f.close(); }
});

test('a changed saved payload cannot be overwritten or removed using an old acknowledgement', () => {
  const f = storageFixture();
  try {
    storeIssuerIntent('alice', first);
    const changed = { ...first, targetStatus: 'active' as const };
    assert.throws(() => storeIssuerIntent('alice', changed), /different issuer request/);
    f.values.set(keyOf('alice'), JSON.stringify(changed));
    assert.throws(() => clearIssuerIntent('alice', first), /changed before acknowledgement/);
    assert.deepEqual(readIssuerIntents('alice'), { status: 'ready', intents: [changed] });
  } finally { f.close(); }
});

test('corrupt or mismatched saved entries fail closed without discarding any record', () => {
  const f = storageFixture();
  try {
    for (const raw of ['{', 'null', '[]', JSON.stringify({ ...first, key: second.key }),
      JSON.stringify({ ...first, targetStatus: ['locked'] }), JSON.stringify({ ...first, expectedVersion: '1' }),
      JSON.stringify({ ...first, expectedVersion: 0 }), JSON.stringify({ ...first, expectedVersion: Number.MAX_SAFE_INTEGER }),
      JSON.stringify({ ...first, cardId: 'not-a-card' }), JSON.stringify({ ...first, createdAt: -1 }),
      JSON.stringify({ ...first, cookie: 'must-not-be-retained' }), 'x'.repeat(1_025)]) {
      f.values.set(keyOf('alice'), raw);
      assert.deepEqual(readIssuerIntents('alice'), { status: 'corrupt', intents: [] });
      assert.equal(f.values.get(keyOf('alice')), raw);
    }
  } finally { f.close(); }
});

test('unavailable storage, unconfirmed writes and failed removals cannot be mistaken for success', () => {
  const f = storageFixture();
  try {
    f.storage.setItem = () => {};
    assert.throws(() => storeIssuerIntent('alice', first), /not persisted/);
    f.values.set(keyOf('alice'), JSON.stringify(first));
    f.storage.removeItem = () => {};
    assert.throws(() => clearIssuerIntent('alice', first), /not persisted/);
    assert.deepEqual(readIssuerIntents('alice'), { status: 'ready', intents: [first] });
    f.storage.getItem = () => { throw new Error('Browser storage denied'); };
    assert.deepEqual(readIssuerIntents('alice'), { status: 'unavailable', intents: [] });
    assert.throws(() => clearIssuerIntent('alice', first), /storage denied/);
    assert.throws(() => storeIssuerIntent('alice', second), /storage denied/);
  } finally { f.close(); }
});

test('request identifiers require a cryptographic browser source', () => {
  const key = newIssuerIntentKey();
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  try { assert.throws(newIssuerIntentKey, /Secure request identifiers/); }
  finally { if (original) Object.defineProperty(globalThis, 'crypto', original); else Reflect.deleteProperty(globalThis, 'crypto'); }
});

test('issuer snapshots require typed capability, identity and state fields before controls can use them', () => {
  assert.deepEqual(parseIssuerSnapshot(snapshot()), snapshot());
  assert.deepEqual(parseIssuerSnapshot({ mode: 'sandbox', canRequestStatus: false, card: null }), { mode: 'sandbox', canRequestStatus: false, card: null });
  const invalid: unknown[] = [null, { ...snapshot(), canRequestStatus: 'true' }, { ...snapshot(), mode: 'production' },
    { ...snapshot(), providerCardId: 'sandbox-card-hidden' }];
  for (const patch of [{ version: 0 }, { confirmedStatus: ['active'] }, { desiredStatus: 'blocked' }, { id: 'not-uuid' },
    { updatedAt: -1 }, { command: null }]) invalid.push({ ...snapshot(), card: { ...snapshot().card, ...patch } });
  for (const patch of [{ status: ['pending'] }, { phase: ['send'] }, { attemptCount: '0' }, { updatedAt: first.createdAt - 1 },
    { errorCode: '<private failure>' }, { status: 'succeeded' }]) invalid.push({ ...snapshot(), card: { ...snapshot().card, command: { ...snapshot().card!.command, ...patch } } });
  for (const value of invalid) assert.throws(() => parseIssuerSnapshot(value), /Invalid issuer card response/);
});

test('acknowledgements correlate the exact card and request version and never imply confirmed state', () => {
  const response = { id: COMMAND, cardId: CARD, status: 'pending', cardVersion: 2, duplicate: false };
  assert.deepEqual(parseIssuerReceipt(response, first), response);
  assert.deepEqual(parseIssuerReceipt({ ...response, duplicate: true }, first), { ...response, duplicate: true });
  for (const patch of [{ cardId: COMMAND }, { cardVersion: 1 }, { cardVersion: 3 }, { cardVersion: '2' }, { status: 'succeeded' },
    { duplicate: 'false' }, { id: 'invalid' }, { providerCardId: 'must-not-leak' }]) {
    assert.throws(() => parseIssuerReceipt({ ...response, ...patch }, first), /Unexpected issuer request acknowledgement/);
  }
});

test('older reads cannot replace newer card state or move a completed command back into processing', () => {
  const pending = snapshot();
  const succeeded = snapshot();
  succeeded.card!.version = 3; succeeded.card!.confirmedStatus = 'locked'; succeeded.card!.updatedAt++;
  succeeded.card!.command!.status = 'succeeded'; succeeded.card!.command!.attemptCount = 1; succeeded.card!.command!.updatedAt++;
  assert.equal(issuerSnapshotDoesNotRegress(pending, succeeded), true);
  assert.equal(issuerSnapshotDoesNotRegress(succeeded, pending), false);
  assert.equal(issuerSnapshotDoesNotRegress(pending, { mode: 'sandbox', canRequestStatus: true, card: null }), false);
  const staleAttempt = structuredClone(succeeded); staleAttempt.card!.command!.attemptCount = 0;
  assert.equal(issuerSnapshotDoesNotRegress(succeeded, staleAttempt), false);
  const staleCommand = structuredClone(succeeded); staleCommand.card!.command!.status = 'in_flight';
  assert.equal(issuerSnapshotDoesNotRegress(succeeded, staleCommand), false);
  const changedWithoutVersion = structuredClone(succeeded); changedWithoutVersion.card!.confirmedStatus = 'active';
  assert.equal(issuerSnapshotDoesNotRegress(succeeded, changedWithoutVersion), false);
  const different = structuredClone(succeeded); different.card!.id = COMMAND;
  assert.equal(issuerSnapshotDoesNotRegress(succeeded, different), false);
});

test('uncertain transport, changed sessions and key conflicts retain the original request', () => {
  for (const issue of [new TypeError('Lost response'), new DOMException('Aborted', 'AbortError'),
    new ApiError(500, 'OUTBOX_PENDING', 'Wrong status'), new ApiError(409, 'SESSION_CHANGED', 'Changed session'),
    new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Request key conflict'), new ApiError(401, 'UNAUTHENTICATED', 'Expired session'),
    new ApiError(429, 'RATE_LIMITED', 'Try later'), new ApiError(404, 'NOT_FOUND', 'Missing route')]) {
    assert.equal(issuerRequestWasRejected(issue), false);
  }
  assert.equal(issuerRequestWasRejected(new ApiError(409, 'OUTBOX_VERSION_CHANGED', 'Changed version')), true);
  assert.equal(issuerRequestWasRejected(new ApiError(409, 'OUTBOX_PENDING', 'Another command')), true);
  assert.equal(issuerRequestWasRejected(new ApiError(404, 'OUTBOX_CARD_NOT_FOUND', 'Missing owned card')), true);
});

test('issuer reads bind the viewed account and retries reuse exactly the original POST body and key', async () => {
  const original = globalThis.fetch;
  const requests: { path: string; options?: RequestInit }[] = [];
  globalThis.fetch = async (input, options) => {
    requests.push({ path: String(input), options });
    return new Response(JSON.stringify(options?.method === 'POST'
      ? { id: COMMAND, cardId: CARD, status: 'pending', cardVersion: 2, duplicate: true } : snapshot()), { status: options?.method === 'POST' ? 202 : 200 });
  };
  try {
    await api.issuerCard('alice');
    const body = { cardId: first.cardId, targetStatus: first.targetStatus, expectedVersion: first.expectedVersion };
    await api.issuerCardStatus(body, first.key, 'alice');
    await api.issuerCardStatus(body, first.key, 'alice');
    assert.equal(new Headers(requests[0].options?.headers).get('X-Aqua-Account'), 'alice');
    assert.equal(requests[0].path, '/api/issuer-card');
    for (const request of requests.slice(1)) {
      assert.equal(new Headers(request.options?.headers).get('X-Aqua-Account'), 'alice');
      assert.equal(new Headers(request.options?.headers).get('Idempotency-Key'), first.key);
      assert.equal(request.options?.credentials, 'same-origin');
      assert.equal(request.options?.cache, 'no-store');
      assert.deepEqual(JSON.parse(request.options?.body as string), body);
      assert.equal(request.path, '/api/issuer-card/status');
    }
  } finally { globalThis.fetch = original; }
});

test('issuer clients refuse unexpected successful HTTP statuses instead of clearing saved requests', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: COMMAND, cardId: CARD, status: 'pending', cardVersion: 2, duplicate: false }), { status: 200 });
  try {
    await assert.rejects(api.issuerCardStatus({ cardId: CARD, targetStatus: 'locked', expectedVersion: 1 }, first.key, 'alice'), /응답 형식/);
  } finally { globalThis.fetch = original; }
});
