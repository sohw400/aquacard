import type { IssuerCardSnapshot, IssuerCardStatus, IssuerCardStatusReceipt } from '../../shared/api';
import { ApiError } from './api';

export interface IssuerIntent {
  key: string;
  cardId: string;
  targetStatus: IssuerCardStatus;
  expectedVersion: number;
  createdAt: number;
}
export type IssuerIntentRead = { status: 'ready'; intents: IssuerIntent[] } | { status: 'unavailable' | 'corrupt'; intents: [] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-zA-Z0-9_-]{16,128}$/;
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8_640_000_000_000_000;
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const cardStatus = (value: unknown): value is IssuerCardStatus => value === 'active' || value === 'locked';
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export const issuerIntentPrefix = (ownerId: string) => `aqua.server.issuer.${encodeURIComponent(ownerId).replaceAll('.', '%2E')}.`;
const storageKey = (ownerId: string, key: string) => issuerIntentPrefix(ownerId) + key;
const same = (left: IssuerIntent, right: IssuerIntent) => left.key === right.key && left.cardId === right.cardId
  && left.targetStatus === right.targetStatus && left.expectedVersion === right.expectedVersion && left.createdAt === right.createdAt;

function parseIntent(value: unknown): IssuerIntent {
  if (!object(value) || !exact(value, ['key', 'cardId', 'targetStatus', 'expectedVersion', 'createdAt'])
    || typeof value.key !== 'string' || !KEY.test(value.key) || !uuid(value.cardId) || !cardStatus(value.targetStatus)
    || !integer(value.expectedVersion, 1) || value.expectedVersion >= Number.MAX_SAFE_INTEGER || !timestamp(value.createdAt)) {
    throw new Error('Invalid saved issuer request.');
  }
  return { key: value.key, cardId: value.cardId, targetStatus: value.targetStatus, expectedVersion: value.expectedVersion, createdAt: value.createdAt };
}

/** Each request has its own durable entry. Concurrent tabs never overwrite another request's key. */
export function readIssuerIntents(ownerId: string): IssuerIntentRead {
  try {
    const storage = localStorage;
    const prefix = issuerIntentPrefix(ownerId);
    const entries: string[] = [];
    // Snapshot keys before reading values; other tabs may add or remove an entry during a scan.
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) entries.push(key);
    }
    const intents: IssuerIntent[] = [];
    for (const key of new Set(entries)) {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      try {
        if (raw.length > 1_024) return { status: 'corrupt', intents: [] };
        const intent = parseIntent(JSON.parse(raw));
        if (storageKey(ownerId, intent.key) !== key) return { status: 'corrupt', intents: [] };
        intents.push(intent);
      } catch { return { status: 'corrupt', intents: [] }; }
    }
    intents.sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
    return { status: 'ready', intents };
  } catch { return { status: 'unavailable', intents: [] }; }
}

export function storeIssuerIntent(ownerId: string, input: IssuerIntent): void {
  const intent = parseIntent(input);
  const key = storageKey(ownerId, intent.key);
  const storage = localStorage;
  const existing = storage.getItem(key);
  if (existing !== null && !same(parseIntent(JSON.parse(existing)), intent)) throw new Error('A different issuer request already uses this key.');
  const data = JSON.stringify(intent);
  storage.setItem(key, data);
  if (storage.getItem(key) !== data) throw new Error('Issuer request was not persisted.');
}

/** Failed removal remains visible to the caller; it cannot silently enable a replacement request. */
export function clearIssuerIntent(ownerId: string, input: IssuerIntent): void {
  const intent = parseIntent(input);
  const key = storageKey(ownerId, intent.key);
  const storage = localStorage;
  const raw = storage.getItem(key);
  if (raw === null) return;
  if (!same(parseIntent(JSON.parse(raw)), intent)) throw new Error('Saved issuer request changed before acknowledgement.');
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error('Issuer acknowledgement was not persisted.');
}

