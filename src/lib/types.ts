export type AssetSymbol = 'USDC' | 'USDT' | 'BTC' | 'ETH';
export type Plan = 'basic' | 'plus';
export type CardStage = 'not_applied' | 'identity' | 'plan' | 'details' | 'review' | 'submitted' | 'needs_info' | 'approved' | 'issued' | 'active' | 'rejected';
export type DeliveryStage = 'none' | 'preparing' | 'shipped' | 'delivered';

export interface CardState {
  stage: CardStage;
  plan: Plan;
  physical: boolean;
  delivery: DeliveryStage;
  identityVerified: boolean;
  locked: boolean;
  physicalActive: boolean;
  last4: string;
  reference: string;
  submittedAt: number | null;
  issuedAt: number | null;
}

export interface Transaction {
  id: string;
  kind: 'deposit' | 'transfer' | 'convert' | 'payment' | 'refund' | 'reward' | 'payback' | 'rate';
  title: string;
  amount: number;
  timestamp: number;
  status: 'pending' | 'completed' | 'refunded' | 'partially_refunded';
  note: string;
  paymentId?: string;
}

export interface Payment {
  id: string;
  merchant: string;
  amount: number;
  fromRewards: number;
  fromSpend: number;
  fromReserve: number;
  cashback: number;
  refunded: number;
  rewardsRestored: number;
  principalRestored: number;
  cashbackReversed: number;
  cashbackMonth: string;
  timestamp: number;
  status: 'pending' | 'completed' | 'refunded' | 'partially_refunded';
}

export interface RatePeriod { rate: number; timestamp: number }

export interface AppState {
  version: 1;
  spend: number;
  reserve: number;
  rewards: number;
  accrued: number;
  rewardDebt: number;
  holdings: Record<AssetSymbol, number>;
  reserveAuto: boolean;
  rewardsAuto: boolean;
  reserveRate: number;
  rateHistory: RatePeriod[];
  card: CardState;
  payments: Payment[];
  transactions: Transaction[];
  lastAccruedAt: number;
  clockOffsetMs: number;
  monthlyCashback: number;
  cashbackMonth: string;
  dailySpent: number;
  spendingDay: string;
  monthlySpent: number;
  spendingMonth: string;
  sequence: number;
}

export type Action =
  | { type: 'TICK' }
  | { type: 'ADVANCE_DAY' }
  | { type: 'CHANGE_RATE'; rate: number }
  | { type: 'DEPOSIT'; bucket: 'spend' | 'reserve'; amount: number }
  | { type: 'DEPOSIT_ASSET'; symbol: AssetSymbol; units: number }
  | { type: 'WITHDRAW_ASSET'; symbol: AssetSymbol; units: number }
  | { type: 'WITHDRAW_FUNDS'; bucket: 'spend' | 'reserve'; amount: number }
  | { type: 'TRANSFER_RESERVE'; direction: 'in' | 'out'; amount: number }
  | { type: 'CONVERT'; symbol: AssetSymbol; units: number; quotedAt?: number }
  | { type: 'PAY'; merchant: string; amount: number }
  | { type: 'CONFIRM_PAYMENT'; id: string }
  | { type: 'REFUND'; id: string; amount?: number }
  | { type: 'SET_RESERVE_AUTO'; enabled: boolean }
  | { type: 'SET_REWARDS_AUTO'; enabled: boolean }
  | { type: 'SET_CARD'; card: CardState }
  | { type: 'REDEEM_ACCRUAL' };
