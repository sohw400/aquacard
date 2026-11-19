import { LedgerError } from './errors';

const failures: Record<string, { status: number; message: string }> = {
  INVALID_REWARD_COMMAND: { status: 400, message: '리워드 요청 형식을 확인해 주세요.' },
  INVALID_AMOUNT: { status: 400, message: '1원 이상의 정수 금액을 입력해 주세요.' },
  USER_NOT_FOUND: { status: 404, message: '회원을 찾을 수 없습니다.' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: '같은 요청 번호에 다른 내용이 있습니다.' },
  PREFERENCE_CHANGED: { status: 409, message: '다른 화면에서 설정을 바꿨습니다. 최신 설정을 확인해 주세요.' },
  REWARD_PROGRAM_INACTIVE: { status: 409, message: '새 리워드 지급이 중단되어 있습니다.' },
  REWARD_BUDGET_UNAVAILABLE: { status: 503, message: '리워드 지급 재원을 확인하고 있습니다. 같은 요청 번호로 다시 시도해 주세요.' },
  REWARD_BALANCE_LIMIT: { status: 409, message: '리워드 금액이 처리 범위를 초과합니다.' },
  REWARD_BACKING_MISMATCH: { status: 503, message: '리워드 원장을 확인하고 있습니다. 같은 요청 번호로 다시 시도해 주세요.' },
  LEDGER_CAPACITY: { status: 409, message: '원장의 금액이 처리 범위를 초과합니다.' },
};

export function throwRewardError(error: unknown): never {
  if (error instanceof LedgerError) throw error;
  const pg = error as { code?: string; message?: string } | null;
  const failure = pg?.message ? failures[pg.message] : undefined;
  if (failure) throw new LedgerError(failure.status, pg!.message!, failure.message);
  if (pg?.code === '22023') throw new LedgerError(400, 'INVALID_REWARD_COMMAND', failures.INVALID_REWARD_COMMAND.message);
  if (pg?.code === '23505') throw new LedgerError(409, 'IDEMPOTENCY_CONFLICT', failures.IDEMPOTENCY_CONFLICT.message);
  if (pg?.code === '22003') throw new LedgerError(409, 'LEDGER_CAPACITY', failures.LEDGER_CAPACITY.message);
  if (pg?.code === '55P03' || pg?.code === '40P01' || pg?.code === '40001') throw new LedgerError(503, 'DATABASE_BUSY', '다른 요청을 처리하고 있습니다. 같은 요청 번호로 다시 시도해 주세요.');
  throw error;
}
