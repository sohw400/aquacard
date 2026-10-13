import { FUNDING_ASSETS, POLICY } from './policy';
import type { FundingSymbol } from './types';

export type FundingQuoteRequest =
  | { direction: 'receive'; symbol: FundingSymbol; units: number }
  | { direction: 'withdraw'; symbol: FundingSymbol; amount: number };

export interface FundingQuote {
  direction: 'receive' | 'withdraw';
  symbol: FundingSymbol;
  price: number;
  inputUnits: number;
  grossWon: number;
  feeWon: number;
  netWon: number;
  /** An estimated quantity only; no blockchain transfer occurs in this PoC. */
  outputUnits: number;
}

const SYMBOLS = Object.keys(FUNDING_ASSETS) as FundingSymbol[];
const MAX_WON = BigInt(Number.MAX_SAFE_INTEGER);

/** Use the decimal input rather than binary multiplication when rounding won. */
function decimalRatio(value: number): { numerator: bigint; denominator: bigint } {
  const [mantissa, exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  let numerator = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - Number(exponent);
  if (scale < 0) { numerator *= 10n ** BigInt(-scale); return { numerator, denominator: 1n }; }
  return { numerator, denominator: 10n ** BigInt(scale) };
}

export function getFundingQuote(request: FundingQuoteRequest): FundingQuote {
  if (!request || !SYMBOLS.includes(request.symbol)) throw new Error('지원하는 입출금 코인을 선택해 주세요.');
  const price = FUNDING_ASSETS[request.symbol].price;
  let gross: bigint;
  let inputUnits = 0;

  if (request.direction === 'receive') {
    if (!Number.isFinite(request.units) || request.units <= 0) throw new Error('입금할 코인 수량을 확인해 주세요.');
    const units = decimalRatio(request.units);
    gross = units.numerator * BigInt(price) / units.denominator;
    inputUnits = request.units;
  } else if (request.direction === 'withdraw') {
    if (!Number.isSafeInteger(request.amount) || request.amount < POLICY.minimumTopup) {
      throw new Error('출금 금액은 1,000원 이상의 안전한 정수로 입력해 주세요.');
    }
    gross = BigInt(request.amount);
  } else {
    throw new Error('입출금 방향을 확인해 주세요.');
  }

  if (gross < BigInt(POLICY.minimumTopup)) throw new Error('입출금 평가액은 최소 1,000원이어야 합니다.');
  if (gross > MAX_WON) throw new Error('처리할 수 있는 원화 금액 범위를 초과했습니다.');
  const feeRate = decimalRatio(POLICY.conversionFee);
  // Incoming coins convert free, and the won stablecoin never converts; other outgoing coins round the fee up to won.
  const fee = request.direction === 'receive' || request.symbol === 'KRWS' ? 0n : (gross * feeRate.numerator + feeRate.denominator - 1n) / feeRate.denominator;
  const grossWon = Number(gross);
  const feeWon = Number(fee);
  const netWon = grossWon - feeWon;
  return {
    direction: request.direction, symbol: request.symbol, price, inputUnits,
    grossWon, feeWon, netWon,
    outputUnits: request.direction === 'withdraw' ? netWon / price : 0,
  };
}

/** The simulated +1 day clock does not extend or expire a real-time quote. */
export function assertFundingQuoteFresh(quotedAt: number, wallNow = Date.now()): void {
  if (!Number.isFinite(quotedAt) || !Number.isFinite(wallNow) || quotedAt < 0 || wallNow < 0
    || quotedAt > wallNow || wallNow - quotedAt > POLICY.quoteTtlSeconds * 1_000) {
    throw new Error('입출금 견적이 만료되었거나 올바르지 않습니다. 새 견적을 확인해 주세요.');
  }
}
