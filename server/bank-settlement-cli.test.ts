import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CardPaymentStore } from './card-payments';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerStore } from './ledger';
import { grantMonitorRole, grantSettlementRole } from './permissions';
import { approveTestCustomer } from './test-customer-access';
import { createTestDatabase } from './test-support';

const businessDate = '2024-04-20';
const settlementDate = '2024-04-23';
const paymentId = 'purchase-april';
const accountRef = 'aqua-dedicated';
const currency = 'TEST_KRW';
const issuer = {
  version: 1, businessDate, currency, controls: { rowCount: 2, capturedWon: '100', refundedWon: '30' },
  rows: [
    { eventId: 'capture-april', paymentId, kind: 'capture', amountWon: '100' },
    { eventId: 'refund-april', paymentId, kind: 'refund', amountWon: '30' },
  ],
};
const advice = {
  version: 1, businessDate, settlementDate, currency, accountRef,
  batches: [{ batchId: 'april-a', eventIds: ['capture-april', 'refund-april'], feeWon: '3' }],
};
const bank = {
  version: 1, settlementDate, currency, accountRef, controls: { rowCount: 1, debitedWon: '73', creditedWon: '0' },
  rows: [{ postingId: 'posted-april', batchId: 'april-a', direction: 'debit', amountWon: '73' }],
};

function run(paths: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/reconcile-bank-settlement.ts', ...paths], {
    env: { ...process.env, NODE_ENV: 'test', ...env }, encoding: 'utf8', timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, /private-bank-test|bank-customer|private@example|비공개 가맹점|postgresql:\/\//);
  return result;
}

function expectIncomplete(result: ReturnType<typeof run>, expectedCode?: string) {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  const failure = JSON.parse(result.stderr);
  assert.deepEqual(Object.keys(failure).sort(), ['code', 'status']);
  assert.equal(failure.status, 'incomplete');
  assert.match(failure.code, /^[A-Z_]+$/);
  if (expectedCode) assert.equal(failure.code, expectedCode);
}

async function save(path: string, input: unknown) {
  const text = JSON.stringify(input, null, 2) + '\n';
  await writeFile(path, text, { mode: 0o600 });
  return createHash('sha256').update(text).digest('hex');
}

test('bank CLI checks issuer events, fee-adjusted bank movements, closed dates and account scope using its restricted login', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'private-bank-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = ['issuer.json', 'advice.json', 'bank.json'].map(file => join(dir, file));
  const [issuerPath, advicePath, bankPath] = paths;
  const [issuerStatement, settlementAdvice, bankStatement] = await Promise.all([
    save(issuerPath, issuer), save(advicePath, advice), save(bankPath, bank),
  ]);
  const f = await createTestDatabase();
  const role = 'bank_settle_' + randomBytes(8).toString('hex');
  const password = randomBytes(24).toString('hex');
  t.after(async () => {
    try {
      await f.database.query(`DROP OWNED BY "${role}"`);
      await f.database.query(`DROP ROLE "${role}"`);
    } finally { await f.cleanup(); }
  });
  await f.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  await grantSettlementRole(f.database, role);
  const url = new URL(f.connectionString);
  url.username = role;
  url.password = password;
  const env = { SETTLEMENT_DATABASE_URL: url.href, DATABASE_SCHEMA: f.schema };

  const clock = { now: () => Date.UTC(2024, 3, 20, 4) };
  const ledger = new LedgerStore(f.database, clock);
  const cards = new CardPaymentStore(f.database, clock);
  const userId = 'bank-customer';
  await ledger.createUser({ id: userId, tag: 'bankcustomer', name: '대사 회원', email: 'private@example.test',
    passwordHash: 'synthetic', createdAt: clock.now() });
  await approveTestCustomer(f.database, userId);
  await new IssuerOutboxStore(f.database, clock).register({ userId, providerCardId: 'sandbox-card-bank-test', initialStatus: 'active' });
  await ledger.creditSandbox({ userId, amountWon: 500, idempotencyKey: 'bank-funding' });
  await cards.apply({ kind: 'authorize', eventId: 'authorize-april', paymentId, userId, merchantName: '비공개 가맹점', amountWon: 100 });
  await cards.apply({ kind: 'capture', eventId: 'capture-april', paymentId, userId, amountWon: 100, finalCapture: true });
  await cards.apply({ kind: 'refund', eventId: 'refund-april', paymentId, userId, amountWon: 30 });
  const before = await ledger.snapshot(userId);

  const result = run(paths, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope, 'bank_settlement');
  assert.equal(report.stage, 'bank_settlement');
  assert.equal(report.ok, true);
  assert.equal(report.bankSettlement.ok, true);
  assert.deepEqual(report.sourceSha256, { issuerStatement, settlementAdvice, bankStatement });

  await save(bankPath, { ...bank, rows: [{ ...bank.rows[0], amountWon: '70' }], controls: { ...bank.controls, debitedWon: '70' } });
  const feeMissing = run(paths, env);
  assert.equal(feeMissing.status, 1, feeMissing.stderr);
  const bankDifference = JSON.parse(feeMissing.stdout);
  assert.equal(bankDifference.stage, 'bank_settlement');
  assert.equal(bankDifference.ok, false);
  assert.equal(bankDifference.bankSettlement.ok, false);
  await save(bankPath, bank);

  // Equal net on all three inputs cannot cover up incorrect issuer capture and refund amounts.
  await save(issuerPath, { ...issuer, controls: { rowCount: 2, capturedWon: '101', refundedWon: '31' },
    rows: [{ ...issuer.rows[0], amountWon: '101' }, { ...issuer.rows[1], amountWon: '31' }] });
  const upstream = run(paths, env);
  assert.equal(upstream.status, 1, upstream.stderr);
  const blocked = JSON.parse(upstream.stdout);
  assert.equal(blocked.scope, 'bank_settlement');
  assert.equal(blocked.stage, 'issuer_statement');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.bankSettlement, null);
  await save(issuerPath, issuer);

  await save(advicePath, { ...advice, batches: [{ ...advice.batches[0], eventIds: ['capture-april'] }] });
  expectIncomplete(run(paths, env));
  await save(advicePath, advice);
  await save(bankPath, { ...bank, accountRef: 'other-account' });
  expectIncomplete(run(paths, env));
  await save(bankPath, { ...bank, settlementDate: '2024-04-24' });
  expectIncomplete(run(paths, env));

  const { rows } = await f.database.query<{ today: string }>(
    "SELECT to_char(transaction_timestamp() AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS today");
  for (const pending of [rows[0].today, '9999-12-30']) {
    await save(advicePath, { ...advice, settlementDate: pending });
    await save(bankPath, { ...bank, settlementDate: pending });
    expectIncomplete(run(paths, env), 'SETTLEMENT_DAY_OPEN');
  }
  await save(advicePath, advice);
  await writeFile(bankPath, '{"private-bank-test"');
  expectIncomplete(run(paths, env));
  await save(bankPath, bank);
  expectIncomplete(run(paths, { ...env, SETTLEMENT_DATABASE_URL: f.connectionString }));
  await grantMonitorRole(f.database, role);
  expectIncomplete(run(paths, env));
  assert.deepEqual(await ledger.snapshot(userId), before);
});
