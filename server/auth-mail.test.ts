import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
import { parseAuthMailFeedback, recordAuthMailFeedback } from './auth-mail-feedback';
import { grantApplicationRole, grantAuthMailFeedbackRole, grantAuthMailRole, verifyApplicationRole, verifyAuthMailFeedbackRole, verifyAuthMailRole } from './permissions';

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

const address = 'mail-alice@example.test';
function bounce(mailId: string, eventId: string, bounceType: 'Permanent' | 'Transient', recipient = address) {
  return { eventType: 'Bounce', mail: { tags: { 'aqua-message': [mailId] }, destination: [recipient] },
    bounce: { feedbackId: eventId, bounceType, bouncedRecipients: [{ emailAddress: recipient, diagnosticCode: 'private diagnostic' }] } };
}
function complaint(mailId: string, eventId: string, complaintFeedbackType: string) {
  return { eventType: 'Complaint', mail: { tags: { 'aqua-message': [mailId] }, destination: [address] },
    complaint: { feedbackId: eventId, complaintFeedbackType, complainedRecipients: [{ emailAddress: address }] } };
}

test('SES feedback matches exactly one tagged message and recipient without retaining the provider envelope', () => {
  const mailId = randomUUID();
  const event = bounce(mailId, 'provider-event:1', 'Permanent', address.toUpperCase());
  assert.deepEqual(parseAuthMailFeedback(event), {
    eventId: event.bounce.feedbackId, mailId, kind: 'permanent_bounce', recipientHash: digest(address),
  });
  for (const invalid of [
    { ...event, eventType: 'Delivery' },
    { ...event, mail: { ...event.mail, tags: {} } },
    { ...event, mail: { ...event.mail, destination: [address, 'other@example.test'] } },
    { ...event, mail: { ...event.mail, destination: ['other@example.test'] } },
    { ...event, bounce: { ...event.bounce, bouncedRecipients: [] } },
    { ...event, bounce: { ...event.bounce, feedbackId: 'private@example.test' } },
    complaint(mailId, 'complaint-1', 'unknown'),
    { ...complaint(mailId, 'complaint-1', 'abuse'), complaint: {
      feedbackId: 'complaint-1', complainedRecipients: [{ emailAddress: address }], complaintFeedbackType: ['abuse'],
    } },
  ]) assert.throws(() => parseAuthMailFeedback(invalid), /INVALID_MAIL_FEEDBACK/);
});