export function newIssuerIntentKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('Secure request identifiers are unavailable.');
  return globalThis.crypto.randomUUID();
}

export function parseIssuerSnapshot(value: unknown): IssuerCardSnapshot {
  const invalid = () => { throw new Error('Invalid issuer card response.'); };
  if (!object(value) || !exact(value, ['mode', 'canRequestStatus', 'card']) || value.mode !== 'sandbox' || typeof value.canRequestStatus !== 'boolean') return invalid();
  if (value.card === null) return { mode: 'sandbox', canRequestStatus: value.canRequestStatus, card: null };
  const card = value.card;
  if (!object(card) || !exact(card, ['id', 'desiredStatus', 'confirmedStatus', 'version', 'updatedAt', 'command']) || !uuid(card.id)
    || !cardStatus(card.desiredStatus) || !cardStatus(card.confirmedStatus) || !integer(card.version, 1) || !timestamp(card.updatedAt)) return invalid();
  if (card.command === null) {
    if (card.desiredStatus !== card.confirmedStatus) return invalid();
  } else {
    const command = card.command;
    if (!object(command) || !exact(command, ['id', 'status', 'phase', 'attemptCount', 'errorCode', 'createdAt', 'updatedAt'])
      || !uuid(command.id) || typeof command.status !== 'string' || !['pending', 'in_flight', 'retry', 'succeeded', 'failed', 'needs_review'].includes(command.status)
      || typeof command.phase !== 'string' || !['send', 'lookup'].includes(command.phase) || !integer(command.attemptCount)
      || !(command.errorCode === null || (typeof command.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(command.errorCode)))
      || !timestamp(command.createdAt) || !timestamp(command.updatedAt) || command.updatedAt < command.createdAt
      || (command.status === 'succeeded' && card.desiredStatus !== card.confirmedStatus)) return invalid();
  }
  return value as unknown as IssuerCardSnapshot;
}

export function issuerSnapshotDoesNotRegress(previous: IssuerCardSnapshot | null, next: IssuerCardSnapshot): boolean {
  if (!previous?.card) return true;
  if (!next.card || previous.card.id !== next.card.id || next.card.version < previous.card.version || next.card.updatedAt < previous.card.updatedAt) return false;
  const oldCommand = previous.card.command, command = next.card.command;
  if (oldCommand && !command) return false;
  if (oldCommand && command?.id === oldCommand.id) {
    if (command.updatedAt < oldCommand.updatedAt || command.attemptCount < oldCommand.attemptCount) return false;
    if (['succeeded', 'failed'].includes(oldCommand.status) && command.status !== oldCommand.status) return false;
  } else if (next.card.version === previous.card.version && oldCommand?.id !== command?.id) return false;
  if (next.card.version === previous.card.version
    && (previous.card.confirmedStatus !== next.card.confirmedStatus || previous.card.desiredStatus !== next.card.desiredStatus)) return false;
  return true;
}

export function parseIssuerReceipt(value: unknown, intent: IssuerIntent): IssuerCardStatusReceipt {
  if (!object(value) || !exact(value, ['id', 'cardId', 'status', 'cardVersion', 'duplicate']) || !uuid(value.id)
    || value.cardId !== intent.cardId || value.status !== 'pending' || value.cardVersion !== intent.expectedVersion + 1
    || typeof value.duplicate !== 'boolean') throw new Error('Unexpected issuer request acknowledgement.');
  return value as unknown as IssuerCardStatusReceipt;
}

export function issuerRequestWasRejected(error: unknown): boolean {
  return error instanceof ApiError && ((error.status === 409 && ['OUTBOX_VERSION_CHANGED', 'OUTBOX_PENDING'].includes(error.code))
    || (error.status === 404 && error.code === 'OUTBOX_CARD_NOT_FOUND')
    || (error.status === 403 && error.code === 'CUSTOMER_ACCESS_REQUIRED'));
}
