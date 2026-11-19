import type { SandboxCardEvent } from '../shared/api';
import { LedgerError } from './ledger';

/** Keep the operator boundary strict: no card numbers, security codes, arbitrary metadata or issuer payloads. */
export function parseSandboxCardEvent(input: unknown): SandboxCardEvent {
  const invalid = () => new LedgerError(400, 'INVALID_CARD_EVENT', '카드 테스트 이벤트 형식을 확인해 주세요.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const event = input as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    authorize: ['amountWon', 'merchantName'], capture: ['amountWon', 'finalCapture'], reverse: [], refund: ['amountWon'],
  };
  if (typeof event.kind !== 'string' || !Object.hasOwn(fields, event.kind)) throw invalid();
  const allowed = ['kind', 'eventId', 'paymentId', 'userId', ...fields[event.kind]];
  if (Object.keys(event).length !== allowed.length || allowed.some((key) => !Object.hasOwn(event, key)) || Object.keys(event).some((key) => !allowed.includes(key))) throw invalid();
  for (const key of ['eventId', 'paymentId', 'userId']) {
    if (typeof event[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event[key])) throw invalid();
  }
  if (event.kind !== 'reverse' && (!Number.isSafeInteger(event.amountWon) || (event.amountWon as number) < 1)) throw invalid();
  if (event.kind === 'capture' && typeof event.finalCapture !== 'boolean') throw invalid();
  if (event.kind === 'authorize' && (typeof event.merchantName !== 'string' || !event.merchantName.trim() || event.merchantName.length > 100 || /[\u0000-\u001f\u007f]/.test(event.merchantName))) throw invalid();
  return event as SandboxCardEvent;
}
