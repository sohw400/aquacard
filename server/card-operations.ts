import type { QueryResultRow } from 'pg';
import type { Database } from './database';
import { LedgerError } from './errors';
import type { IssuerCardStatus, IssuerOutboxPhase, IssuerOutboxStatus } from './issuer-outbox';

export interface CardOperationsInput {
  requestId: string;
  lookup: { kind: 'event' | 'inbox'; id: string };
  caseReference: string;
}

export interface CardOperationsReceipt { requestId: string; preparedAt: number; duplicate: boolean }
type EventKind = 'authorize' | 'capture' | 'reverse' | 'refund';
type InboxStatus = 'pending' | 'retry' | 'applied' | 'dead_letter';
type PolicyReason = 'CARD_NOT_ISSUED' | 'CARD_LOCKED' | 'CARD_STATUS_UNCONFIRMED';

export interface CardOperationsReport {
  version: 1;
  mode: 'sandbox';
  requestId: string;
  preparedAt: number;
  lookup: CardOperationsInput['lookup'];
  caseReference: string;
  found: boolean;
  correlation: 'consistent' | 'conflict' | 'single_source' | 'not_found';
  authorization: null | {
    eventId: string; paymentId: string; userId: string; decision: 'approved' | 'declined'; reason: PolicyReason | null;
    amountWon: number; policyVersion: number; eventReceivedAt: number; decidedAt: number;
    cardAtDecision: null | {
      id: string; version: number; desiredStatus: IssuerCardStatus; confirmedStatus: IssuerCardStatus;
      commandId: string | null; commandStatus: IssuerOutboxStatus | null;
    };
  };
  ledgerEvent: null | {
    eventId: string; paymentId: string; userId: string; kind: EventKind; amountWon: number | null;
    finalCapture: boolean | null; createdAt: number; legacyPolicy: boolean;
  };
  inbox: null | {
    id: string; eventId: string; paymentId: string; userId: string; kind: EventKind; amountWon: number | null;
    finalCapture: boolean | null; status: InboxStatus; receivedAt: number; processedAt: number | null; updatedAt: number;
    nextAttemptAt: number | null; attemptCount: number; cycleAttempts: number; version: number; errorCode: string | null;
    retryEligible: boolean; attemptsTruncated: boolean; attemptLimit: 20;
    attempts: Array<{
      attemptNo: number; cycleAttempt: number; version: number; attemptedAt: number; status: Exclude<InboxStatus, 'pending'>;
      errorCode: string | null; nextAttemptAt: number | null;
    }>;
  };
  payment: null | {
    id: string; userId: string;
    status: 'authorized' | 'partially_captured' | 'captured' | 'cancelled' | 'partially_refunded' | 'refunded';
    authorizedWon: number; heldWon: number; capturedWon: number; releasedWon: number; refundedWon: number;
    createdAt: number; updatedAt: number;
  };
  issuerCommand: null | {
    id: string; cardId: string; userId: string; targetStatus: IssuerCardStatus; status: IssuerOutboxStatus;
    phase: IssuerOutboxPhase; version: number; attemptCount: number; cycleAttempts: number; errorCode: string | null;
    nextAttemptAt: number | null; createdAt: number; updatedAt: number; expiresAt: number;
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const invalid = () => new LedgerError(400, 'INVALID_OPS_REQUEST', '운영 조회 요청의 식별자와 형식을 확인해 주세요.');
const failures: Record<string, { status: number; message: string }> = {
  INVALID_OPS_REQUEST: { status: 400, message: '운영 조회 요청의 식별자와 형식을 확인해 주세요.' },
  OPS_REQUEST_CONFLICT: { status: 409, message: '같은 조회 요청 번호에 다른 내용이 있습니다.' },
  OPS_COMMIT_REQUIRED: { status: 409, message: '조회 기록을 커밋한 뒤 별도 트랜잭션에서 결과를 확인해 주세요.' },
  OPS_SNAPSHOT_REQUIRED: { status: 500, message: '운영 조회에는 일관된 데이터베이스 스냅샷이 필요합니다.' },
  OPS_REPORT_NOT_FOUND: { status: 404, message: '현재 운영 계정에서 확인할 수 있는 조회 기록이 없습니다.' },
  OPS_UNAVAILABLE: { status: 503, message: '운영 조회를 완료할 수 없습니다. 같은 요청 번호로 다시 확인해 주세요.' },
};

function exactObject(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
export function parseCardOperationsRequestId(value: unknown): string {
  if (!matches(value, uuid)) throw invalid();
  return value;
}
export function parseCardOperationsInput(value: unknown): CardOperationsInput {
  if (!exactObject(value, ['requestId', 'lookup', 'caseReference'])) throw invalid();
  const requestId = parseCardOperationsRequestId(value.requestId);
  if (!exactObject(value.lookup, ['kind', 'id']) || !['event', 'inbox'].includes(value.lookup.kind as string)
    || !matches(value.lookup.id, value.lookup.kind === 'inbox' ? uuid : identifier)
    || !matches(value.caseReference, identifier)) throw invalid();
  return { requestId, lookup: { kind: value.lookup.kind as 'event' | 'inbox', id: value.lookup.id }, caseReference: value.caseReference };
}
function commandError(error: unknown): never {
  if (error instanceof LedgerError) throw error;
  const pg = error as { code?: string; message?: string } | null;
  const known = pg?.message ? failures[pg.message] : undefined;
  if (known) throw new LedgerError(known.status, pg!.message!, known.message);
  if (pg?.code === '22023') throw invalid();
  if (['55P03', '40P01', '40001'].includes(pg?.code ?? '')) {
    throw new LedgerError(503, 'DATABASE_BUSY', '다른 조회를 처리하고 있습니다. 같은 요청 번호와 내용으로 다시 확인해 주세요.');
  }
  throw new LedgerError(503, 'OPS_UNAVAILABLE', failures.OPS_UNAVAILABLE.message);
}

/** Preparing an immutable report and disclosing it must use separate transactions. */
export class CardOperationsStore {
  readonly database: Database;
  constructor(database: Database) { this.database = database; }

  async prepare(input: CardOperationsInput): Promise<CardOperationsReceipt> {
    const command = parseCardOperationsInput(input);
    try {
      const { rows } = await this.database.transaction((client) => client.query<QueryResultRow & { receipt: CardOperationsReceipt }>(
        'SELECT prepare_card_operations_report($1::jsonb) AS receipt', [JSON.stringify(command)]), { isolation: 'repeatable read' });
      const receipt = rows[0]?.receipt;
      if (!exactObject(receipt, ['requestId', 'preparedAt', 'duplicate']) || receipt.requestId !== command.requestId
        || !Number.isSafeInteger(receipt.preparedAt) || receipt.preparedAt < 0 || typeof receipt.duplicate !== 'boolean') {
        throw new Error('Invalid operations receipt.');
      }
      return receipt;
    } catch (error) { return commandError(error); }
  }

  async read(requestId: string): Promise<CardOperationsReport> {
    const id = parseCardOperationsRequestId(requestId);
    try {
      const { rows } = await this.database.query<QueryResultRow & { report: CardOperationsReport }>(
        'SELECT read_card_operations_report($1::text) AS report', [id]);
      const report = rows[0]?.report;
      if (!exactObject(report, ['version', 'mode', 'requestId', 'preparedAt', 'lookup', 'caseReference', 'found', 'correlation',
        'authorization', 'ledgerEvent', 'inbox', 'payment', 'issuerCommand']) || report.version !== 1 || report.mode !== 'sandbox'
        || report.requestId !== id || !Number.isSafeInteger(report.preparedAt) || report.preparedAt < 0
        || typeof report.found !== 'boolean' || !['consistent', 'conflict', 'single_source', 'not_found'].includes(report.correlation)) {
        throw new Error('Invalid operations report.');
      }
      try { parseCardOperationsInput({ requestId: report.requestId, lookup: report.lookup, caseReference: report.caseReference }); }
      catch { throw new Error('Invalid operations report identity.'); }
      return report;
    } catch (error) { return commandError(error); }
  }

  async trace(input: CardOperationsInput): Promise<CardOperationsReport> {
    // Do not move the read into the preparation callback or retry an ambiguous
    // commit. The original request ID recovers the already committed snapshot.
    const receipt = await this.prepare(input);
    return this.read(receipt.requestId);
  }
}
