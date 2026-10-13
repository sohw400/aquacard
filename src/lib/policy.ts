import type { AssetSymbol, FundingSymbol, Plan } from './types';

export const POLICY = {
  reserveAnnualRate: 0.05,
  reserveEligibleCap: 10_000_000,
  conversionFee: 0.005,
  minimumTopup: 1_000,
  minimumConversion: 1_000,
  quoteTtlSeconds: 30,
  perPaymentLimit: 500_000,
  dailyPaymentLimit: 1_000_000,
  monthlyPaymentLimit: 5_000_000,
  secondsPerYear: 365 * 24 * 60 * 60,
  physicalIssueFee: 9_900,
  deliveryEstimate: '5~7영업일',
} as const;

export interface PlanTerms {
  name: string;
  short: string;
  /** Charged up front from the spend balance and again on each yearly renewal. */
  annualFee: number;
  cashbackRate: number;
  /** Monthly purchases that earn payback; the cap is rate times this. */
  spendCap: number;
  cashbackCap: number;
  /** Added to the base Reserve rate while the membership is active. */
  reserveBonus: number;
  reserveCap: number;
  card: string;
  physicalFee: number;
}

export const PLAN_ORDER: Plan[] = ['standard', 'premium', 'private'];
/** KAST's Standard, Premium and Private terms at about 1,400 won to the dollar. */
export const PLANS: Record<Plan, PlanTerms> = {
  standard: { name: 'Aqua 스탠다드', short: '스탠다드', annualFee: 0, cashbackRate: 0.015, spendCap: 3_000_000, cashbackCap: 45_000, reserveBonus: 0, reserveCap: 10_000_000, card: '가상카드, 실물카드 선택', physicalFee: 9_900 },
  premium: { name: 'Aqua 프리미엄', short: '프리미엄', annualFee: 1_400_000, cashbackRate: 0.02, spendCap: 14_000_000, cashbackCap: 280_000, reserveBonus: 0.02, reserveCap: 70_000_000, card: '메탈 카드', physicalFee: 0 },
  private: { name: 'Aqua 프라이빗', short: '프라이빗', annualFee: 14_000_000, cashbackRate: 0.03, spendCap: 56_000_000, cashbackCap: 1_680_000, reserveBonus: 0.04, reserveCap: 280_000_000, card: '골드 카드', physicalFee: 0 },
};

export const ASSETS: Record<AssetSymbol, { name: string; price: number; color: string; network: string; decimals: number }> = {
  USDC: { name: 'USD Coin', price: 1_400, color: '#2775ca', network: 'Polygon · 데모', decimals: 2 },
  USDT: { name: 'Tether', price: 1_400, color: '#26a17b', network: 'Ethereum · 데모', decimals: 2 },
  BTC: { name: 'Bitcoin', price: 150_000_000, color: '#f7931a', network: 'Bitcoin · 데모', decimals: 6 },
  ETH: { name: 'Ethereum', price: 4_000_000, color: '#6879bd', network: 'Ethereum · 데모', decimals: 4 },
};

/** The won stablecoin's real name and networks are set once an issuer partners; KRWS is a placeholder. */
export const FUNDING_ASSETS: Record<FundingSymbol, { name: string; label: string; price: number }> = {
  KRWS: { name: '원화 스테이블코인', label: '원화 스테이블', price: 1 },
  USDC: { name: ASSETS.USDC.name, label: 'USDC', price: ASSETS.USDC.price },
  USDT: { name: ASSETS.USDT.name, label: 'USDT', price: ASSETS.USDT.price },
  BTC: { name: ASSETS.BTC.name, label: 'BTC', price: ASSETS.BTC.price },
  ETH: { name: ASSETS.ETH.name, label: 'ETH', price: ASSETS.ETH.price },
};
export const fundingLabel = (symbol: FundingSymbol) => FUNDING_ASSETS[symbol].label;
