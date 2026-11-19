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
  /** Available funds. Authorized card amounts are excluded until released. */
  balanceWon: number;
  heldBalanceWon: number;
  totalBalanceWon: number;
  cardPayments: CardPaymentRecord[];
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

export type CardPaymentStatus = 'authorized' | 'partially_captured' | 'captured' | 'cancelled' | 'partially_refunded' | 'refunded';

export interface CardPaymentRecord {
  id: string;
  merchantName: string;
  status: CardPaymentStatus;
  authorizedWon: number;
  heldWon: number;
  capturedWon: number;
  releasedWon: number;
  refundedWon: number;
  createdAt: number;
  updatedAt: number;
}

/** Internal sandbox command, not an issuer webhook contract or a public write API. */
export type SandboxCardEvent = {
  eventId: string;
  paymentId: string;
  userId: string;
} & (
  | { kind: 'authorize'; amountWon: number; merchantName: string }
  | { kind: 'capture'; amountWon: number; finalCapture: boolean }
  | { kind: 'reverse' }
  | { kind: 'refund'; amountWon: number }
);

export interface CardEventResult {
  payment: CardPaymentRecord;
  balanceWon: number;
  heldBalanceWon: number;
  totalBalanceWon: number;
}

export interface TransferResult {
  transfer: TransferRecord;
  balanceWon: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
