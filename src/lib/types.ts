export type AssetSymbol = 'USDC' | 'USDT' | 'BTC' | 'ETH';
/** Coins that move in and out. KRWS is the won stablecoin that backs the spend balance one to one. */
export type FundingSymbol = 'KRWS' | AssetSymbol;
/** Membership tiers, as KAST has them: the tier sets payback, the Reserve boost and the card. */
export type Plan = 'standard' | 'premium' | 'private';
export type CardStage = 'not_applied' | 'identity' | 'plan' | 'details' | 'review' | 'submitted' | 'needs_info' | 'approved' | 'issued' | 'active' | 'rejected';
export type DeliveryStage = 'none' | 'preparing' | 'shipped' | 'delivered';
export type MobileWallet = 'samsung' | 'apple';
export type FundingNetwork = 'polygon' | 'ethereum' | 'bitcoin';

export interface FundingOperation {
  id: string;
  requestId: string;
  kind: 'deposit' | 'withdrawal';
  /** Coins are converted on arrival, so every movement settles against the spend balance. */
  source: 'spend';
  symbol: FundingSymbol;
  network: FundingNetwork;
  amountWon: number;
  units: number;
  feeWon: number;
  networkFeeWon: number;
  netWon: number;
  outputUnits: number;
  address: string;
  recipient: string;
  status: 'awaiting_deposit' | 'confirming' | 'converting' | 'reviewing' | 'broadcasting' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  stageDueAt: number | null;
  failureReason?: string;
  simulation: 'success' | 'failure';
  retryOf?: string;
}

export interface KycAnswers {
  idType: 'resident' | 'driver';
  occupation: string;
  purpose: string;
  source: string;
}

/** Created once the email code, phone check, ID and face checks and the customer questions (KYC) all pass. */
export interface Account {
  email: string;
  passwordHash: string;
  name: string;
  birthDate: string;
  phone: string;
  kyc: KycAnswers;
  verifiedAt: number;
  /** What other members send to; starts from the email's local part and can be changed. */
  tag: string;
  /** Other members can find this account by typing its whole phone number. Off until the holder turns it on. */
  findByPhone: boolean;
  /** The same for the whole email address. */
  findByEmail: boolean;
}

export type PaymentChannel = 'store' | 'online' | 'overseas';

/** Limits and channels the holder sets for the card, within the issuer's maximums. */
export interface PaymentControls {
  perPayment: number;
  daily: number;
  monthly: number;
  online: boolean;
  overseas: boolean;
}

export interface NotificationSettings {
  payments: boolean;
  funding: boolean;
  marketing: boolean;
  /** Advertising consent must show when it changed. */
  marketingChangedAt: number | null;
}

export interface ShippingAddress {
  zip: string;
  road: string;
  detail: string;
}

/** A card in a higher tier's material on its way after an upgrade. The card in hand keeps working until this one is switched on. */
export interface CardReplacement {
  plan: Plan;
  delivery: Exclude<DeliveryStage, 'none'>;
}

export interface CardState {
  stage: CardStage;
  plan: Plan;
  physical: boolean;
  delivery: DeliveryStage;
  /** The tier the physical card in hand (or being made) was made for. A downgrade keeps the card; null without a physical card. */
  physicalPlan: Plan | null;
  replacement: CardReplacement | null;
  identityVerified: boolean;
  locked: boolean;
  physicalActive: boolean;
  last4: string;
  reference: string;
  submittedAt: number | null;
  issuedAt: number | null;
  /** Phone wallets the active card has been added to. */
  wallets: MobileWallet[];
  /** Fees taken from the spend balance at submission; returned if the application comes back or is declined. */
  chargedFee: number;
  /** Next yearly membership fee date on the demo clock; null on Standard. */
  billingAt: number | null;
  /** A lower tier that takes over on the next renewal date. */
  nextPlan: Plan | null;
  /** Where the physical card goes; editable until it ships. */
  address: ShippingAddress | null;
  /** A PIN was chosen for the physical card. The PIN itself is never stored. */
  pinSet: boolean;
}

