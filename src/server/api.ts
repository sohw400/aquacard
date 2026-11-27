import type { FundingInput, MemberFunding } from '../../shared/funding';
import type { CardActivityPage, CardDeclinePage, TransferActivityPage } from '../../shared/account-activity';
import type { ReserveSnapshot, AccountSnapshot, EmailVerificationSnapshot, IssuerCardSnapshot, IssuerCardStatus, IssuerCardStatusReceipt, MemberProfile, RewardPreferenceResult, SessionSecuritySnapshot, TransferResult } from '../../shared/api';
import type { CardApplication, CardApplicationSnapshot } from '../../shared/api';
export type { EmailVerificationSnapshot } from '../../shared/api';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal; key?: string; ownerId?: string; summary?: boolean; expectedStatus?: number } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json', ...(options.summary ? { 'X-Aqua-View': 'summary' } : {}), ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.key ? { 'Idempotency-Key': options.key } : {}), ...(options.ownerId ? { 'X-Aqua-Account': options.ownerId } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const details = typeof data === 'object' && data !== null && 'error' in data ? (data as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    throw new ApiError(response.status, typeof details?.code === 'string' ? details.code : `HTTP_${response.status}`, typeof details?.message === 'string' ? details.message : '서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (data === null) throw new Error('서버 응답을 확인하지 못했습니다.');
  if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) throw new Error('요청 결과의 응답 형식을 확인하지 못했습니다.');
  return data as T;
}

export type Recipient = Pick<MemberProfile, 'id' | 'name' | 'tag'>;

