export interface PendingTransfer {
  key: string;
  recipientTag: string;
  amountWon: number;
  createdAt: number;
}

const storageKey = (ownerId: string) => `aqua.server.pending.${ownerId}`;

export function readPending(ownerId: string): PendingTransfer | null {
  try {
    const raw = sessionStorage.getItem(storageKey(ownerId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const item = value as Partial<PendingTransfer>;
    if (typeof item.key === 'string' && item.key.length >= 16 && item.key.length <= 128 && typeof item.recipientTag === 'string' && /^[a-z0-9._]{3,20}$/.test(item.recipientTag) && Number.isSafeInteger(item.amountWon) && item.amountWon! > 0 && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)) return item as PendingTransfer;
  } catch { /* A new transfer requires successful persistence before it is sent. */ }
  return null;
}

export function storePending(ownerId: string, pending: PendingTransfer): void {
  const data = JSON.stringify(pending);
  sessionStorage.setItem(storageKey(ownerId), data);
  if (sessionStorage.getItem(storageKey(ownerId)) !== data) throw new Error('Pending transfer was not persisted.');
}

export function clearPending(ownerId: string): void {
  try { sessionStorage.removeItem(storageKey(ownerId)); } catch { /* Replaying an old resolved key is idempotent. */ }
}
