import type { CustomerAccessSnapshot, CustomerAccessStatus } from '../shared/api';
import type { Database } from './database';
import { LedgerError } from './errors';

export interface CustomerAccessTransition {
  userId: string;
  status: CustomerAccessStatus;
  expectedVersion: number;
  idempotencyKey: string;
  /** An internal case reference or explanation, never identity documents or credentials. */
  reason: string;
}

const key = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const statuses: readonly string[] = ['unverified', 'pending_review', 'active', 'restricted', 'frozen', 'closed'];
const failures: Record<string, { status: number; message: string }> = {
  INVALID_CUSTOMER_ACCESS_COMMAND: { status: 400, message: '고객 상태 변경 정보를 확인해 주세요.' },
  CUSTOMER_ACCESS_NOT_FOUND: { status: 404, message: '고객 상태를 찾을 수 없습니다.' },
  CUSTOMER_ACCESS_REQUIRED: { status: 403, message: '현재 고객 상태에서는 이 거래를 진행할 수 없습니다.' },
  CUSTOMER_ACCESS_VERSION_CHANGED: { status: 409, message: '고객 상태가 변경되었습니다. 최신 상태를 확인해 주세요.' },
  CUSTOMER_ACCESS_TRANSITION_INVALID: { status: 409, message: '현재 상태에서는 요청한 상태로 변경할 수 없습니다.' },
  CUSTOMER_ACCESS_CAPACITY: { status: 409, message: '고객 상태 변경 기록이 허용 범위를 초과했습니다.' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: '같은 요청 번호에 다른 내용이 있습니다.' },
};
function invalid(): never {
  throw new LedgerError(400, 'INVALID_CUSTOMER_ACCESS_COMMAND', failures.INVALID_CUSTOMER_ACCESS_COMMAND.message);
}
function commandError(error: unknown): never {
  if (error instanceof LedgerError) throw error;
  const pg = error as { message?: string; code?: string } | null;
  const known = pg?.message ? failures[pg.message] : undefined;
  if (known) throw new LedgerError(known.status, pg!.message!, known.message);
  if (pg?.code === '22023') invalid();
  if (['55P03', '40P01', '40001'].includes(pg?.code ?? '')) {
    throw new LedgerError(503, 'DATABASE_BUSY', '다른 요청을 처리하고 있습니다. 같은 요청 번호로 다시 확인해 주세요.');
  }
  throw error;
}

/** Internal sandbox eligibility. An active record is not an identity/KYC attestation. */
export class CustomerAccessStore {
  private readonly now: () => number;
  constructor(readonly database: Database, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async snapshot(userId: string): Promise<CustomerAccessSnapshot> {
    if (typeof userId !== 'string' || !key.test(userId)) invalid();
    try {
      const { rows } = await this.database.query<{ result: CustomerAccessSnapshot }>(
        'SELECT customer_access_snapshot($1::text) AS result', [userId]);
      return rows[0].result;
    } catch (error) { return commandError(error); }
  }

  /** Privileged test operator only; deployment does not grant this command to the API. */
  async transition(input: CustomerAccessTransition): Promise<CustomerAccessSnapshot> {
    if (process.env.NODE_ENV === 'production') throw new LedgerError(403, 'SANDBOX_DISABLED', '운영 환경에서는 테스트 고객 상태를 승인하거나 변경할 수 없습니다.');
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 5
      || !['userId', 'status', 'expectedVersion', 'idempotencyKey', 'reason'].every((field) => Object.hasOwn(input, field))
      || typeof input.userId !== 'string' || !key.test(input.userId)
      || !statuses.includes(input.status)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || typeof input.idempotencyKey !== 'string' || !key.test(input.idempotencyKey)
      || typeof input.reason !== 'string' || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(input.reason)) invalid();
    const reason = input.reason.trim();
    if ([...reason].length < 10 || [...reason].length > 500) invalid();
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) {
      throw new LedgerError(500, 'INVALID_CLOCK', '서버 시간을 확인할 수 없습니다.');
    }
    try {
      return await this.database.transaction(async (client) => {
        const { rows } = await client.query<{ result: CustomerAccessSnapshot }>(
          'SELECT operator_set_customer_access($1::jsonb,$2::bigint) AS result', [JSON.stringify({ ...input, reason }), now]);
        return rows[0].result;
      });
    } catch (error) { return commandError(error); }
  }
}
