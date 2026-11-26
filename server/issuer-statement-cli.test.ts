import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CardPaymentStore } from './card-payments';
import { Database } from './database';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerStore } from './ledger';
import { grantMonitorRole, grantSettlementRole } from './permissions';
import { approveTestCustomer } from './test-customer-access';
import { createTestDatabase } from './test-support';

const paymentId = 'purchase:one';
const statement = {
  version: 1, businessDate: '2024-04-20', currency: 'TEST_KRW',
  controls: { rowCount: 2, capturedWon: '100', refundedWon: '30' },
  rows: [
    { eventId: 'capture:one', paymentId, kind: 'capture', amountWon: '100' },
    { eventId: 'refund:one', paymentId, kind: 'refund', amountWon: '30' },
  ],
};

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/reconcile-issuer-statement.ts', ...args], {
    env: { ...process.env, NODE_ENV: 'test', SETTLEMENT_DATABASE_URL: '', ...env },
    encoding: 'utf8', timeout: 20_000,
  });
  assert.ifError(result.error);
  return result;
}

async function tempDirectory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'aqua-statement-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function expectIncomplete(result: ReturnType<typeof run>, code: string) {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { status: 'incomplete', code });
}

test('statement CLI rejects special, oversized, ambiguous and malformed files with sanitized errors', async t => {
  const dir = await tempDirectory(t);
  const file = join(dir, 'private-issuer-export');
  const json = JSON.stringify(statement);
  expectIncomplete(run([]), 'STATEMENT_FILE_REQUIRED');
  expectIncomplete(run([file]), 'STATEMENT_FILE_UNAVAILABLE');
  expectIncomplete(run([dir]), 'STATEMENT_FILE_UNAVAILABLE');
  await writeFile(file, json);
  await symlink(file, join(dir, 'link'));
  expectIncomplete(run([join(dir, 'link')]), 'STATEMENT_FILE_UNAVAILABLE');
  const fifo = join(dir, 'fifo');
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [fifo]);
    expectIncomplete(run([fifo]), 'STATEMENT_FILE_UNAVAILABLE');
  }
  await truncate(file, 4 * 1024 * 1024 + 1);
  expectIncomplete(run([file]), 'STATEMENT_FILE_UNAVAILABLE');
  for (const invalid of [
    Buffer.from([0xff, 0xfe]), json.slice(0, -1),
    json.replace('"rows":', '"rows":[],"rows":'),
    json.replace('"rowCount":', '"row\\u0043ount":0,"rowCount":'),
    json.replace('"amountWon":"100"', '"amountWon":{"secret":"discarded:value"},"amountWon":"100"'),
  ]) {
    await writeFile(file, invalid);
    expectIncomplete(run([file]), 'INVALID_STATEMENT_FORMAT');
  }
  await writeFile(file, json.replace('"rowCount":2', '"rowCount":1'));
  expectIncomplete(run([file]), 'STATEMENT_CONTROL_MISMATCH');
});

