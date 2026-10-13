import { getFundingQuote } from './funding';
import { FUNDING_ASSETS } from './policy';
import type { AppState, FundingNetwork, FundingOperation, FundingSymbol } from './types';

export interface FundingNetworkOption {
  id: FundingNetwork;
  label: string;
  feeWon: number;
  confirmationLabel: string;
  estimatedTime: string;
}

export interface FundingMovementQuoteRequest {
  kind: 'deposit' | 'withdrawal';
  symbol: FundingSymbol;
  network: FundingNetwork;
  /** Every movement goes through the won-stablecoin spend balance; coins are never held. */
  source: 'spend';
  amount?: number;
  units?: number;
}

export interface FundingMovementQuote {
  amountWon: number;
  /** Gross asset quantity; outputUnits is the estimated quantity after fees. */
  units: number;
  feeWon: number;
  networkFeeWon: number;
  netWon: number;
  outputUnits: number;
}

const NETWORKS: Record<FundingSymbol, FundingNetworkOption[]> = {
  KRWS: [
    { id: 'polygon', label: 'Polygon', feeWon: 140, confirmationLabel: '네트워크 확인 2회', estimatedTime: '약 1~3분' },
    { id: 'ethereum', label: 'Ethereum', feeWon: 2_800, confirmationLabel: '네트워크 확인 12회', estimatedTime: '약 3~10분' },
  ],
  USDC: [
    { id: 'polygon', label: 'Polygon', feeWon: 140, confirmationLabel: '네트워크 확인 2회', estimatedTime: '약 1~3분' },
    { id: 'ethereum', label: 'Ethereum', feeWon: 2_800, confirmationLabel: '네트워크 확인 12회', estimatedTime: '약 3~10분' },
  ],
  USDT: [
    { id: 'ethereum', label: 'Ethereum', feeWon: 2_800, confirmationLabel: '네트워크 확인 12회', estimatedTime: '약 3~10분' },
  ],
  BTC: [
    { id: 'bitcoin', label: 'Bitcoin', feeWon: 1_500, confirmationLabel: '네트워크 확인 2회', estimatedTime: '약 20~60분' },
  ],
  ETH: [
    { id: 'ethereum', label: 'Ethereum', feeWon: 2_000, confirmationLabel: '네트워크 확인 12회', estimatedTime: '약 3~10분' },
  ],
};

/** Fees and timing are PoC estimates, not live blockchain quotes. */
export function getFundingNetworks(symbol: FundingSymbol): FundingNetworkOption[] {
  return (Object.hasOwn(NETWORKS, symbol) ? NETWORKS[symbol] : []).map((network) => ({ ...network }));
}

export function createFundingQuote(request: FundingMovementQuoteRequest): FundingMovementQuote {
  if (!request) throw new Error('입출금 요청을 확인해 주세요.');
  const network = getFundingNetworks(request.symbol).find((option) => option.id === request.network);
  if (!network) throw new Error('이 코인이 지원하는 네트워크를 선택해 주세요.');
  if (request.source !== 'spend') throw new Error('입출금은 잔액으로만 할 수 있어요.');

  if (request.kind === 'deposit') {
    const quote = getFundingQuote({ direction: 'receive', symbol: request.symbol, units: request.units! });
    if (quote.netWon <= 0) throw new Error('수수료를 뺀 입금 금액이 0원보다 커야 해요.');
    return {
      amountWon: quote.grossWon, units: quote.inputUnits, feeWon: quote.feeWon,
      networkFeeWon: 0, netWon: quote.netWon, outputUnits: 0,
    };
  }

  if (request.kind !== 'withdrawal') throw new Error('입출금 방향을 확인해 주세요.');
  // Receive quotes already floor decimal quantities exactly and check won bounds.
  // Asset precision in ASSETS is display precision; it does not limit transfers.
  const quote = getFundingQuote({ direction: 'withdraw', symbol: request.symbol, amount: request.amount! });
  const feeWon = quote.feeWon;
  const netWon = quote.grossWon - feeWon - network.feeWon;
  if (netWon <= 0) throw new Error('출금 금액은 전환·네트워크 수수료보다 커야 해요.');
  return {
    amountWon: quote.grossWon,
    units: quote.grossWon / FUNDING_ASSETS[request.symbol].price,
    feeWon, networkFeeWon: network.feeWon, netWon,
    outputUnits: netWon / FUNDING_ASSETS[request.symbol].price,
  };
}

/** Check supported routes and address shape only; Bitcoin checksums are not verified. */
export function validateFundingAddress(symbol: FundingSymbol, network: FundingNetwork, address: string): string | null {
  if (!getFundingNetworks(symbol).some((option) => option.id === network)) {
    return '이 코인이 지원하는 네트워크를 선택해 주세요.';
  }
  if (typeof address !== 'string' || !address.trim()) return '받는 지갑 주소를 입력해 주세요.';
  const normalized = address.trim();
  if (normalized === `aqua-preview:${network}:${symbol.toLowerCase()}`) return null;

  if (network === 'bitcoin') {
    const payload = '[qpzry9x8gf2tvdw0s3jn54khce6mua7l]';
    const validShape = new RegExp(`^(?:bc1q${payload}{38}|bc1q${payload}{58}|bc1p${payload}{58})$`);
    return validShape.test(normalized) ? null : 'bc1q나 bc1p로 시작하는 Bitcoin 주소인지 확인해 주세요.';
  }
  return /^0x[0-9a-fA-F]{40}$/.test(normalized) && !/^0x0{40}$/.test(normalized)
    ? null : '0x로 시작하는 40자리 지갑 주소인지 확인해 주세요.';
}

export function fundingStatusLabel(status: FundingOperation['status']): string {
  const labels: Record<FundingOperation['status'], string> = {
    awaiting_deposit: '입금 대기', confirming: '네트워크 확인 중', converting: '원화 전환 중',
    reviewing: '출금 검토 중', broadcasting: '네트워크 전송 중',
    completed: '완료', failed: '실패', cancelled: '취소됨',
  };
  return labels[status];
}

export function isFundingPending(operation: FundingOperation): boolean {
  return !['completed', 'failed', 'cancelled'].includes(operation.status);
}

/** Outbound principal remains part of the portfolio while held for transmission. */
export function getHeldFundingWon(state: AppState): number {
  return state.fundingOperations.reduce((total, operation) => total + (
    operation.kind === 'withdrawal'
    && (operation.status === 'reviewing' || operation.status === 'broadcasting')
      ? operation.amountWon : 0
  ), 0);
}
