import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Database } from './database';
import { LedgerStore } from './ledger';
import { createTestDatabase } from './test-support';
import { AuthMailOutbox, PostgresAuthMailQueue, authMailKeyringFromEnvironment, decryptAuthMail,
  type AuthMailMessage, type AuthMailKeyring, type AuthMailClaim } from './auth-mail';
import { dispatchAuthMailOnce } from './auth-mail-dispatch';
import { createFileAuthMailTransport, createSesAuthMailTransport, authMailTransportFromEnvironment, AuthMailTransportError } from './auth-mail-transport';
import { grantApplicationRole, grantAuthMailRole, verifyApplicationRole, verifyAuthMailRole } from './permissions';

const NOW = Date.UTC(2026, 10, 26, 5);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function keys(id = 'current'): AuthMailKeyring { return { activeKeyId: id, keys: new Map([[id, randomBytes(32)]]) }; }
async function fixture(t: TestContext) {
  const base = await createTestDatabase();
  const store = new LedgerStore(base.database);
  let now = NOW;
  const keyring = keys();
  const queue = new PostgresAuthMailQueue(base.schema, keyring);
  const outbox = new AuthMailOutbox(base.database, () => now);
  await store.createUser({ id: 'mail-alice', email: 'mail-alice@example.test', name: '메일 테스트', tag: 'mail.alice', passwordHash: 'test-password-hash', createdAt: NOW });
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => { try { for (const action of cleanup.reverse()) await action(); } finally { await base.cleanup(); } });
  async function issue(purpose: AuthMailMessage['purpose'] = 'password-recovery', options: { fail?: boolean; message?: AuthMailMessage } = {}) {
    const message = options.message ?? { purpose, userId: 'mail-alice', email: 'mail-alice@example.test', token: randomBytes(32).toString('hex'), createdAt: now, expiresAt: now + 900_000 };
    await base.database.transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [message.userId]);
      const table = purpose === 'password-recovery' ? 'auth_recovery' : 'auth_email_verification';
      await client.query(`DELETE FROM ${table} WHERE user_id=$1`, [message.userId]);
      if (purpose === 'password-recovery') await client.query('INSERT INTO auth_recovery(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)', [digest(message.token), message.userId, message.createdAt, message.expiresAt]);
      else await client.query('INSERT INTO auth_email_verification(token_hash,user_id,email,created_at,expires_at) VALUES($1,$2,$3,$4,$5)', [digest(message.token), message.userId, message.email, message.createdAt, message.expiresAt]);
      await queue.enqueue(client, message);
      if (options.fail) throw new Error('simulated atomicity failure');
    });
    return message;
  }
  return { ...base, keyring, queue, outbox, issue, defer(action: () => Promise<void>) { cleanup.push(action); }, now: () => now, advance(ms: number) { now += ms; } };
}
function finish(claim: AuthMailClaim, outcome: 'sent' | 'retry' | 'failed' = 'sent') {
  return { id: claim.id, leaseToken: claim.leaseToken, expectedVersion: claim.version, outcome,
    errorCode: outcome === 'sent' ? null : 'DELIVERY_UNAVAILABLE' as const };
}

test('challenge and encrypted delivery commit atomically and terminal acceptance scrubs ciphertext', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.issue('password-recovery', { fail: true }), /atomicity/);
  assert.equal((await f.database.query('SELECT count(*) FROM auth_recovery')).rows[0].count, '0');
  assert.equal((await f.outbox.stats()).pending, '0');
  const message = await f.issue();
  const stored = (await f.database.query('SELECT * FROM auth_mail_outbox')).rows[0];
  assert.ok(!JSON.stringify(stored).includes(message.token));
  assert.ok(!JSON.stringify(stored).includes(message.email));
  const claim = await f.outbox.claim(); assert.ok(claim);
  assert.deepEqual(decryptAuthMail(f.schema, claim, f.keyring), message);
  const sent = await f.outbox.finish(finish(claim));
  assert.equal(sent.status, 'sent');
  assert.deepEqual(await f.outbox.finish(finish(claim)), sent);
  assert.equal(await f.outbox.claim(), null);
  const final = (await f.database.query('SELECT key_id,iv,auth_tag,ciphertext FROM auth_mail_outbox')).rows[0];
  assert.deepEqual(final, { key_id: null, iv: null, auth_tag: null, ciphertext: null });
  assert.equal((await f.database.query('SELECT count(*) FROM auth_mail_attempts')).rows[0].count, '3');
  await assert.rejects(f.database.query('UPDATE auth_mail_attempts SET status=$1', ['forged']), /immutable/);
});

