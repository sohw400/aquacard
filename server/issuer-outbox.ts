import type { Database } from './database';
import { LedgerError } from './errors';

export type IssuerCardStatus = 'active' | 'locked';
export type IssuerOutboxStatus = 'pending' | 'in_flight' | 'retry' | 'succeeded' | 'failed' | 'needs_review';
export type IssuerOutboxPhase = 'send' | 'lookup';
export interface IssuerCardSnapshot {
  mode: 'sandbox';
  card: null | {
    id: string; desiredStatus: IssuerCardStatus; confirmedStatus: IssuerCardStatus; version: number; updatedAt: number;
    command: null | { id: string; status: IssuerOutboxStatus; phase: IssuerOutboxPhase; attemptCount: number; errorCode: string | null; createdAt: number; updatedAt: number };
  };
}
export interface IssuerCardStatusInput {
  userId: string; cardId: string; targetStatus: IssuerCardStatus; expectedVersion: number; idempotencyKey: string;
}
export interface IssuerCardStatusReceipt {
  id: string; cardId: string; status: 'pending'; cardVersion: number; duplicate: boolean;
}
export interface IssuerOutboxClaim {
  id: string; cardId: string; providerCardId: string; requestKey: string; targetStatus: IssuerCardStatus; phase: IssuerOutboxPhase;
  leaseToken: string; version: number; leaseUntil: number; expiresAt: number; attemptCount: number;
}
export type IssuerOutboxOutcome =
  | { kind: 'succeeded' | 'not_found' }
  | { kind: 'rejected'; code?: 'CARD_NOT_FOUND' | 'CARD_CLOSED' | 'COMMAND_REJECTED' }
  | { kind: 'uncertain'; code?: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_PENDING' | 'PROVIDER_TIMEOUT' | 'PROVIDER_INVALID_RESPONSE' | 'IDEMPOTENCY_WINDOW_EXPIRED' };
export interface IssuerOutboxFinishInput { id: string; leaseToken: string; expectedVersion: number; outcome: IssuerOutboxOutcome }
export interface IssuerOutboxFinishResult {
  id: string; status: 'retry' | 'succeeded' | 'failed' | 'needs_review'; version: number; nextAttemptAt: number | null; errorCode: string | null;
}
export interface IssuerOutboxStats {
  pending: string; inFlight: string; retry: string; succeeded: string; failed: string; needsReview: string; due: string; oldestPendingAt: number | null;
}
export interface IssuerOutboxRequeueInput { id: string; expectedVersion: number; idempotencyKey: string; reason: string }
export interface IssuerOutboxRequeueResult { id: string; status: 'pending'; version: number }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const maxClock = 8.64e15 - 86_400_000;
const failures: Record<string, { status: number; message: string }> = {
  INVALID_OUTBOX_COMMAND: { status: 400, message: '카드 상태 요청 내용을 확인해 주세요.' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: '같은 요청 번호에 다른 내용이 있습니다.' },
  OUTBOX_CARD_NOT_FOUND: { status: 404, message: '카드 상태 기록을 찾을 수 없습니다.' },
  OUTBOX_CARD_CONFLICT: { status: 409, message: '이미 등록된 카드 정보와 일치하지 않습니다.' },
  OUTBOX_VERSION_CHANGED: { status: 409, message: '카드 상태가 변경되었습니다. 최신 상태를 확인해 주세요.' },
  OUTBOX_PENDING: { status: 409, message: '이전 카드 요청의 결과를 확인하고 있습니다.' },
  OUTBOX_LEASE_LOST: { status: 409, message: '이 작업의 처리 권한이 만료되었습니다.' },
  OUTBOX_NOT_RETRYABLE: { status: 409, message: '이 상태에서는 다시 처리할 수 없습니다.' },
  OUTBOX_CAPACITY: { status: 409, message: '카드 처리 기록이 허용 범위를 초과합니다.' },
};
function invalid(): never { throw new LedgerError(400, 'INVALID_OUTBOX_COMMAND', failures.INVALID_OUTBOX_COMMAND.message); }
function object(input: unknown, fields: string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length || fields.some((field) => !Object.hasOwn(input, field))) invalid();
}
const validText = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value);
const validVersion = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const validStatus = (value: unknown) => value === 'active' || value === 'locked';
function commandError(error: unknown, registration = false): never {
  if (error instanceof LedgerError) throw error;
  const pg = error as { code?: string; message?: string } | null;
  const known = pg?.message ? failures[pg.message] : undefined;
  if (known) throw new LedgerError(known.status, pg!.message!, known.message);
  if (pg?.code === '22023') invalid();
  if (pg?.code === '23505') {
    const code = registration ? 'OUTBOX_CARD_CONFLICT' : 'IDEMPOTENCY_CONFLICT';
    throw new LedgerError(409, code, failures[code].message);
  }
  if (pg?.code === '22003') throw new LedgerError(409, 'OUTBOX_CAPACITY', failures.OUTBOX_CAPACITY.message);
  if (['55P03', '40P01', '40001'].includes(pg?.code ?? '')) throw new LedgerError(503, 'DATABASE_BUSY', '다른 요청을 처리하고 있습니다. 같은 요청 번호로 다시 확인해 주세요.');
  throw error;
}

