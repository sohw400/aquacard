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
  rewards: RewardsSnapshot;
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
  /** Absent on historical event responses; those immutable responses are never rewritten. */
  funding?: { principal: CardFundingAmounts; rewards: CardFundingAmounts };
  cashback?: CardCashbackRecord;
}

export interface CardFundingAmounts {
  authorizedWon: number;
  heldWon: number;
  capturedWon: number;
  releasedWon: number;
  refundedWon: number;
}

export interface CardCashbackRecord {
  policyVersion: string;
  month: string;
  rateBps: number;
  pendingWon: number;
  awardedWon: number;
  reversedWon: number;
  offsetWon: number;
  closedAt: number | null;
}

export interface RewardRecord {
  id: string;
  kind: 'grant' | 'cashback' | 'card_authorize' | 'card_capture' | 'card_release' | 'card_refund' | 'cashback_reversal' | 'adjustment_offset';
  amountWon: number;
  paymentId: string | null;
  createdAt: number;
  availableDeltaWon: number;
  heldDeltaWon: number;
  adjustmentDeltaWon: number;
}

/** Card-only reward units. They are excluded from principal balances and member transfer limits. */
export interface RewardsSnapshot {
  availableWon: number;
  heldWon: number;
  adjustmentDueWon: number;
  useFirst: boolean;
  preferenceVersion: number;
  programActive: boolean;
  policy: { version: string; rateBps: number; monthlyCapWon: number };
  cashback: { month: string; confirmedWon: number; pendingWon: number; reversedWon: number; remainingWon: number };
  history: RewardRecord[];
}

export interface RewardPreferenceResult { useFirst: boolean; version: number }
export interface RewardGrantResult { amountWon: number; availableWon: number; adjustmentDueWon: number; offsetWon: number }

export type IssuerCardStatus = 'active' | 'locked';
export type IssuerCommandStatus = 'pending' | 'in_flight' | 'retry' | 'succeeded' | 'failed' | 'needs_review';

/** Sandbox issuer state only. This does not gate the separate test ledger's authorization commands. */
export interface IssuerCardSnapshot {
  mode: 'sandbox';
  canRequestStatus: boolean;
  card: {
    id: string;
    desiredStatus: IssuerCardStatus;
    confirmedStatus: IssuerCardStatus;
    version: number;
    updatedAt: number;
    command: {
      id: string;
      status: IssuerCommandStatus;
      phase: 'send' | 'lookup';
      attemptCount: number;
      errorCode: string | null;
      createdAt: number;
      updatedAt: number;
    } | null;
  } | null;
}

/** Durable receipt, not confirmation that the issuer has changed the card. */
export interface IssuerCardStatusReceipt {
  id: string;
  cardId: string;
  status: 'pending';
  cardVersion: number;
  duplicate: boolean;
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
