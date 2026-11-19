import type { QueryResultRow } from 'pg';
import type { CardEventResult, SandboxCardEvent } from '../shared/api';
import { parseSandboxCardEvent } from './card-command';
import type { Database } from './database';
import { LedgerError } from './ledger';

const failures: Record<string, { status: number; message: string }> = {
  INVALID_CARD_EVENT: { status: 400, message: '카드 테스트 이벤트 형식을 확인해 주세요.' },
  USER_NOT_FOUND: { status: 404, message: '회원을 찾을 수 없습니다.' },
  CARD_PAYMENT_NOT_FOUND: { status: 404, message: '카드 승인 내역을 찾을 수 없습니다.' },
  CARD_OWNER_MISMATCH: { status: 409, message: '카드 승인 내역의 회원이 일치하지 않습니다.' },
  CARD_STATE_CONFLICT: { status: 409, message: '현재 카드 거래 상태에서 처리할 수 없는 요청입니다.' },
  INSUFFICIENT_FUNDS: { status: 409, message: '승인할 수 있는 잔액이 부족합니다.' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: '같은 카드 이벤트 번호에 다른 내용이 있습니다.' },
  RECIPIENT_BALANCE_LIMIT: { status: 409, message: '반영 후 잔액이 처리 범위를 초과합니다.' },
  LEDGER_CAPACITY: { status: 409, message: '카드 정산 계정의 금액이 처리 범위를 초과합니다.' },
};

/** Internal sandbox commands only. No PAN, issuer transport or public write endpoint. */
export class CardPaymentStore {
  readonly database: Database;
  private readonly clock: () => number;

  constructor(database: Database, options: { now?: () => number } = {}) {
    this.database = database;
    this.clock = options.now ?? Date.now;
  }

  async apply(input: SandboxCardEvent): Promise<CardEventResult> {
    const parsed = parseSandboxCardEvent(input);
    const command: SandboxCardEvent = parsed.kind === 'authorize' ? { ...parsed, merchantName: parsed.merchantName.trim() } : parsed;
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) throw new LedgerError(500, 'INVALID_CLOCK', '서버 시간을 확인할 수 없습니다.');
    try {
      const result = await this.database.transaction((client) => client.query<QueryResultRow & { result: CardEventResult }>(
        'SELECT apply_sandbox_card_event($1::jsonb, $2::bigint) AS result', [JSON.stringify(command), now]), { isolation: 'read committed' });
      return result.rows[0].result;
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      const pg = error as { code?: string; message?: string } | null;
      const failure = pg?.message ? failures[pg.message] : undefined;
      if (failure) throw new LedgerError(failure.status, pg!.message!, failure.message);
      if (pg?.code === '22023') throw new LedgerError(400, 'INVALID_CARD_EVENT', failures.INVALID_CARD_EVENT.message);
      if (pg?.code === '23505') throw new LedgerError(409, 'IDEMPOTENCY_CONFLICT', failures.IDEMPOTENCY_CONFLICT.message);
      if (pg?.code === '22003') throw new LedgerError(409, 'LEDGER_CAPACITY', failures.LEDGER_CAPACITY.message);
      if (pg?.code === '55P03' || pg?.code === '40P01' || pg?.code === '40001') throw new LedgerError(503, 'DATABASE_BUSY', '다른 요청을 처리하고 있습니다. 같은 이벤트 번호로 다시 시도해 주세요.');
      throw error;
    }
  }
}
