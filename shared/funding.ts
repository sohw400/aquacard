export type FundingAsset = 'KRWS' | 'USDC' | 'USDT' | 'BTC' | 'ETH';
export type FundingDirection = 'deposit' | 'withdrawal';
export type FundingStatus = 'quoted' | 'awaiting' | 'observed' | 'confirmed' | 'credited' | 'reorg_review' | 'reversed'
  | 'held' | 'dispatched' | 'unknown' | 'settled' | 'released' | 'cancelled';
export interface MemberFunding {
  id: string; direction: FundingDirection; asset: FundingAsset; network: string; destination: string; status: FundingStatus;
  priceWon: number; grossWon: number; feeWon: number; networkFeeWon: number; netWon: number; units: string;
  requiredConfirmations: number; createdAt: number; updatedAt: number; expiresAt: number;
}
export type FundingInput = { action: 'quote'; direction: FundingDirection; asset: FundingAsset; network: string; quantity: string; destination?: string }
  | { action: 'accept_deposit' | 'accept_withdrawal' | 'cancel'; id: string };
