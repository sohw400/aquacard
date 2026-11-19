import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { CardOperationsStore, parseCardOperationsInput, parseCardOperationsRequestId, type CardOperationsInput, type CardOperationsReport } from './card-operations';
import type { Database } from './database';
import { LedgerError } from './errors';

const requestId = 'b45c60de-3f69-4704-ab95-9c49127c9f38';
const input: CardOperationsInput = { requestId, lookup: { kind: 'event', id: 'test-event:001' }, caseReference: 'INC-001' };
const empty: CardOperationsReport = { version: 1, mode: 'sandbox', requestId, preparedAt: 1_000,
  lookup: input.lookup, caseReference: input.caseReference, found: false, correlation: 'not_found',
  authorization: null, ledgerEvent: null, inbox: null, payment: null, issuerCommand: null };

function code(expected: string) { return (error: unknown) => error instanceof LedgerError && error.code === expected; }
function executable(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'server/card-operations-operator.ts', ...args], {
    env: { ...process.env, OPERATIONS_DATABASE_URL: '', DATABASE_URL: 'postgresql://sensitive-api:sensitive-password@127.0.0.1:1/unused',
      MIGRATION_DATABASE_URL: 'postgresql://sensitive-owner:sensitive-password@127.0.0.1:1/unused', ...environment },
    encoding: 'utf8', timeout: 10_000,
  });
}

test('operations input accepts only exact bounded identifiers and cannot carry free-text metadata or hidden fields', () => {
  assert.deepEqual(parseCardOperationsInput(input), input);
  assert.notEqual(parseCardOperationsInput(input), input);
  assert.notEqual(parseCardOperationsInput(input).lookup, input.lookup);
  assert.deepEqual(parseCardOperationsInput({ ...input, lookup: { kind: 'inbox', id: requestId } }).lookup, { kind: 'inbox', id: requestId });
  assert.equal(parseCardOperationsRequestId(requestId), requestId);
  const malformed: unknown[] = [null, [], {}, { ...input, actor: 'forged-owner' }, { ...input, requestId: requestId.toUpperCase() },
    { ...input, requestId: `${requestId}\n` }, { ...input, caseReference: 'personal@example.test' }, { ...input, caseReference: 'x'.repeat(129) },
    { ...input, caseReference: 'INC-1\n' }, { ...input, caseReference: 'INC-1\r' }, { ...input, caseReference: 'INC-1\u2028' },
    { ...input, lookup: { kind: 'event', id: 'test-event\n' } }, { ...input, lookup: { kind: 'event', id: 'contains spaces' } },
    { ...input, lookup: { kind: 'event', id: '_starts-wrong' } }, { ...input, lookup: { kind: 'event', id: 'x'.repeat(129) } },
    { ...input, lookup: { kind: 'event', id: 'valid', cardNumber: '4111111111111111' } },
    { ...input, lookup: { kind: 'inbox', id: 'not-a-uuid' } }, { ...input, lookup: { kind: ['event'], id: 'valid' } },
    Object.assign(Object.create({ caseReference: 'inherited' }), { requestId, lookup: input.lookup })];
  for (const value of malformed) assert.throws(() => parseCardOperationsInput(value), code('INVALID_OPS_REQUEST'));
});

test('trace does not disclose its result until the preparation transaction has committed', async () => {
  const calls: string[] = [];
  const receipt = { requestId, preparedAt: 1_000, duplicate: false };
  let releaseCommit!: () => void;
  let finishPrepared!: () => void;
  const commit = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const prepared = new Promise<void>((resolve) => { finishPrepared = resolve; });
  const database = {
    async transaction(work: (client: { query: (sql: string, values: unknown[]) => Promise<unknown> }) => Promise<unknown>, options: unknown) {
      assert.deepEqual(options, { isolation: 'repeatable read' }); calls.push('begin');
      const result = await work({ async query(sql, values) {
        assert.equal(sql, 'SELECT prepare_card_operations_report($1::jsonb) AS receipt');
        assert.deepEqual(JSON.parse(values[0] as string), input); calls.push('prepared'); finishPrepared();
        return { rows: [{ receipt }] };
      } });
      await commit; calls.push('committed'); return result;
    },
    async query(sql: string, values: unknown[]) {
      assert.deepEqual(calls, ['begin', 'prepared', 'committed']);
      assert.equal(sql, 'SELECT read_card_operations_report($1::text) AS report'); assert.deepEqual(values, [requestId]);
      calls.push('read'); return { rows: [{ report: empty }] };
    },
  } as unknown as Database;
  const pending = new CardOperationsStore(database).trace(input);
  await prepared;
  assert.deepEqual(calls, ['begin', 'prepared']);
  releaseCommit();
  assert.deepEqual(await pending, empty);
  assert.deepEqual(calls, ['begin', 'prepared', 'committed', 'read']);
});