test('restricted SES feedback import deduplicates, suppresses queued and future mail and leaves active claims fenced', async (t) => {
  const f = await fixture(t);
  const mode = process.env.AQUA_AUTH_MAIL_FEEDBACK_MODE;
  t.after(() => {
    if (mode === undefined) delete process.env.AQUA_AUTH_MAIL_FEEDBACK_MODE;
    else process.env.AQUA_AUTH_MAIL_FEEDBACK_MODE = mode;
  });
  delete process.env.AQUA_AUTH_MAIL_FEEDBACK_MODE;
  const transient = parseAuthMailFeedback(bounce(randomUUID(), 'transient', 'Transient'));
  await assert.rejects(recordAuthMailFeedback(f.database, transient, NOW), /MAIL_FEEDBACK_DISABLED/);
  process.env.AQUA_AUTH_MAIL_FEEDBACK_MODE = 'sandbox';

  const role = 'test_feedback_' + randomBytes(6).toString('hex');
  const password = randomBytes(20).toString('hex');
  await f.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const url = new URL(f.connectionString);
  url.username = role;
  url.password = password;
  const restricted = new Database({ connectionString: url.toString(), schema: f.schema });
  f.defer(async () => {
    await restricted.close();
    await f.database.query(`DROP OWNED BY "${role}"`);
    await f.database.query(`DROP ROLE "${role}"`);
  });
  await grantAuthMailFeedbackRole(f.database, role);
  await verifyAuthMailFeedbackRole(restricted);
  for (const table of ['auth_mail_outbox', 'auth_mail_attempts', 'auth_mail_feedback_events', 'users']) {
    await assert.rejects(restricted.query(`SELECT * FROM ${table}`), /permission denied/);
  }
  await assert.rejects(restricted.query('SELECT claim_auth_mail($1)', [NOW]), /permission denied/);

  await f.issue();
  const delivery = (await f.database.query('SELECT id FROM auth_mail_outbox')).rows[0].id as string;
  transient.mailId = delivery;
  await assert.rejects(recordAuthMailFeedback(restricted, transient, NOW), /MAIL_FEEDBACK_UNMATCHED/);
  const claim = await f.outbox.claim();
  assert.ok(claim);
  await assert.rejects(recordAuthMailFeedback(restricted, { ...transient, recipientHash: digest('wrong@example.test') }, NOW), /MAIL_FEEDBACK_UNMATCHED/);
  const results = await Promise.all([recordAuthMailFeedback(restricted, transient, NOW), recordAuthMailFeedback(restricted, transient, NOW)]);
  assert.deepEqual(results[0], { kind: 'transient_bounce', receivedAt: NOW, suppressionEvent: false });
  assert.deepEqual(results[0], results[1]);
  assert.equal((await f.database.query('SELECT count(*) FROM auth_mail_feedback_events')).rows[0].count, '1');
  await assert.rejects(recordAuthMailFeedback(restricted, { ...transient, kind: 'complaint' }, NOW), /MAIL_FEEDBACK_CONFLICT/);
  await f.outbox.finish(finish(claim));

  await f.issue('email-verification');
  const active = await f.outbox.claim();
  assert.ok(active);
  await f.issue();
  const directory = await mkdtemp(join(tmpdir(), 'aqua-feedback-'));
  f.defer(() => rm(directory, { recursive: true }));
  const filename = join(directory, 'event.json');
  await writeFile(filename, JSON.stringify(bounce(active.id, 'source-permanent', 'Permanent')), { mode: 0o600 });
  const cmd = ['--import', 'tsx', 'server/auth-mail-feedback-operator.ts', filename];
  const env = { ...process.env, NODE_ENV: 'test', AUTH_MAIL_FEEDBACK_DATABASE_URL: url.toString(), DATABASE_SCHEMA: f.schema };
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, cmd, { env: { ...env, NODE_ENV: 'production' } }), /MAIL_FEEDBACK_DISABLED/);
  const imported = await run(process.execPath, cmd, { env });
  const receipt = JSON.parse(imported.stdout);
  assert.deepEqual(Object.keys(receipt).sort(), ['kind', 'receivedAt', 'suppressionEvent']);
  assert.equal(receipt.kind, 'permanent_bounce');
  assert.equal(receipt.suppressionEvent, true);
  assert.equal((await run(process.execPath, cmd, { env })).stdout, imported.stdout);

  // Feedback may arrive before the local worker commits its provider acknowledgment.
  assert.equal((await f.outbox.finish(finish(active))).status, 'sent');
  assert.equal(await f.outbox.claim(), null);
  assert.equal((await f.database.query("SELECT count(*) FROM auth_mail_outbox WHERE error_code='RECIPIENT_SUPPRESSED'")).rows[0].count, '1');
  const retained = await recordAuthMailFeedback(restricted, parseAuthMailFeedback(complaint(active.id, 'positive', 'not-spam')), NOW);
  assert.equal(retained.suppressionEvent, false);
  await f.issue();
  assert.equal(await f.outbox.claim(), null);
  const discarded = (await f.database.query("SELECT status,attempt_count,key_id,auth_tag,iv,ciphertext FROM auth_mail_outbox WHERE error_code='RECIPIENT_SUPPRESSED'")).rows;
  assert.equal(discarded.length, 2);
  for (const row of discarded) assert.deepEqual(row, { status: 'discarded', attempt_count: 0, key_id: null, auth_tag: null, iv: null, ciphertext: null });
  const persisted = (await f.database.query('SELECT * FROM auth_mail_feedback_events')).rows;
  assert.equal(persisted.length, 3);
  assert.ok(persisted.every(row => row.actor === role));
  assert.doesNotMatch(JSON.stringify(persisted), /@|private diagnostic/);
  await assert.rejects(f.database.query('DELETE FROM auth_mail_feedback_events'), /immutable/);
});

test('an abuse complaint suppresses only the matched account', async (t) => {
  const f = await fixture(t);
  await f.issue();
  const original = await f.outbox.claim();
  assert.ok(original);
  const event = parseAuthMailFeedback(complaint(original.id, 'complaint-1', 'abuse'));
  const { rows } = await f.database.query('SELECT record_auth_mail_feedback($1::jsonb,$2::bigint) AS result', [JSON.stringify(event), NOW]);
  assert.deepEqual(rows[0].result, { kind: 'complaint', receivedAt: NOW, suppressionEvent: true });
  await f.outbox.finish(finish(original));
  await f.issue('email-verification');
  const store = new LedgerStore(f.database);
  await store.createUser({ id: 'mail-bob', email: 'mail-bob@example.test', name: '메일 테스트', tag: 'mail.bob', passwordHash: 'test-password-hash', createdAt: NOW });
  await f.issue('password-recovery', { message: { purpose: 'password-recovery', userId: 'mail-bob', email: 'mail-bob@example.test',
    token: randomBytes(32).toString('hex'), createdAt: NOW, expiresAt: NOW + 900_000 } });
  const next = await f.outbox.claim();
  assert.equal(next?.userId, 'mail-bob');
});