test('claimed messages cannot be stolen and lease recovery fences stale completions', async (t) => {
  const f = await fixture(t);
  await f.issue();
  const peer = new Database({ connectionString: f.connectionString, schema: f.schema });
  f.defer(() => peer.close());
  const other = new AuthMailOutbox(peer, f.now);
  const claims = await Promise.all([f.outbox.claim(), other.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean)!;
  f.advance(30_001);
  const second = await other.claim(); assert.ok(second);
  assert.equal(first.id, second.id); assert.notEqual(first.leaseToken, second.leaseToken);
  assert.equal(second.attemptCount, 2);
  await assert.rejects(f.outbox.finish(finish(first)), /AUTH_MAIL_LEASE_LOST/);
  await other.finish(finish(second));
  assert.equal((await f.outbox.stats()).sent, '1');
  await assert.rejects(other.finish({ ...finish(second), outcome: 'retry', errorCode: 'DELIVERY_UNAVAILABLE' }), /AUTH_MAIL_COMPLETION_CONFLICT/);
});

test('used, superseded, expired and already verified challenges are discarded without transport', async (t) => {
  const f = await fixture(t);
  await f.issue(); f.advance(1); await f.issue();
  let claim = await f.outbox.claim(); assert.ok(claim);
  assert.equal((await f.outbox.stats()).discarded, '1');
  await f.database.query('DELETE FROM auth_recovery');
  f.advance(30_001);
  assert.equal(await f.outbox.claim(), null);
  await f.issue('email-verification');
  await f.database.query('UPDATE users SET email_verified_at=$1 WHERE id=$2', [f.now(), 'mail-alice']);
  assert.equal(await f.outbox.claim(), null);
  await f.issue(); f.advance(900_001);
  assert.equal(await f.outbox.claim(), null);
  assert.equal((await f.outbox.stats()).discarded, '4');
  assert.equal((await f.database.query('SELECT count(*) FROM auth_mail_outbox WHERE ciphertext IS NOT NULL')).rows[0].count, '0');
});

test('transport uncertainty retries the same token and exhausted attempts become a bounded final outcome', async (t) => {
  const f = await fixture(t);
  const message = await f.issue();
  const observed: string[] = [];
  const transport = { async send(_id: string, delivered: AuthMailMessage) { observed.push(delivered.token); throw new Error('Private email or provider detail must not escape'); } };
  const signal = new AbortController().signal;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await dispatchAuthMailOnce(f.outbox, transport, f.schema, f.keyring, signal, f.now);
    assert.equal(result?.status, attempt === 5 ? 'failed' : 'retry');
    assert.equal(result?.errorCode, attempt === 5 ? 'ATTEMPTS_EXHAUSTED' : 'DELIVERY_UNAVAILABLE');
    f.advance([1000, 5000, 15000, 60000, 0][attempt - 1]);
  }
  assert.deepEqual(observed, Array(5).fill(message.token));
  assert.equal(await f.outbox.claim(), null);
  assert.equal((await f.database.query('SELECT ciphertext FROM auth_mail_outbox')).rows[0].ciphertext, null);
});

test('AEAD binds schema, purpose and message identity and retains old decryption keys during rotation', async (t) => {
  const f = await fixture(t); await f.issue('email-verification');
  const claim = await f.outbox.claim(); assert.ok(claim);
  const rotated = keys('next');
  const joined = { activeKeyId: 'next', keys: new Map([...f.keyring.keys, ...rotated.keys]) };
  assert.equal(decryptAuthMail(f.schema, claim, joined).purpose, 'email-verification');
  for (const changed of [{ ...claim, id: randomUUID() }, { ...claim, purpose: 'password-recovery' as const },
    { ...claim, tokenHash: '0'.repeat(64) }, { ...claim, userId: 'different-user' }, { ...claim, ciphertext: (claim.ciphertext.startsWith('00') ? '01' : '00') + claim.ciphertext.slice(2) }]) {
    assert.throws(() => decryptAuthMail(f.schema, changed, joined), /unavailable/);
  }
  assert.throws(() => decryptAuthMail('another_schema', claim, joined), /unavailable/);
  assert.throws(() => decryptAuthMail(f.schema, claim, rotated), /unavailable/);
});

