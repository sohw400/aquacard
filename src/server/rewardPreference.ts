export interface RewardPreferenceIntent {
  key: string;
  useFirst: boolean;
  expectedVersion: number;
  createdAt: number;
}

const storageKey = (ownerId: string) => `aqua.server.reward-preference.${ownerId}`;

export function readRewardPreference(ownerId: string): RewardPreferenceIntent | null {
  try {
    const raw = sessionStorage.getItem(storageKey(ownerId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const item = value as Partial<RewardPreferenceIntent>;
    if (typeof item.key !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(item.key)
      || typeof item.useFirst !== 'boolean' || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion! < 0
      || !Number.isSafeInteger(item.createdAt) || item.createdAt! < 0) return null;
    return { key: item.key, useFirst: item.useFirst, expectedVersion: item.expectedVersion!, createdAt: item.createdAt! };
  } catch { return null; }
}

export function storeRewardPreference(ownerId: string, intent: RewardPreferenceIntent): void {
  const data = JSON.stringify({ key: intent.key, useFirst: intent.useFirst, expectedVersion: intent.expectedVersion, createdAt: intent.createdAt });
  sessionStorage.setItem(storageKey(ownerId), data);
  if (sessionStorage.getItem(storageKey(ownerId)) !== data) throw new Error('Preference request was not persisted.');
}

/** A late response must never remove a newer request made after signing in again. */
export function clearRewardPreference(ownerId: string, key: string): void {
  try {
    if (readRewardPreference(ownerId)?.key === key) sessionStorage.removeItem(storageKey(ownerId));
  } catch { /* Repeating a confirmed key cannot repeat the preference mutation. */ }
}

export const newRewardPreferenceKey = () => globalThis.crypto?.randomUUID?.()
  ?? `reward-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
