import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseSandboxCardEvent } from './card-command';

const event = { kind: 'authorize', eventId: 'evt-test', paymentId: 'payment-test', userId: 'user-test', amountWon: 20_000, merchantName: '테스트 서점' };

test('operator events reject card credentials and unsupported issuer payloads instead of storing them', () => {
  assert.equal(parseSandboxCardEvent(event).kind, 'authorize');
  for (const extra of [{ pan: 'test-card-number' }, { cvv: 'test-security-code' }, { metadata: { secret: 'private' } }, { provider: 'reap' }]) {
    assert.throws(() => parseSandboxCardEvent({ ...event, ...extra }), /이벤트 형식/);
  }
  for (const invalid of [null, [], {}, { ...event, kind: '__proto__' }, { ...event, userId: '' }, { ...event, merchantName: '서점\nforged log' }]) {
    assert.throws(() => parseSandboxCardEvent(invalid), /이벤트 형식/);
  }
});

test('operator amounts require exact positive integers and capture requires an explicit final decision', () => {
  for (const amountWon of [0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10000']) {
    assert.throws(() => parseSandboxCardEvent({ ...event, amountWon }), /이벤트 형식/);
  }
  const capture = { kind: 'capture', eventId: 'evt-capture', paymentId: event.paymentId, userId: event.userId, amountWon: 10_000 };
  assert.throws(() => parseSandboxCardEvent(capture), /이벤트 형식/);
  assert.throws(() => parseSandboxCardEvent({ ...capture, finalCapture: 'false' }), /이벤트 형식/);
  assert.equal(parseSandboxCardEvent({ ...capture, finalCapture: false }).kind, 'capture');
  assert.equal(parseSandboxCardEvent({ kind: 'reverse', eventId: 'evt-reverse', paymentId: event.paymentId, userId: event.userId }).kind, 'reverse');
});

test('the operator CLI refuses production before reading an event or connecting to PostgreSQL', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/card.ts', '/no-such-aqua-card-event.json'], {
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /disabled in production/);
  assert.doesNotMatch(result.stderr, /ENOENT|ECONNREFUSED|unused:unused/);
});