test('ambiguous preparation commits are neither retried nor followed by a report read', async () => {
  let prepared = 0; let reads = 0;
  const database = {
    async transaction() { prepared++; throw new Error('lost COMMIT connection postgresql://private:credential'); },
    async query() { reads++; return { rows: [{ report: empty }] }; },
  } as unknown as Database;
  await assert.rejects(new CardOperationsStore(database).trace(input), (error: unknown) => {
    assert.ok(error instanceof LedgerError); assert.equal(error.code, 'OPS_UNAVAILABLE');
    assert.doesNotMatch(error.message, /postgresql|private|credential/); return true;
  });
  assert.equal(prepared, 1); assert.equal(reads, 0);
});

test('operations failures normalize expected refusal, serialization and unknown database errors', async () => {
  for (const [failure, expected] of [
    [{ message: 'OPS_REQUEST_CONFLICT' }, 'OPS_REQUEST_CONFLICT'], [{ message: 'OPS_COMMIT_REQUIRED' }, 'OPS_COMMIT_REQUIRED'],
    [{ message: 'OPS_SNAPSHOT_REQUIRED' }, 'OPS_SNAPSHOT_REQUIRED'], [{ message: 'OPS_REPORT_NOT_FOUND' }, 'OPS_REPORT_NOT_FOUND'],
    [{ code: '40001', message: 'private table detail' }, 'DATABASE_BUSY'], [{ code: '55P03' }, 'DATABASE_BUSY'],
    [{ code: '22023', message: 'raw SQL user payload' }, 'INVALID_OPS_REQUEST'], [{ code: '42501', message: 'private schema detail' }, 'OPS_UNAVAILABLE'],
  ] as const) {
    const database = { async query() { throw failure; }, async transaction() { throw failure; } } as unknown as Database;
    await assert.rejects(new CardOperationsStore(database).read(requestId), code(expected));
    await assert.rejects(new CardOperationsStore(database).prepare(input), code(expected));
  }
});

test('invalid requests do not reach a database and malformed receipts or unexpected top-level report data fail closed', async () => {
  let queries = 0;
  const never = { async query() { queries++; }, async transaction() { queries++; } } as unknown as Database;
  await assert.rejects(new CardOperationsStore(never).read('not-a-key'), code('INVALID_OPS_REQUEST'));
  await assert.rejects(new CardOperationsStore(never).prepare({ ...input, caseReference: 'private email@example.test' }), code('INVALID_OPS_REQUEST'));
  assert.equal(queries, 0);
  for (const receipt of [{ requestId, preparedAt: 1_000, duplicate: false, result: empty }, { requestId: 'wrong', preparedAt: 1_000, duplicate: false }, null]) {
    const database = { async transaction() { return { rows: [{ receipt }] }; } } as unknown as Database;
    await assert.rejects(new CardOperationsStore(database).prepare(input), code('OPS_UNAVAILABLE'));
  }
  for (const report of [{ ...empty, canonical_input: { secret: 'must not leave the store' } }, { ...empty, lookup: { kind: 'event', id: 'invalid id' } }]) {
    const database = { async query() { return { rows: [{ report }] }; } } as unknown as Database;
    await assert.rejects(new CardOperationsStore(database).read(requestId), code('OPS_UNAVAILABLE'));
  }
});

test('operations CLI help and invalid arguments connect nowhere and never echo private input', () => {
  const help = executable(['--help'], { NODE_ENV: 'production' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /trace-event/); assert.equal(help.stderr, '');
  for (const args of [[], ['read'], ['read', requestId, 'extra'], ['trace-event', 'evt', requestId],
    ['retry', 'must-not-appear'], ['trace-event', 'evt', requestId, 'private@example.test'],
    ['trace-inbox', 'not-a-uuid', requestId, 'CASE-1'], ['read', 'postgresql://private:credential']]) {
    const result = executable(args, { NODE_ENV: 'production', DATABASE_CA_FILE: '/missing/certificate' });
    assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr); assert.match(error.code, /^INVALID_OPS_/);
    assert.doesNotMatch(result.stderr, /private@example|private:credential|sensitive-|must-not-appear|ENOENT|ECONNREFUSED/);
  }
});

test('operations CLI requires its own login and retains only a validated recovery key on unavailable configuration', () => {
  const missing = executable(['trace-event', 'event-1', requestId, 'CASE-1'], { NODE_ENV: 'production' });
  assert.equal(missing.status, 2, missing.stderr); assert.equal(missing.stdout, '');
  const error = JSON.parse(missing.stderr);
  assert.equal(error.code, 'OPS_CONFIGURATION_REQUIRED'); assert.equal(error.requestId, requestId);
  assert.match(error.message, /OPERATIONS_DATABASE_URL/);
  assert.doesNotMatch(missing.stderr, /sensitive-|postgresql|ECONNREFUSED|disabled in production/);
  const failed = executable(['read', requestId], {
    OPERATIONS_DATABASE_URL: 'postgresql://sensitive-ops:sensitive-password@127.0.0.1:1/unused', NODE_ENV: 'development',
  });
  assert.equal(failed.status, 2, failed.stderr); assert.equal(failed.stdout, '');
  assert.equal(JSON.parse(failed.stderr).code, 'OPS_UNAVAILABLE'); assert.equal(JSON.parse(failed.stderr).requestId, requestId);
  assert.doesNotMatch(failed.stderr, /sensitive-|postgresql|ECONNREFUSED|schema_migrations/);
});
