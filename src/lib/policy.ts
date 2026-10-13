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

export const PLANS: Record<Plan, { name: string; monthlyFee: number; cashbackRate: number; cashbackCap: number }> = {
  basic: { name: 'Aqua Basic', monthlyFee: 0, cashbackRate: 0.01, cashbackCap: 10_000 },
  plus: { name: 'Aqua Plus', monthlyFee: 4_900, cashbackRate: 0.015, cashbackCap: 30_000 },
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