test('statement CLI reconciles a dated file under a dedicated role, without changing balances or accepting a privileged login', async t => {
  const dir = await tempDirectory(t);
  const file = join(dir, 'private-issuer-export.json');
  const fixture = await createTestDatabase();
  const role = 'st_settlement_' + randomBytes(8).toString('hex');
  const password = randomBytes(24).toString('hex');
  let restricted: Database | undefined;
  t.after(async () => {
    try {
      await restricted?.close();
      await fixture.database.query(`DROP OWNED BY "${role}"`);
      await fixture.database.query(`DROP ROLE "${role}"`);
    } finally { await fixture.cleanup(); }
  });
  await fixture.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  await grantSettlementRole(fixture.database, role);
  const connection = new URL(fixture.connectionString);
  connection.username = role;
  connection.password = password;
  restricted = new Database({ connectionString: connection.href, schema: fixture.schema, maxConnections: 1 });
  await assert.rejects(restricted.query('SELECT * FROM users'), /permission denied/);
  await assert.rejects(restricted.query('SELECT * FROM journal_entries'), /permission denied/);
  await assert.rejects(restricted.query('DELETE FROM journals'), /permission denied/);
  const env = { SETTLEMENT_DATABASE_URL: connection.href, DATABASE_SCHEMA: fixture.schema };

  const clock = { now: () => Date.UTC(2024, 3, 20, 4) };
  const ledger = new LedgerStore(fixture.database, clock);
  const cards = new CardPaymentStore(fixture.database, clock);
  const userId = 'cli-member';
  await ledger.createUser({ id: userId, tag: 'climember', name: '대사 회원', email: 'private@example.test',
    passwordHash: 'synthetic', createdAt: clock.now() });
  await approveTestCustomer(fixture.database, userId);
  await new IssuerOutboxStore(fixture.database, clock).register({ userId, providerCardId: 'sandbox-card-statement', initialStatus: 'active' });
  await ledger.creditSandbox({ userId, amountWon: 1_000, idempotencyKey: 'statement-funding' });
  await cards.apply({ kind: 'authorize', eventId: 'purchase-auth', paymentId, userId, merchantName: '가상 가맹점', amountWon: 100 });
  await cards.apply({ kind: 'capture', eventId: 'capture:one', paymentId, userId, amountWon: 100, finalCapture: true });
  await cards.apply({ kind: 'refund', eventId: 'refund:one', paymentId, userId, amountWon: 30 });
  const before = await ledger.snapshot(userId);

  const text = JSON.stringify(statement, null, 2) + '\n';
  await writeFile(file, text);
  const matched = run([file], env);
  assert.equal(matched.status, 0, matched.stderr);
  assert.equal(matched.stderr, '');
  const report = JSON.parse(matched.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.businessDate, statement.businessDate);
  assert.equal(report.currency, 'TEST_KRW');
  assert.equal(report.ledgerTotals.netWon, '70');
  assert.equal(report.matchedEventCount, 2);
  assert.equal(report.statementSha256, createHash('sha256').update(text).digest('hex'));

  // Same net settlement with both gross amounts off by one.
  const discrepancy = text.replaceAll('"100"', '"101"').replaceAll('"30"', '"31"');
  await writeFile(file, discrepancy);
  const failed = run([file], env);
  assert.equal(failed.status, 1, failed.stderr);
  const different = JSON.parse(failed.stdout);
  assert.equal(different.findingCount, 2);
  assert.equal(different.statementTotals.netWon, different.ledgerTotals.netWon);
  assert.deepEqual(different.findings.map((item: { codes: string[] }) => item.codes), [['AMOUNT_MISMATCH'], ['AMOUNT_MISMATCH']]);
  assert.doesNotMatch(failed.stdout + failed.stderr, /cli-member|private@|가상 가맹점|private-issuer-export/);

  const missing = Array.from({ length: 101 }, (_, i) => ({
    eventId: 'unposted-' + i, paymentId, kind: 'capture', amountWon: '1',
  }));
  await writeFile(file, JSON.stringify({ ...statement, rows: [...statement.rows, ...missing],
    controls: { rowCount: 103, capturedWon: '201', refundedWon: '30' } }));
  const limited = run([file], env);
  assert.equal(limited.status, 1, limited.stderr);
  const truncated = JSON.parse(limited.stdout);
  assert.equal(truncated.findings.length, 100);
  assert.equal(truncated.findingsTruncated, true);
  assert.equal(truncated.findingCount, 101);

  await writeFile(file, text.replace(statement.businessDate, '9999-12-30'));
  expectIncomplete(run([file], env), 'SETTLEMENT_CHECK_UNAVAILABLE');
  await writeFile(file, text);
  expectIncomplete(run([file], { ...env, SETTLEMENT_DATABASE_URL: fixture.connectionString }), 'SETTLEMENT_CHECK_UNAVAILABLE');
  expectIncomplete(run([file], { ...env, SETTLEMENT_DATABASE_URL: '', DATABASE_URL: fixture.connectionString }), 'SETTLEMENT_CHECK_UNAVAILABLE');
  await grantMonitorRole(fixture.database, role);
  expectIncomplete(run([file], env), 'SETTLEMENT_CHECK_UNAVAILABLE');
  assert.deepEqual(await ledger.snapshot(userId), before);
});
