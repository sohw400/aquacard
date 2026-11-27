import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSandboxIssuerAdapter } from './issuer-adapter';
import type { IssuerOutboxClaim } from './issuer-outbox';
import { LocalStagingIssuerReceipts } from './local-staging-issuer-receipts';
import { createStagingIssuer } from './staging-issuer-sandbox';

test('local staging issuer retains signed outcomes and card status across retries and process replacement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aqua-issuer-'));
  const key = randomBytes(32).toString('base64url');
  const env = process.env.NODE_ENV;
  let server: ReturnType<typeof createStagingIssuer> | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
      await rm(directory, { recursive: true, force: true });
    }
  });
  process.env.NODE_ENV = 'production';
  assert.throws(() => new LocalStagingIssuerReceipts(directory));
  process.env.NODE_ENV = 'staging';
  const expired = { requestKey: 'aqua-' + randomUUID(), cardRef: 'sandbox-card-local', targetStatus: 'locked' as const, expiresAt: 1 };
  async function boot() {
    const store = new LocalStagingIssuerReceipts(directory);
    server = createStagingIssuer('local-qa', key, store);
    const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
    return { store, app: server, adapter: createSandboxIssuerAdapter({ baseUrl, keyId: 'local-qa', signingKey: key }) };
  }
  const first = await boot();
  const lock: IssuerOutboxClaim = {
    id: randomUUID(), cardId: randomUUID(), providerCardId: expired.cardRef, requestKey: 'aqua-' + randomUUID(),
    targetStatus: 'locked', phase: 'send', leaseToken: randomUUID(), version: 2, attemptCount: 1,
    leaseUntil: Date.now() + 60_000, expiresAt: Date.now() + 86_400_000,
  };
  assert.deepEqual(await first.adapter.execute({ ...lock, phase: 'lookup' }), { kind: 'not_found' });
  const unauthorized = await first.app.inject({ method: 'POST', url: '/cards/' + lock.providerCardId + '/status',
    headers: { 'idempotency-key': lock.requestKey }, payload: { requestKey: lock.requestKey, cardRef: lock.providerCardId, targetStatus: 'locked', expiresAt: lock.expiresAt } });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(first.store.lookup(lock.requestKey), undefined);
  const both = await Promise.all([first.adapter.execute(lock), first.adapter.execute(lock)]);
  assert.deepEqual(both, [{ kind: 'succeeded' }, { kind: 'succeeded' }]);
  const unlock = { ...lock, requestKey: 'aqua-' + randomUUID(), targetStatus: 'active' as const };
  assert.deepEqual(await first.adapter.execute(unlock), { kind: 'succeeded' });
  assert.equal(first.store.apply(expired)?.status, 'rejected');
  await first.app.close();

  const second = await boot();
  for (const command of [lock, unlock]) {
    assert.deepEqual(await second.adapter.execute({ ...command, phase: 'lookup' }), { kind: 'succeeded' });
  }
  assert.deepEqual(await second.adapter.execute(lock), { kind: 'succeeded' });
  assert.equal((await second.adapter.execute({ ...lock, targetStatus: 'active' })).kind, 'uncertain');
  assert.deepEqual(await second.adapter.execute({ ...lock, requestKey: expired.requestKey, phase: 'lookup' }),
    { kind: 'rejected', code: 'COMMAND_REJECTED' });
  const db = new DatabaseSync(join(directory, 'receipts.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT status FROM cards WHERE card_ref = ?').get(lock.providerCardId)?.status, 'active');
    assert.equal(db.prepare('SELECT count(*) AS n FROM operations').get()?.n, 3);
  } finally { db.close(); }
});
