import type { SandboxCardEvent } from '../shared/api';
import { parseSandboxCardEvent } from './card-command';
import type { Database } from './database';
import { LedgerError } from './errors';

export type InboxStatus = 'pending' | 'retry' | 'applied' | 'dead_letter';

export interface InboxReceipt {
  id: string;
  eventId: string;
  status: InboxStatus;
  receivedAt: number;
  duplicate: boolean;
}

export interface InboxProcessResult {
  id: string;
  status: 'applied' | 'retry' | 'dead_letter';
  attemptCount: number;
  cycleAttempts: number;
  version: number;
  errorCode: string | null;
  nextAttemptAt: number | null;
}

/** Counts are decimal strings, including when the queue exceeds JavaScript's integer range. */
export interface InboxStats {
  pending: string;
  retry: string;
  applied: string;
  deadLetter: string;
  due: string;
  oldestPendingAt: number | null;
}

export interface InboxRequeueInput {
  id: string;
  idempotencyKey: string;
  reason: string;
  expectedVersion: number;
}

export interface InboxRequeueResult {
  id: string;
  status: 'pending';
  version: number;
}

export interface CaptureResolutionInput {
  id: string;
  expectedVersion: number;
  idempotencyKey: string;
  evidenceRef: string;
  replacementId: string | null;
}
export interface CaptureResolutionResult {
  id: string;
  disposition: 'void' | 'superseded';
  replacementId: string | null;
  evidenceRef: string;
  resolvedAt: number;
}
export interface HoldExpiration { paymentId: string; eventId: string; releasedWon: number }

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const maxClock = 8.64e15 - 9 * 60 * 60 * 1_000;
const failures: Record<string, { status: number; message: string }> = {
  INVALID_CARD_EVENT: { status: 400, message: '카드 테스트 이벤트 형식을 확인해 주세요.' },
  INVALID_INBOX_COMMAND: { status: 400, message: '카드 수신 기록 요청 형식을 확인해 주세요.' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: '같은 요청 번호에 다른 내용이 있습니다.' },
  INBOX_EVENT_NOT_FOUND: { status: 404, message: '카드 수신 기록을 찾을 수 없습니다.' },
  INBOX_VERSION_CHANGED: { status: 409, message: '카드 수신 기록이 변경되었습니다. 최신 상태를 확인해 주세요.' },
  INBOX_STATE_CONFLICT: { status: 409, message: '현재 상태에서는 이 이벤트를 다시 처리할 수 없습니다.' },
  INBOX_NOT_RETRYABLE: { status: 409, message: '거절된 결제 이벤트는 다시 승인할 수 없습니다.' },
  INBOX_CAPACITY: { status: 409, message: '카드 수신 기록이 처리 범위를 초과합니다.' },
};

function invalid(): never {
  throw new LedgerError(400, 'INVALID_INBOX_COMMAND', failures.INVALID_INBOX_COMMAND.message);
}

function commandError(error: unknown, invalidCode: 'INVALID_CARD_EVENT' | 'INVALID_INBOX_COMMAND'): never {
  if (error instanceof LedgerError) throw error;
  const pg = error as { code?: string; message?: string } | null;
  const failure = pg?.message ? failures[pg.message] : undefined;
  if (failure) throw new LedgerError(failure.status, pg!.message!, failure.message);
  if (pg?.code === '22023') throw new LedgerError(400, invalidCode, failures[invalidCode].message);
  if (pg?.code === '23505') throw new LedgerError(409, 'IDEMPOTENCY_CONFLICT', failures.IDEMPOTENCY_CONFLICT.message);
  if (pg?.code === '22003') throw new LedgerError(409, 'INBOX_CAPACITY', failures.INBOX_CAPACITY.message);
  if (pg?.code === '55P03' || pg?.code === '40P01' || pg?.code === '40001') {
    throw new LedgerError(503, 'DATABASE_BUSY', '다른 요청을 처리하고 있습니다. 같은 요청 번호로 다시 확인해 주세요.');
  }
  throw error;
}