export const api = {
  session: (signal?: AbortSignal) => request<{ user: MemberProfile | null }>('/session', { signal }),
  signup: (body: { name: string; email: string; tag: string; password: string }, signal?: AbortSignal) => request<{ user: MemberProfile }>('/auth/signup', { method: 'POST', body, signal, expectedStatus: 201 }),
  login: (body: { email: string; password: string }, signal?: AbortSignal) => request<{ user: MemberProfile }>('/auth/login', { method: 'POST', body, signal, expectedStatus: 200 }),
  logout: (ownerId: string) => request<{ ok: true }>('/auth/logout', { method: 'POST', body: {}, ownerId }),
  sessions: (ownerId: string, signal?: AbortSignal) => request<SessionSecuritySnapshot>('/auth/sessions', { ownerId, signal, expectedStatus: 200 }),
  reauthenticate: (password: string, ownerId: string, signal?: AbortSignal) => request<{ reauthenticatedUntil: number }>('/auth/reauthenticate', { method: 'POST', body: { password }, ownerId, signal, expectedStatus: 200 }),
  revokeSession: (sessionId: string, ownerId: string, signal?: AbortSignal) => request<{ revokedCurrent: boolean }>('/auth/sessions/revoke', { method: 'POST', body: { sessionId }, ownerId, signal, expectedStatus: 200 }),
  revokeOtherSessions: (ownerId: string, signal?: AbortSignal) => request<{ revokedCount: number }>('/auth/sessions/revoke-others', { method: 'POST', body: {}, ownerId, signal, expectedStatus: 200 }),
  emailVerification: (ownerId: string, signal?: AbortSignal) => request<EmailVerificationSnapshot>('/auth/email', { ownerId, signal, expectedStatus: 200 }),
  requestEmailVerification: (ownerId: string, signal?: AbortSignal) => request<{ ok: true }>('/auth/email/request', { method: 'POST', body: {}, ownerId, signal, expectedStatus: 202 }),
  confirmEmailVerification: (token: string, ownerId: string, signal?: AbortSignal) => request<{ ok: true }>('/auth/email/confirm', { method: 'POST', body: { token }, ownerId, signal, expectedStatus: 200 }),
  funding: (ownerId: string, signal?: AbortSignal) => request<MemberFunding[]>('/funding', {ownerId,signal}),
  fundingIntent: (body: FundingInput, key: string, ownerId: string) => request<MemberFunding>('/funding', {method:'POST',body,key,ownerId}),
  account: (signal?: AbortSignal, summary = false) => request<AccountSnapshot>('/account', { signal, summary }),
  declineHistory: (ownerId: string, cursor: string | undefined, signal: AbortSignal) =>
    request<CardDeclinePage>('/account/activity/declines' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { ownerId, signal }),
  cardHistory: (ownerId: string, cursor: string, signal: AbortSignal) =>
    request<CardActivityPage>('/account/activity/cards?cursor=' + encodeURIComponent(cursor), { ownerId, signal }),
  rewardHistory: (ownerId: string, cursor: string | null, signal: AbortSignal) =>
    request<import('../../shared/account-activity').RewardActivityPage>('/account/activity/rewards' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { ownerId, signal }),
  transferHistory: (ownerId: string, cursor: string, signal: AbortSignal) =>
    request<TransferActivityPage>('/account/activity/transfers?cursor=' + encodeURIComponent(cursor), { ownerId, signal }),
  member: (tag: string, signal?: AbortSignal) => request<{ member: Recipient }>(`/members?tag=${encodeURIComponent(tag)}`, { signal }),
  transfer: (body: { recipientTag: string; amountWon: number }, key: string, ownerId: string) => request<TransferResult>('/transfers', { method: 'POST', body, key, ownerId }),
  reserveMove: (body: { direction: 'in' | 'out'; amountWon: number }, key: string, ownerId: string) =>
    request<ReserveSnapshot>('/reserve/movement', { method: 'POST', body, key, ownerId }),
  reservePreference: (body: { autoUse: boolean; expectedVersion: number }, key: string, ownerId: string) =>
    request<ReserveSnapshot>('/reserve/preference', { method: 'POST', body, key, ownerId }),
  rewardPreference: (body: { useFirst: boolean; expectedVersion: number }, key: string, ownerId: string) => request<RewardPreferenceResult>('/rewards/preference', { method: 'POST', body, key, ownerId }),
  issuerCard: (ownerId: string, signal?: AbortSignal) => request<IssuerCardSnapshot>('/issuer-card', { ownerId, signal, expectedStatus: 200 }),
  cardApplication: (ownerId: string, signal?: AbortSignal) => request<CardApplicationSnapshot>('/card-application', { ownerId, signal, expectedStatus: 200 }),
  submitCardApplication: (form: CardApplication['form'], key: string, ownerId: string) =>
    request<CardApplication>('/card-application', { method: 'POST', body: { form }, key, ownerId, expectedStatus: 201 }),
  activateCardApplication: (body: { applicationId: string; expectedVersion: number }, key: string, ownerId: string) =>
    request<CardApplication>('/card-application/activate', { method: 'POST', body, key, ownerId, expectedStatus: 200 }),
  issuerCardStatus: (body: { cardId: string; targetStatus: IssuerCardStatus; expectedVersion: number }, key: string, ownerId: string, signal?: AbortSignal) => request<IssuerCardStatusReceipt>('/issuer-card/status', { method: 'POST', body, key, ownerId, signal, expectedStatus: 202 }),
  requestRecovery: (email: string, signal?: AbortSignal) => request<{ ok: true }>('/auth/recovery/request', { method: 'POST', body: { email }, signal, expectedStatus: 202 }),
  confirmRecovery: (token: string, password: string, signal?: AbortSignal) => request<{ ok: true }>('/auth/recovery/confirm', { method: 'POST', body: { token, password }, signal, expectedStatus: 200 }),
};

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function outcomeUncertain(error: unknown): boolean {
  // A gateway failure or changed session cannot prove that a previous attempt did not commit.
  const rejected: Record<string, number> = {
    INVALID_AMOUNT: 400, INVALID_INPUT: 400, RECIPIENT_NOT_FOUND: 404, SELF_TRANSFER: 400,
    INSUFFICIENT_FUNDS: 409, LIMIT_EXCEEDED: 409, RECIPIENT_BALANCE_LIMIT: 409,
    CUSTOMER_ACCESS_REQUIRED: 403, EMAIL_VERIFICATION_REQUIRED: 403,
  };
  return !(error instanceof ApiError) || rejected[error.code] !== error.status;
}
