import type { AccountSnapshot, MemberProfile, RewardPreferenceResult, TransferResult } from '../../shared/api';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal; key?: string; ownerId?: string } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.key ? { 'Idempotency-Key': options.key } : {}), ...(options.ownerId ? { 'X-Aqua-Account': options.ownerId } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const details = typeof data === 'object' && data !== null && 'error' in data ? (data as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    throw new ApiError(response.status, typeof details?.code === 'string' ? details.code : `HTTP_${response.status}`, typeof details?.message === 'string' ? details.message : '서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (data === null) throw new Error('서버 응답을 확인하지 못했습니다.');
  return data as T;
}

export type Recipient = Pick<MemberProfile, 'id' | 'name' | 'tag'>;

export const api = {
  session: (signal?: AbortSignal) => request<{ user: MemberProfile | null }>('/session', { signal }),
  signup: (body: { name: string; email: string; tag: string; password: string }) => request<{ user: MemberProfile }>('/auth/signup', { method: 'POST', body }),
  login: (body: { email: string; password: string }) => request<{ user: MemberProfile }>('/auth/login', { method: 'POST', body }),
  logout: (ownerId: string) => request<{ ok: true }>('/auth/logout', { method: 'POST', body: {}, ownerId }),
  account: (signal?: AbortSignal) => request<AccountSnapshot>('/account', { signal }),
  member: (tag: string, signal?: AbortSignal) => request<{ member: Recipient }>(`/members?tag=${encodeURIComponent(tag)}`, { signal }),
  transfer: (body: { recipientTag: string; amountWon: number }, key: string, ownerId: string) => request<TransferResult>('/transfers', { method: 'POST', body, key, ownerId }),
  rewardPreference: (body: { useFirst: boolean; expectedVersion: number }, key: string, ownerId: string) => request<RewardPreferenceResult>('/rewards/preference', { method: 'POST', body, key, ownerId }),
  requestRecovery: (email: string) => request<{ ok: true }>('/auth/recovery/request', { method: 'POST', body: { email } }),
  confirmRecovery: (token: string, password: string) => request<{ ok: true }>('/auth/recovery/confirm', { method: 'POST', body: { token, password } }),
};

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function outcomeUncertain(error: unknown): boolean {
  // A gateway failure or changed session cannot prove that a previous attempt did not commit.
  const rejected: Record<string, number> = {
    INVALID_AMOUNT: 400, INVALID_INPUT: 400, RECIPIENT_NOT_FOUND: 404, SELF_TRANSFER: 400,
    INSUFFICIENT_FUNDS: 409, LIMIT_EXCEEDED: 409, RECIPIENT_BALANCE_LIMIT: 409,
  };
  return !(error instanceof ApiError) || rejected[error.code] !== error.status;
}