export interface Transaction {
  id: string;
  kind: 'deposit' | 'transfer' | 'convert' | 'payment' | 'refund' | 'reward' | 'payback' | 'rate' | 'card';
  title: string;
  amount: number;
  timestamp: number;
  status: 'pending' | 'completed' | 'refunded' | 'partially_refunded' | 'failed' | 'cancelled';
  note: string;
  paymentId?: string;
  fundingId?: string;
  /** The other member's tag on a member-to-member transfer, in either direction. */
  member?: string;
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
  channel?: PaymentChannel;
}

export interface RatePeriod { rate: number; timestamp: number }

export interface AppState {
  version: 1;
  account: Account | null;
  signedIn: boolean;
  spend: number;
  reserve: number;
  rewards: number;
  accrued: number;
  rewardDebt: number;
  reserveAuto: boolean;
  rewardsAuto: boolean;
  reserveRate: number;
  rateHistory: RatePeriod[];
  card: CardState;
  controls: PaymentControls;
  notifications: NotificationSettings;
  payments: Payment[];
  transactions: Transaction[];
  fundingOperations: FundingOperation[];
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
  | { type: 'COMPLETE_SIGNUP'; email: string; passwordHash: string; name: string; birthDate: string; phone: string; kyc: KycAnswers }
  | { type: 'SIGN_IN'; email: string; passwordHash: string }
  | { type: 'SIGN_OUT' }
  | { type: 'RESET_PASSWORD'; email: string; passwordHash: string }
  | { type: 'ADVANCE_DAY' }
  | { type: 'CHANGE_RATE'; rate: number }
  | { type: 'START_FUNDING'; requestId: string; kind: 'deposit' | 'withdrawal'; symbol: FundingSymbol; network: FundingNetwork; source: 'spend'; amount?: number; units?: number; address?: string; recipient?: string; quotedAt: number; simulation?: 'success' | 'failure'; retryOf?: string }
  | { type: 'SIMULATE_FUNDING_DEPOSIT'; id: string }
  | { type: 'CANCEL_FUNDING'; id: string }
  | { type: 'TRANSFER_RESERVE'; direction: 'in' | 'out'; amount: number }
  | { type: 'SEND_TO_MEMBER'; tag: string; amount: number }
  /** Demo: a fictional member sends to this account's tag. */
  | { type: 'RECEIVE_FROM_MEMBER'; tag: string; amount: number }
  | { type: 'SET_TAG'; tag: string }
  | { type: 'SET_FINDABLE'; by: 'phone' | 'email'; enabled: boolean }
  | { type: 'PAY'; merchant: string; amount: number; channel?: PaymentChannel }
  | { type: 'CONFIRM_PAYMENT'; id: string }
  | { type: 'REFUND'; id: string; amount?: number }
  | { type: 'SET_RESERVE_AUTO'; enabled: boolean }
  | { type: 'SET_REWARDS_AUTO'; enabled: boolean }
  | { type: 'SET_CARD'; card: CardState }
  | { type: 'SUBMIT_CARD' }
  | { type: 'CHANGE_PLAN'; plan: Plan }
  | { type: 'ADD_PHYSICAL_CARD'; address: ShippingAddress }
  | { type: 'REISSUE_CARD' }
  | { type: 'CLOSE_CARD' }
  | { type: 'ADVANCE_TO_BILLING' }
  | { type: 'DELETE_ACCOUNT'; passwordHash: string }
  | { type: 'ACTIVATE_PHYSICAL'; pin: string }
  | { type: 'SET_CARD_PIN'; pin: string }
  /** Demo: moves a replacement card one delivery step on. */
  | { type: 'ADVANCE_REPLACEMENT' }
  /** The PIN is only needed when none was set for the card before. */
  | { type: 'ACTIVATE_REPLACEMENT'; pin?: string }
  | { type: 'SET_LIMITS'; perPayment: number; daily: number; monthly: number }
  | { type: 'SET_CHANNEL'; channel: 'online' | 'overseas'; enabled: boolean }
  | { type: 'SET_NOTIFICATION'; key: 'payments' | 'funding' | 'marketing'; enabled: boolean }
  | { type: 'CHANGE_PASSWORD'; currentHash: string; nextHash: string };
