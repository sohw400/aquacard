import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { CardPaymentStore } from './card-payments';
import { Database } from './database';
import { IssuerOutboxStore } from './issuer-outbox';
import { LedgerStore } from './ledger';
import { applyMigrations } from './migrations';
import { grantSettlementRole, verifySettlementRole } from './permissions';
import { readSettlementReference, sourceReferenceReader } from './settlement-reference';
import { approveTestCustomer } from './test-customer-access';

test('source and normalized references use disjoint namespaces with typed, keyed aliases', () => {
  const reader = sourceReferenceReader(randomBytes(32));
  const raw = 'order-1700123456789';
  const event = reader('event', raw)!;
  const payment = reader('payment', raw)!;
  assert.match(event, /^~e1\.[a-f0-9]{64}$/);
  assert.match(payment, /^~p1\.[a-f0-9]{64}$/);
  assert.notEqual(event.slice(4), payment.slice(4));
  assert.notEqual(sourceReferenceReader(randomBytes(32))('event', raw), event);
  assert.equal(readSettlementReference('event', raw), undefined);
  assert.equal(readSettlementReference('event', event), event);
  assert.equal(readSettlementReference('payment', event), undefined);
  for (const invalid of [event, payment, 'free text', 'person@example.test', '\n', null]) {
    assert.equal(reader('event', invalid), undefined);
  }
  for (const ordinary of ['capture.1', 'payment:042', 'x'.repeat(128)]) assert.equal(reader('event', ordinary), ordinary);
});

