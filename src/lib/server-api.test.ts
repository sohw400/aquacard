import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, outcomeUncertain } from '../server/api';

test('송금 응답 유실·세션 변경·서버 오류는 이전 요청 번호를 보존해야 한다', () => {
  for (const error of [
    new TypeError('Connection closed'), new DOMException('Timed out', 'TimeoutError'),
    new ApiError(500, 'INSUFFICIENT_FUNDS', 'Gateway changed the response status'),
    new ApiError(503, 'INTERNAL_ERROR', 'Server unavailable'),
    new ApiError(401, 'UNAUTHENTICATED', 'Session expired'),
    new ApiError(403, 'ORIGIN_REJECTED', 'Origin rejected'),
    new ApiError(408, 'REQUEST_TIMEOUT', 'Request timed out'),
    new ApiError(429, 'RATE_LIMITED', 'Try later'),
    new ApiError(409, 'SESSION_CHANGED', 'Another tab signed in'),
    new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Original intent needs investigation'),
    new ApiError(404, 'NOT_FOUND', 'Endpoint not found'),
  ]) assert.equal(outcomeUncertain(error), true, error.message);
});

test('원장이 실행 전에 확정 거절한 송금만 새 요청으로 다시 시작할 수 있다', () => {
  assert.equal(outcomeUncertain(new ApiError(409, 'INSUFFICIENT_FUNDS', 'Insufficient funds')), false);
  assert.equal(outcomeUncertain(new ApiError(409, 'LIMIT_EXCEEDED', 'Limit exceeded')), false);
  assert.equal(outcomeUncertain(new ApiError(404, 'RECIPIENT_NOT_FOUND', 'No recipient')), false);
  assert.equal(outcomeUncertain(new ApiError(400, 'INVALID_AMOUNT', 'Invalid amount')), false);
});
