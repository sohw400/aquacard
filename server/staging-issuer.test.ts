import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSandboxIssuerAdapter } from './issuer-adapter';
import type { IssuerOutboxClaim } from './issuer-outbox';
import { createStagingIssuer } from './staging-issuer-sandbox';

test('private staging sidecar verifies dispatcher signatures and never applies a card command', async t => {
  const original = process.env.NODE_ENV;
  t.after(() => { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; });
  const key = randomBytes(32).toString('base64url');
  process.env.NODE_ENV = 'production';
  assert.throws(() => createStagingIssuer('staging-key', key));
  process.env.NODE_ENV = 'staging';
  const app = createStagingIssuer('staging-key', key);
  t.after(() => app.close());
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const adapter = createSandboxIssuerAdapter({ baseUrl: origin, keyId: 'staging-key', signingKey: key });
  const claim: IssuerOutboxClaim = {
    id: randomUUID(), cardId: randomUUID(), providerCardId: 'sandbox-card-staging', requestKey: 'aqua-' + randomUUID(),
    targetStatus: 'locked', phase: 'send', leaseToken: randomUUID(), version: 2, attemptCount: 1,
    leaseUntil: Date.now() + 60_000, expiresAt: Date.now() + 86_400_000,
  };
  assert.deepEqual(await adapter.execute(claim), { kind: 'rejected', code: 'COMMAND_REJECTED' });
  assert.deepEqual(await adapter.execute({ ...claim, phase: 'lookup' }), { kind: 'not_found' });
  const unsigned = await app.inject({ method:'GET', url:'/operations/' + claim.requestKey });
  assert.equal(unsigned.statusCode,401);
  assert.equal((await app.inject({method:'GET',url:'/live'})).statusCode,200);
});