test('migration preserves a pre-019 keyed issuer event and reconciles independent normalized issuer and advice files', async t => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  const dir = await mkdtemp(join(tmpdir(), 'source-references-'));
  const previous = await mkdtemp(join(tmpdir(), 'source-migrations-'));
  const schema = 'test_' + randomBytes(10).toString('hex');
  const login = 'test_settle_' + randomBytes(8).toString('hex');
  const password = randomBytes(18).toString('hex');
  const db = new Database({ connectionString: url, schema });
  const connection = new URL(url); connection.username = login; connection.password = password;
  const settlement = new Database({ connectionString: connection.href, schema });
  t.after(async () => {
    await settlement.close();
    try {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.query(`DROP ROLE IF EXISTS "${login}"`);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
      await rm(previous, { recursive: true, force: true });
    }
  });

  const migrations = new URL('./migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => /^\d{3}_.*\.sql$/.test(file) && file < '016')) {
    await copyFile(new URL(file, migrations), join(previous, file));
  }
  await applyMigrations(db, pathToFileURL(previous + '/'));
  await db.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}'`);
  await grantSettlementRole(db, login);
  const time = Date.UTC(2024, 3, 20, 3);
  const clock = { now: () => time };
  const ledger = new LedgerStore(db, clock);
  const cards = new CardPaymentStore(db, clock);
  const userId = 'legacy-member';
  const rawEvent = 'capture-1713564000123';
  const rawPayment = 'payment-1713564000123';
  await ledger.createUser({ id: userId, tag: 'legacymember', name: '테스트', email: 'legacy@example.test', passwordHash: 'synthetic', createdAt: time });
  await approveTestCustomer(db, userId);
  await new IssuerOutboxStore(db, clock).register({ userId, providerCardId: 'sandbox-card-legacy', initialStatus: 'active' });
  await ledger.creditSandbox({ userId, amountWon: 100, idempotencyKey: 'legacy-credit' });
  await cards.apply({ kind: 'authorize', eventId: 'initial-auth', paymentId: rawPayment, userId, merchantName: '가상 상점', amountWon: 40 });
  await cards.apply({ kind: 'capture', eventId: rawEvent, paymentId: rawPayment, userId, amountWon: 40, finalCapture: true });
  const read = () => settlement.query('SELECT * FROM issuer_statement_postings($1,$2)', [Date.UTC(2024, 3, 19, 15), Date.UTC(2024, 3, 20, 15)]);
  await assert.rejects(read(), /STATEMENT_LEDGER_INCONSISTENT/);
  await applyMigrations(db);
  const exposed = await settlement.query(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=$1 AND p.prosecdef AND p.prorettype<>'trigger'::regtype
      AND has_function_privilege(current_user, p.oid, 'EXECUTE') ORDER BY proname`, [schema]);
  assert.deepEqual(exposed.rows.map(row => row.proname), ['issuer_statement_postings']);
  await verifySettlementRole(settlement);
  await assert.rejects(settlement.query('SELECT signing_key FROM settlement_reference_key'), /permission denied/);
  const direct = (await read()).rows[0];
  assert.match(direct.event_id, /^~e1\.[a-f0-9]{64}$/);
  assert.match(direct.payment_id, /^~p1\.[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(direct), /1713564000123/);
  assert.equal((await db.query('SELECT payment_id FROM card_payment_events WHERE event_id=$1', [rawEvent])).rows[0].payment_id, rawPayment);
  const [{ key }] = (await db.query<{ key: string }>("SELECT encode(signing_key,'hex') AS key FROM settlement_reference_key")).rows;
  const keyPath = join(dir, 'key');
  await writeFile(keyPath, key + '\n', { mode: 0o600 });
  function command(name: string, args: string[], env: NodeJS.ProcessEnv) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'server/' + name + '.ts', ...args], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_ENV: 'test', ...env },
    });
    assert.ifError(run.error);
    assert.equal(run.stderr.includes(key) || run.stdout.includes(key), false);
    assert.doesNotMatch(run.stdout + run.stderr, /1713564000123|legacy@example/);
    return run;
  }
  const dates = { businessDate: '2024-04-20', settlementDate: '2024-04-21' };
  const account = { version: 1, accountRef: 'test-settlement', currency: 'TEST_KRW' };
  const event = { eventId: rawEvent, paymentId: rawPayment, kind: 'capture', amountWon: '40' };
  const issuer = { version: 1, currency: account.currency, businessDate: dates.businessDate,
    controls: { rowCount: 1, capturedWon: '40', refundedWon: '0' }, rows: [event] };
  const advice = { ...account, ...dates, batches: [{ batchId: 'batch', eventIds: [rawEvent], feeWon: '2' }] };
  const bank = { ...account, settlementDate: dates.settlementDate, controls: { rowCount: 1, debitedWon: '42', creditedWon: '0' },
    rows: [{ postingId: 'bank-post', batchId: 'batch', direction: 'debit', amountWon: '42' }] };
  async function normalize(kind: string, input: unknown) {
    const source = join(dir, kind + '-source.json');
    await writeFile(source, JSON.stringify(input), { mode: 0o600 });
    const result = command('normalize-settlement-refs', [kind, source], { SETTLEMENT_REFERENCE_KEY_FILE: keyPath });
    assert.equal(result.status, 0, result.stderr);
    const path = join(dir, kind + '.json');
    await writeFile(path, result.stdout, { mode: 0o600 });
    return path;
  }
  const issuerPath = await normalize('issuer', issuer);
  const advicePath = await normalize('advice', advice);
  const bankPath = join(dir, 'bank.json');
  await writeFile(bankPath, JSON.stringify(bank));
  const env = { SETTLEMENT_DATABASE_URL: connection.href, DATABASE_SCHEMA: schema };
  const normalized = await readFile(issuerPath);
  assert.deepEqual(JSON.parse(normalized.toString()).rows, [{ ...event, eventId: direct.event_id, paymentId: direct.payment_id }]);
  const issuerReport = command('reconcile-issuer-statement', [issuerPath], env);
  assert.equal(issuerReport.status, 0, issuerReport.stderr);
  assert.equal(JSON.parse(issuerReport.stdout).statementSha256, createHash('sha256').update(normalized).digest('hex'));
  const bankReport = command('reconcile-bank-settlement', [issuerPath, advicePath, bankPath], env);
  assert.equal(bankReport.status, 0, bankReport.stderr);
  assert.equal(JSON.parse(bankReport.stdout).bankSettlement.bankTotals.debitedWon, '42');
  await writeFile(issuerPath, JSON.stringify({ ...issuer, rows: [], controls: { rowCount: 0, capturedWon: '0', refundedWon: '0' } }));
  const difference = command('reconcile-issuer-statement', [issuerPath], env);
  assert.equal(difference.status, 1, difference.stderr);
  assert.equal(JSON.parse(difference.stdout).findings[0].eventId, direct.event_id);
});
