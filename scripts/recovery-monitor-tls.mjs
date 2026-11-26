import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const [trustedCa, unrelatedCa] = process.argv.slice(2);
const restored = new URL(process.env.MONITOR_DATABASE_URL);
assert.ok(trustedCa && unrelatedCa && restored.hostname === '127.0.0.1'
  && restored.pathname === '/aqua_recovery_restored' && restored.port && !restored.search);

function check(host, ca, expectedCode) {
  const target = new URL(restored);
  target.hostname = host;
  const result = spawnSync(process.execPath,
    ['--dns-result-order=ipv4first', '--import', 'tsx', 'server/operations-monitor.ts'], {
      env: { ...process.env, NODE_ENV: 'production', AQUA_MONITOR_ENVIRONMENT: 'recovery',
        MONITOR_DATABASE_URL: target.toString(), DATABASE_CA_FILE: ca },
      encoding: 'utf8', timeout: 80_000,
    });
  assert.ifError(result.error);
  assert.equal(result.status, expectedCode, 'Unexpected monitor exit on the TLS-enabled restored database.');
  const event = JSON.parse(result.stdout);
  if (expectedCode === 0) {
    assert.equal(event.MonitorHealthy, 1);
    assert.equal(event.LedgerFindings, 0);
    assert.equal(event.CardInboxDueCount, 0);
    assert.deepEqual(event.failedChecks, []);
  } else {
    assert.equal(event.MonitorHealthy, 0);
    assert.equal(Object.hasOwn(event, 'LedgerFindings'), false);
    assert.equal(Object.hasOwn(event, 'CardInboxDueCount'), false);
    assert.deepEqual(event.failedChecks, ['migrations'], 'The first database query must fail.');
  }
}

// The same private port is reachable under both names. The certificate has
// DNS:localhost only. Change one trust condition at a time.
check('localhost', trustedCa, 0);
check('localhost', unrelatedCa, 2);
check('127.0.0.1', trustedCa, 2);
console.log('Production monitor passed on the restored TLS database and rejected an unrelated CA and a hostname mismatch.');