test('a temporarily missing rotation key retains ciphertext and recovers without consuming provider attempts', async (t) => {
  const f = await fixture(t); await f.issue();
  let calls = 0;
  const result = await dispatchAuthMailOnce(f.outbox, { async send() { calls++; } }, f.schema, keys('unknown'), new AbortController().signal, f.now);
  assert.equal(calls, 0); assert.equal(result?.status, 'retry'); assert.equal(result.errorCode, 'KEY_UNAVAILABLE');
  assert.ok((await f.database.query('SELECT ciphertext FROM auth_mail_outbox')).rows[0].ciphertext);
  for (let retry = 0; retry < 6; retry++) {
    f.advance(30000);
    const waiting = await dispatchAuthMailOnce(f.outbox, { async send() { calls++; } }, f.schema, keys('unknown'), new AbortController().signal, f.now);
    assert.equal(waiting?.status, 'retry'); assert.equal(waiting.attemptCount, 0);
  }
  assert.equal(calls, 0);
  f.advance(30000);
  const recovered = await dispatchAuthMailOnce(f.outbox, { async send() { calls++; } }, f.schema, f.keyring, new AbortController().signal, f.now);
  assert.equal(calls, 1); assert.equal(recovered?.status, 'sent');
});

test('a restored key followed by worker crashes still exhausts the bounded provider attempts', async (t) => {
  const f = await fixture(t); await f.issue();
  const blocked = await dispatchAuthMailOnce(f.outbox, { async send() { throw new Error('must not send'); } }, f.schema, keys('missing'), new AbortController().signal, f.now);
  assert.equal(blocked?.attemptCount, 0);
  f.advance(30000);
  // Model restored-key sends followed by crashes before an outcome can commit.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const claim = await f.outbox.claim(); assert.ok(claim);
    assert.equal(claim.attemptCount, attempt);
    assert.equal(decryptAuthMail(f.schema, claim, f.keyring).purpose, 'password-recovery');
    f.advance(30001);
  }
  assert.equal(await f.outbox.claim(), null);
  assert.equal((await f.outbox.stats()).failed, '1');
  assert.equal((await f.database.query('SELECT error_code FROM auth_mail_outbox')).rows[0].error_code, 'ATTEMPTS_EXHAUSTED');
});

test('shutdown during a transport that ignores abort leaves a retry instead of hanging the worker', async (t) => {
  const f = await fixture(t); await f.issue();
  const stop = new AbortController();
  const result = await dispatchAuthMailOnce(f.outbox, { async send() { stop.abort(); await new Promise(() => {}); } }, f.schema, f.keyring, stop.signal, f.now);
  assert.equal(result?.status, 'retry'); assert.equal(result.errorCode, 'DELIVERY_UNAVAILABLE');
  assert.ok((await f.database.query('SELECT ciphertext FROM auth_mail_outbox')).rows[0].ciphertext);
});

test('runtime only enqueues and the mail worker only claims, finishes and reads aggregate health', async (t) => {
  const f = await fixture(t);
  const suffix = randomBytes(6).toString('hex');
  const roles = [`test_mail_api_${suffix}`, `test_mail_worker_${suffix}`];
  const peers: Database[] = [];
  f.defer(async () => {
    for (const peer of peers) await peer.close();
    for (const role of roles) { await f.database.query(`DROP OWNED BY "${role}"`); await f.database.query(`DROP ROLE "${role}"`); }
  });
  for (const role of roles) {
    const password = randomBytes(20).toString('hex');
    await f.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const url = new URL(f.connectionString); url.username = role; url.password = password;
    peers.push(new Database({ connectionString: url.toString(), schema: f.schema }));
  }
  await grantApplicationRole(f.database, roles[0]); await grantAuthMailRole(f.database, roles[1]);
  await verifyApplicationRole(peers[0]); await verifyAuthMailRole(peers[1]);
  const [api, worker] = peers;
  for (const table of ['auth_mail_outbox', 'auth_mail_attempts']) {
    await assert.rejects(api.query(`SELECT * FROM ${table}`), /permission denied/);
    await assert.rejects(worker.query(`SELECT * FROM ${table}`), /permission denied/);
    await assert.rejects(api.query(`DELETE FROM ${table}`), /permission denied/);
  }
  await assert.rejects(api.query('SELECT claim_auth_mail($1)', [NOW]), /permission denied/);
  await assert.rejects(worker.query("SELECT enqueue_auth_mail('{}'::jsonb)"), /permission denied/);
  await assert.rejects(worker.query('SELECT * FROM auth_recovery'), /permission denied/);
  await f.issue();
  const outbox = new AuthMailOutbox(worker, f.now);
  const claim = await outbox.claim(); assert.ok(claim); await outbox.finish(finish(claim));
  await f.database.query(`GRANT SELECT ON auth_mail_outbox TO "${roles[1]}"`);
  await assert.rejects(verifyAuthMailRole(worker));
});