/** A claim transaction finishes before callers perform any external request. */
export class IssuerOutboxStore {
  readonly database: Database;
  private readonly clock: () => number;
  constructor(database: Database, options: { now?: () => number } = {}) {
    this.database = database; this.clock = options.now ?? Date.now;
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > maxClock) throw new LedgerError(500, 'INVALID_CLOCK', '서버 시간을 확인할 수 없습니다.');
    return now;
  }
  private async command<T>(fn: string, input?: unknown, registration = false): Promise<T> {
    const now = this.now();
    try {
      return await this.database.transaction(async (client) => {
        const { rows } = input === undefined
          ? await client.query<{ result: T }>(`SELECT ${fn}($1::bigint) AS result`, [now])
          : await client.query<{ result: T }>(`SELECT ${fn}($1::jsonb,$2::bigint) AS result`, [JSON.stringify(input), now]);
        return rows[0].result;
      });
    } catch (error) { return commandError(error, registration); }
  }
  async register(input: { userId: string; providerCardId: string; initialStatus: IssuerCardStatus }): Promise<{ cardId: string }> {
    object(input, ['userId', 'providerCardId', 'initialStatus']);
    if (!validText(input.userId, key) || !validText(input.providerCardId, /^sandbox-card-[A-Za-z0-9_-]{1,100}$/) || !validStatus(input.initialStatus)) invalid();
    return this.command('register_sandbox_issuer_card', input, true);
  }
  async snapshot(userId: string): Promise<IssuerCardSnapshot> {
    if (!validText(userId, key)) invalid();
    try {
      const { rows } = await this.database.query<{ result: IssuerCardSnapshot }>('SELECT issuer_card_snapshot($1::text) AS result', [userId]);
      return rows[0].result;
    } catch (error) { return commandError(error); }
  }
  async requestStatus(input: IssuerCardStatusInput): Promise<IssuerCardStatusReceipt> {
    object(input, ['userId', 'cardId', 'targetStatus', 'expectedVersion', 'idempotencyKey']);
    if (!validText(input.userId, key) || !validText(input.cardId, uuid) || !validStatus(input.targetStatus)
      || !validVersion(input.expectedVersion) || !validText(input.idempotencyKey, key)) invalid();
    return this.command('request_issuer_card_status', input);
  }
  async claim(): Promise<IssuerOutboxClaim | null> { return this.command('claim_issuer_outbox'); }
  async finish(input: IssuerOutboxFinishInput): Promise<IssuerOutboxFinishResult> {
    object(input, ['id', 'leaseToken', 'expectedVersion', 'outcome']);
    if (!validText(input.id, uuid) || !validText(input.leaseToken, uuid) || !validVersion(input.expectedVersion)) invalid();
    const outcome: unknown = input.outcome;
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) invalid();
    const withCode = Object.hasOwn(outcome, 'code');
    object(outcome, withCode ? ['kind', 'code'] : ['kind']);
    if (!['succeeded', 'rejected', 'uncertain', 'not_found'].includes(outcome.kind as string)) invalid();
    if (withCode && (outcome.kind === 'succeeded' || outcome.kind === 'not_found')) invalid();
    if (withCode && outcome.kind === 'rejected' && !['CARD_NOT_FOUND', 'CARD_CLOSED', 'COMMAND_REJECTED'].includes(outcome.code as string)) invalid();
    if (withCode && outcome.kind === 'uncertain' && !['PROVIDER_UNAVAILABLE', 'PROVIDER_PENDING', 'PROVIDER_TIMEOUT', 'PROVIDER_INVALID_RESPONSE', 'IDEMPOTENCY_WINDOW_EXPIRED'].includes(outcome.code as string)) invalid();
    return this.command('finish_issuer_outbox', input);
  }
  async stats(): Promise<IssuerOutboxStats> {
    try {
      const { rows } = await this.database.query<{ result: IssuerOutboxStats }>('SELECT issuer_outbox_stats($1::bigint) AS result', [this.now()]);
      return rows[0].result;
    } catch (error) { return commandError(error); }
  }
  async requeue(input: IssuerOutboxRequeueInput): Promise<IssuerOutboxRequeueResult> {
    object(input, ['id', 'expectedVersion', 'idempotencyKey', 'reason']);
    if (!validText(input.id, uuid) || !validVersion(input.expectedVersion) || !validText(input.idempotencyKey, key)
      || typeof input.reason !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(input.reason)) invalid();
    const reason = input.reason.trim();
    if ([...reason].length < 10 || [...reason].length > 500) invalid();
    return this.command('operator_retry_issuer_outbox', { ...input, reason });
  }
}
