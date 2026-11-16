/** HTTP contracts for the server-backed sandbox. Amounts are integer test won, never live money. */
export interface MemberProfile {
  id: string;
  email: string;
  name: string;
  tag: string;
  createdAt: number;
}

export interface TransferRecord {
  id: string;
  direction: 'sent' | 'received' | 'funded';
  amountWon: number;
  counterpartyName: string;
  counterpartyTag: string;
  createdAt: number;
}

export interface AccountSnapshot {
  user: MemberProfile;
  balanceWon: number;
  transactions: TransferRecord[];
  limits: {
    perTransfer: number;
    daily: number;
    monthly: number;
    sentToday: number;
    sentMonth: number;
    available: number;
  };
}

export interface TransferResult {
  transfer: TransferRecord;
  balanceWon: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