test('mail keys are explicit, canonical and support rotation without accepting malformed secrets', () => {
  assert.equal(authMailKeyringFromEnvironment({}), undefined);
  const encoded = randomBytes(32).toString('base64');
  assert.equal(authMailKeyringFromEnvironment({ AQUA_AUTH_MAIL_KEYS: JSON.stringify({ current: encoded }), AQUA_AUTH_MAIL_ACTIVE_KEY: 'current' })?.keys.size, 1);
  for (const environment of [{ AQUA_AUTH_MAIL_ACTIVE_KEY: 'current' },
    { AQUA_AUTH_MAIL_KEYS: '{"current":"bad"}', AQUA_AUTH_MAIL_ACTIVE_KEY: 'current' },
    { AQUA_AUTH_MAIL_KEYS: JSON.stringify({ current: encoded }), AQUA_AUTH_MAIL_ACTIVE_KEY: 'missing' }]) {
    assert.throws(() => authMailKeyringFromEnvironment(environment));
  }
});

test('SES uses the verified sender, purpose-specific plaintext and the caller abort signal without exposing provider failures', async () => {
  const message: AuthMailMessage = { purpose: 'email-verification', userId: 'mail-user', email: 'user@example.test', token: 'a'.repeat(64), createdAt: NOW, expiresAt: NOW + 900_000 };
  const signal = new AbortController().signal;
  const id = randomUUID();
  const adapter = createSesAuthMailTransport({ region: 'ap-northeast-2', from: 'security@example.test', send: async (input, actualSignal) => {
    assert.equal(actualSignal, signal); assert.equal(input.FromEmailAddress, 'security@example.test');
    assert.deepEqual(input.Destination?.ToAddresses, [message.email]);
    assert.equal(input.Content?.Simple?.Subject?.Data, 'Aqua 이메일 주소 확인');
    assert.ok(input.Content?.Simple?.Body?.Text?.Data?.includes(message.token));
    assert.equal(input.EmailTags?.[0].Value, id);
    throw Object.assign(new Error('secret provider payload'), { name: 'MessageRejected' });
  } });
  await assert.rejects(adapter.send(id, message, signal), (error: unknown) => error instanceof AuthMailTransportError && error.permanent && !error.message.includes('secret'));
  assert.throws(() => createSesAuthMailTransport({ region: 'http://localhost', from: 'security@example.test' }));
  assert.throws(() => createSesAuthMailTransport({ region: 'ap-northeast-2', from: 'security@example.test\r\nBcc:other@example.test' }));
});

test('file delivery is private, idempotent and never selected as a production fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aqua-mail-test-'));
  try {
    const adapter = await createFileAuthMailTransport(directory);
    const message: AuthMailMessage = { purpose: 'password-recovery', userId: 'mail-user', email: 'user@example.test', token: 'b'.repeat(64), createdAt: NOW, expiresAt: NOW + 900_000 };
    const id = randomUUID(), signal = new AbortController().signal;
    await adapter.send(id, message, signal); await adapter.send(id, message, signal);
    const files = await readdir(directory); assert.equal(files.length, 1);
    const file = join(directory, files[0]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).token, message.token);
    await assert.rejects(adapter.send(id, { ...message, token: 'c'.repeat(64) }, signal));
    await assert.rejects(authMailTransportFromEnvironment({ NODE_ENV: 'production', AQUA_AUTH_MAIL_TRANSPORT: 'file', AQUA_MAIL_DIR: directory }), /disabled/);
    await assert.rejects(authMailTransportFromEnvironment({ NODE_ENV: 'production' }), /explicit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