/** An acknowledgement records receipt only. The worker commits the ledger and completion together. */
export class CardInboxStore {
  readonly database: Database;
  private readonly clock: () => number;

  constructor(database: Database, options: { now?: () => number } = {}) {
    this.database = database;
    this.clock = options.now ?? Date.now;
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > maxClock) {
      throw new LedgerError(500, 'INVALID_CLOCK', '서버 시간을 확인할 수 없습니다.');
    }
    return now;
  }

  async enqueue(input: SandboxCardEvent): Promise<InboxReceipt> {
    const parsed = parseSandboxCardEvent(input);
    const event = parsed.kind === 'authorize' ? { ...parsed, merchantName: parsed.merchantName.trim() } : { ...parsed };
    const now = this.now();
    const canonical = JSON.stringify(event);
    try {
      return await this.database.transaction(async (client) => {
        const { rows } = await client.query<{ result: InboxReceipt }>('SELECT enqueue_sandbox_card_event($1::jsonb, $2::bigint) AS result', [canonical, now]);
        return rows[0].result;
      }, { isolation: 'read committed' });
    } catch (error) { return commandError(error, 'INVALID_CARD_EVENT'); }
  }

  async processNext(): Promise<InboxProcessResult | null> {
    const now = this.now();
    try {
      return await this.database.transaction(async (client) => {
        const { rows } = await client.query<{ result: InboxProcessResult | null }>('SELECT process_card_inbox($1::bigint) AS result', [now]);
        return rows[0].result;
      }, { isolation: 'read committed' });
    } catch (error) { return commandError(error, 'INVALID_INBOX_COMMAND'); }
  }

  async expireHold(): Promise<HoldExpiration | null> {
    const { rows } = await this.database.query<{ result: HoldExpiration | null }>(
      'SELECT expire_sandbox_card_hold($1::bigint) AS result', [this.now()]);
    return rows[0].result;
  }

  async resolveCapture(input: CaptureResolutionInput): Promise<CaptureResolutionResult> {
    try {
      const { rows } = await this.database.query<{ result: CaptureResolutionResult }>(
        'SELECT operator_resolve_card_capture($1::jsonb,$2::bigint) AS result', [JSON.stringify(input), this.now()]);
      return rows[0].result;
    } catch (error) { return commandError(error, 'INVALID_INBOX_COMMAND'); }
  }

  async stats(): Promise<InboxStats> {
    const now = this.now();
    try {
      const { rows } = await this.database.query<{ result: InboxStats }>('SELECT card_inbox_stats($1::bigint) AS result', [now]);
      return rows[0].result;
    } catch (error) { return commandError(error, 'INVALID_INBOX_COMMAND'); }
  }

  async requeue(input: InboxRequeueInput): Promise<InboxRequeueResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
    const fields = ['id', 'idempotencyKey', 'reason', 'expectedVersion'];
    if (Object.keys(input).length !== fields.length || fields.some((field) => !Object.hasOwn(input, field))) invalid();
    if (typeof input.id !== 'string' || !idPattern.test(input.id)
      || typeof input.idempotencyKey !== 'string' || !keyPattern.test(input.idempotencyKey)
      || typeof input.reason !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(input.reason)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid();
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 500) invalid();
    const command = JSON.stringify({ id: input.id, idempotencyKey: input.idempotencyKey, reason, expectedVersion: input.expectedVersion });
    const now = this.now();
    try {
      return await this.database.transaction(async (client) => {
        const { rows } = await client.query<{ result: InboxRequeueResult }>('SELECT operator_retry_card_inbox($1::jsonb, $2::bigint) AS result', [command, now]);
        return rows[0].result;
      }, { isolation: 'read committed' });
    } catch (error) { return commandError(error, 'INVALID_INBOX_COMMAND'); }
  }
}
