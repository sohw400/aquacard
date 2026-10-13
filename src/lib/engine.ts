import { ASSETS, PLANS, POLICY } from './policy';
import { assertFundingQuoteFresh, getFundingQuote } from './funding';
import type { Action, AppState, AssetSymbol, CardStage, CardState, Payment, Transaction } from './types';

export const STORAGE_KEY = 'aqua-card:poc:v1';
const DAY_MS = 24 * 60 * 60 * 1_000;
const YEAR_MS = POLICY.secondsPerYear * 1_000;
const SYMBOLS = Object.keys(ASSETS) as AssetSymbol[];
const STAGES: CardStage[] = ['not_applied', 'identity', 'plan', 'details', 'review', 'submitted', 'needs_info', 'approved', 'issued', 'active', 'rejected'];
const TRANSITIONS: Record<CardStage, CardStage[]> = {
  not_applied: ['identity'], identity: ['plan', 'not_applied'], plan: ['identity', 'details'],
  details: ['plan', 'review'], review: ['details', 'submitted'],
  submitted: ['needs_info', 'approved', 'rejected'], needs_info: ['identity', 'review', 'submitted'],
  approved: ['issued'], issued: ['active'], active: [], rejected: ['identity', 'not_applied'],
};

function dateParts(timestamp: number): { day: string; month: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp);
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  const month = `${part('year')}-${part('month')}`;
  return { month, day: `${month}-${part('day')}` };
}

export function createInitialState(now = Date.now()): AppState {
  const { day, month } = dateParts(now);
  return {
    version: 1, spend: 128_500, reserve: 1_250_000, rewards: 4_280, accrued: 0, rewardDebt: 0,
    holdings: { USDC: 100, USDT: 0, BTC: 0.0012, ETH: 0.08 },
    reserveAuto: false, rewardsAuto: true, reserveRate: POLICY.reserveAnnualRate,
    rateHistory: [{ rate: POLICY.reserveAnnualRate, timestamp: now }],
    card: { stage: 'not_applied', plan: 'basic', physical: false, delivery: 'none',
      identityVerified: false, locked: false, physicalActive: false, last4: '2048', reference: '',
      submittedAt: null, issuedAt: null },
    payments: [], transactions: [], lastAccruedAt: now, clockOffsetMs: 0,
    monthlyCashback: 0, cashbackMonth: month, dailySpent: 0, spendingDay: day,
    monthlySpent: 0, spendingMonth: month, sequence: 0,
  };
}

export function availableToSpend(state: AppState): number {
  return state.spend + (state.rewardsAuto ? state.rewards : 0) + (state.reserveAuto ? state.reserve : 0);
}

export function portfolioValue(state: AppState): number {
  return state.spend + state.reserve + SYMBOLS.reduce((total, symbol) => total + state.holdings[symbol] * ASSETS[symbol].price, 0);
}

function integer(value: number, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`금액은 ${minimum.toLocaleString('ko-KR')}원 이상의 정수로 입력해 주세요.`);
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('처리할 수 있는 금액 범위를 초과했습니다.');
  return value;
}

function assetUnits(symbol: AssetSymbol, units: number): number {
  if (!SYMBOLS.includes(symbol) || !Number.isFinite(units) || units <= 0) throw new Error('자산과 수량을 확인해 주세요.');
  const value = units * ASSETS[symbol].price;
  if (!Number.isFinite(value) || value < POLICY.minimumTopup || value > Number.MAX_SAFE_INTEGER) {
    throw new Error('1,000원 이상의 자산 수량을 입력해 주세요.');
  }
  return value;
}

function normalizeUnits(units: number): number {
  return Math.abs(units) < 1e-10 ? 0 : Number(units.toFixed(10));
}

function transaction(state: AppState, now: number, fields: Omit<Transaction, 'id' | 'timestamp'>): Transaction {
  const item: Transaction = { id: `tx-${++state.sequence}`, timestamp: now, ...fields };
  state.transactions.unshift(item);
  return item;
}

/** Every action accrues the old balance/rate before it changes either one. */
function accrue(state: AppState, wallNow: number): number {
  if (!Number.isFinite(wallNow) || wallNow < 0) throw new Error('유효한 시간이 필요합니다.');
  const now = Math.max(state.lastAccruedAt, wallNow + state.clockOffsetMs);
  const elapsed = now - state.lastAccruedAt;
  state.accrued += Math.min(state.reserve, POLICY.reserveEligibleCap) * state.reserveRate * elapsed / YEAR_MS;
  state.lastAccruedAt = now;
  const { day, month } = dateParts(now);
  if (state.spendingDay !== day) { state.spendingDay = day; state.dailySpent = 0; }
  if (state.spendingMonth !== month) { state.spendingMonth = month; state.monthlySpent = 0; }
  if (state.cashbackMonth !== month) { state.cashbackMonth = month; state.monthlyCashback = 0; }
  return now;
}

/** Reward credits settle any previous cashback reversal before becoming spendable. */
function creditRewards(state: AppState, amount: number): number {
  const offset = Math.min(state.rewardDebt, amount);
  state.rewardDebt -= offset;
  state.rewards = safeAdd(state.rewards, amount - offset);
  return offset;
}

function validateCardChange(previous: CardState, next: CardState): void {
  if (!validCard(next)) throw new Error('카드 정보가 올바르지 않습니다.');
  if (next.stage !== previous.stage && !TRANSITIONS[previous.stage].includes(next.stage)) {
    throw new Error('카드 신청 순서에 따라 다음 단계를 진행해 주세요.');
  }
  if (['plan', 'details', 'review', 'submitted', 'needs_info', 'approved', 'issued', 'active'].includes(next.stage) && !next.identityVerified) {
    throw new Error('본인 확인을 먼저 완료해 주세요.');
  }
  if (['issued', 'active'].includes(next.stage) && next.issuedAt === null) throw new Error('카드 발급을 먼저 완료해 주세요.');
  if (next.physicalActive && (!next.physical || next.delivery !== 'delivered' || next.stage !== 'active')) {
    throw new Error('실물 카드를 수령한 뒤 활성화해 주세요.');
  }
  if (!next.physical && next.delivery !== 'none') throw new Error('실물 카드 신청 정보를 확인해 주세요.');
}

export function applyAction(input: AppState, action: Action, wallNow = Date.now()): AppState {
  const state = structuredClone(input);
  let now = accrue(state, wallNow);
  switch (action.type) {
    case 'TICK': return state;
    case 'ADVANCE_DAY': {
      state.clockOffsetMs += DAY_MS;
      now = accrue(state, wallNow);
      transaction(state, now, { kind: 'reward', title: '하루 보상 시뮬레이션', amount: 0, status: 'completed', note: '데모 시간을 24시간 진행했습니다. 적립 보상은 수령 후 결제에 사용할 수 있습니다.' });
      return state;
    }
    case 'CHANGE_RATE': {
      if (!Number.isFinite(action.rate) || action.rate < 0 || action.rate > 1) throw new Error('보상률은 0%부터 100% 사이로 설정해 주세요.');
      if (action.rate === state.reserveRate) return state;
      state.reserveRate = action.rate;
      state.rateHistory.push({ rate: action.rate, timestamp: now });
      transaction(state, now, { kind: 'rate', title: 'Reserve 보상률 변경', amount: 0, status: 'completed', note: `변경 시점부터 연 ${(action.rate * 100).toFixed(1)}%를 적용합니다. 이전 적립은 유지됩니다.` });
      return state;
    }
    case 'DEPOSIT': {
      if (action.bucket !== 'spend' && action.bucket !== 'reserve') throw new Error('충전할 지갑을 선택해 주세요.');
      integer(action.amount, POLICY.minimumTopup);
      state[action.bucket] = safeAdd(state[action.bucket], action.amount);
      transaction(state, now, { kind: 'deposit', title: `${action.bucket === 'reserve' ? 'Reserve' : '결제 지갑'} 데모 충전`, amount: action.amount, status: 'completed', note: '가상 원화 충전입니다. 실제 입금이나 자산 이동은 발생하지 않습니다.' });
      return state;
    }
    case 'RECEIVE_ASSET': {
      assertFundingQuoteFresh(action.quotedAt, wallNow);
      const quote = getFundingQuote({ direction: 'receive', symbol: action.symbol, units: action.units });
      state.spend = safeAdd(state.spend, quote.netWon);
      transaction(state, now, { kind: 'deposit', title: `${action.symbol} 입금 · 원화 자동 전환`, amount: quote.netWon, status: 'completed',
        note: `${action.units} ${action.symbol} 가상 입금 → 원화 평가액 ${quote.grossWon.toLocaleString('ko-KR')}원. 전환 수수료 0.5% (${quote.feeWon.toLocaleString('ko-KR')}원) 공제 후 ${quote.netWon.toLocaleString('ko-KR')}원을 결제 잔액에 반영했습니다. 실제 입금·매도·블록체인 거래는 실행하지 않습니다.` });
      return state;
    }
    case 'WITHDRAW_CRYPTO': {
      assertFundingQuoteFresh(action.quotedAt, wallNow);
      const quote = getFundingQuote({ direction: 'withdraw', symbol: action.symbol, amount: action.amount });
      if (state.spend < quote.grossWon) throw new Error('원화 결제 잔액이 부족합니다. 리워드와 Reserve 원금은 코인 출금에 자동 사용하지 않습니다.');
      state.spend -= quote.grossWon;
      transaction(state, now, { kind: 'transfer', title: `${action.symbol} 외부 지갑 출금 · 모의 처리`, amount: -quote.grossWon, status: 'completed',
        note: `결제 잔액 ${quote.grossWon.toLocaleString('ko-KR')}원 차감. 전환 수수료 0.5% (${quote.feeWon.toLocaleString('ko-KR')}원) 제외 후 예상 ${quote.outputUnits.toLocaleString('en-US', { maximumFractionDigits: 12 })} ${action.symbol} (순 원화 환산액 ${quote.netWon.toLocaleString('ko-KR')}원). 실제 코인 매수나 외부 지갑 전송은 실행하지 않습니다.` });
      return state;
    }
    case 'DEPOSIT_ASSET': {
      const value = assetUnits(action.symbol, action.units);
      const next = normalizeUnits(state.holdings[action.symbol] + action.units);
      if (next * ASSETS[action.symbol].price > Number.MAX_SAFE_INTEGER) throw new Error('처리할 수 있는 자산 수량을 초과했습니다.');
      state.holdings[action.symbol] = next;
      transaction(state, now, { kind: 'deposit', title: `${action.symbol} 데모 입금`, amount: Math.floor(value), status: 'completed',
        note: `${action.units} ${action.symbol} 가상 입금. 실제 블록체인 거래나 자금 이동은 실행하지 않습니다.` });
      return state;
    }
    case 'WITHDRAW_ASSET': {
      const value = assetUnits(action.symbol, action.units);
      if (action.units > state.holdings[action.symbol] + 1e-10) throw new Error('출금할 자산 잔액이 부족합니다.');
      state.holdings[action.symbol] = normalizeUnits(Math.max(0, state.holdings[action.symbol] - action.units));
      transaction(state, now, { kind: 'transfer', title: `${action.symbol} 데모 출금`, amount: -Math.floor(value), status: 'completed',
        note: `${action.units} ${action.symbol} 가상 출금. 네트워크나 외부 지갑으로 전송하지 않습니다. 실제 출금 수수료는 파트너 연동 후 안내합니다.` });
      return state;
    }
    case 'WITHDRAW_FUNDS': {
      if (action.bucket !== 'spend' && action.bucket !== 'reserve') throw new Error('출금할 지갑을 선택해 주세요.');
      integer(action.amount, POLICY.minimumTopup);
      if (state[action.bucket] < action.amount) throw new Error('출금할 지갑의 잔액이 부족합니다.');
      state[action.bucket] -= action.amount;
      transaction(state, now, { kind: 'transfer', title: `${action.bucket === 'reserve' ? 'Reserve' : '결제 지갑'} 데모 출금`, amount: -action.amount, status: 'completed',
        note: '가상 출금입니다. 은행이나 블록체인으로 실제 자금이 이동하지 않습니다. 리워드는 출금할 수 없습니다.' });
      return state;
    }
    case 'TRANSFER_RESERVE': {
      integer(action.amount, POLICY.minimumTopup);
      if (action.direction !== 'in' && action.direction !== 'out') throw new Error('이동 방향을 선택해 주세요.');
      const source = action.direction === 'in' ? 'spend' : 'reserve';
      const target = action.direction === 'in' ? 'reserve' : 'spend';
      if (state[source] < action.amount) throw new Error('이동할 지갑의 잔액이 부족합니다.');
      state[target] = safeAdd(state[target], action.amount);
      state[source] -= action.amount;
      transaction(state, now, { kind: 'transfer', title: action.direction === 'in' ? 'Reserve로 이동' : '결제 지갑으로 이동', amount: action.amount, status: 'completed', note: '내 지갑 간 이동 · 수수료 0원 · 이동 시점부터 보상 기준 잔액에 반영' });
      return state;
    }
    case 'CONVERT': {
      if (!SYMBOLS.includes(action.symbol) || !Number.isFinite(action.units) || action.units <= 0) throw new Error('전환할 자산과 수량을 확인해 주세요.');
      if (action.units > state.holdings[action.symbol]) throw new Error('전환할 코인 잔액이 부족합니다.');
      if (action.quotedAt !== undefined && (!Number.isFinite(action.quotedAt) || action.quotedAt < 0 || action.quotedAt > wallNow
        || wallNow - action.quotedAt > POLICY.quoteTtlSeconds * 1_000)) throw new Error('전환 견적이 만료되었습니다. 새 견적을 확인해 주세요.');
      const gross = action.units * ASSETS[action.symbol].price;
      if (!Number.isFinite(gross) || gross < POLICY.minimumConversion) throw new Error('1,000원 이상의 코인을 전환해 주세요.');
      const net = Math.floor(gross * (1 - POLICY.conversionFee));
      integer(net);
      state.spend = safeAdd(state.spend, net);
      state.holdings[action.symbol] = normalizeUnits(state.holdings[action.symbol] - action.units);
      transaction(state, now, { kind: 'convert', title: `${action.symbol} → 결제 잔액 전환`, amount: net, status: 'completed', note: `데모 고정 시세 · 전환 수수료 0.5% (${Math.ceil(gross - net).toLocaleString('ko-KR')}원) 반영` });
      return state;
    }
    case 'SET_RESERVE_AUTO':
      if (typeof action.enabled !== 'boolean') throw new Error('Reserve 자동 사용 설정을 확인해 주세요.');
      state.reserveAuto = action.enabled; return state;
    case 'SET_REWARDS_AUTO':
      if (typeof action.enabled !== 'boolean') throw new Error('리워드 자동 사용 설정을 확인해 주세요.');
      state.rewardsAuto = action.enabled; return state;
    case 'SET_CARD': validateCardChange(state.card, action.card); state.card = structuredClone(action.card); return state;
    case 'REDEEM_ACCRUAL': {
      // Tiny floating-point residue should not lose an exactly accrued whole won.
      const amount = Math.floor(state.accrued + 1e-9);
      if (amount < 1) throw new Error('수령할 보상이 아직 1원 미만입니다.');
      state.accrued = Math.max(0, state.accrued - amount);
      const offset = creditRewards(state, amount);
      transaction(state, now, { kind: 'reward', title: 'Reserve 리워드 수령', amount, status: 'completed', note: `카드 결제 전용 리워드입니다.${offset ? ` 이전 페이백 조정 ${offset.toLocaleString('ko-KR')}원을 먼저 반영했습니다.` : ''}` });
      return state;
    }
    case 'PAY': {
      integer(action.amount);
      if (state.card.stage !== 'active') throw new Error('카드 신청과 발급을 완료한 뒤 결제해 주세요.');
      if (state.card.locked) throw new Error('카드 잠금을 해제한 뒤 결제해 주세요.');
      if (typeof action.merchant !== 'string' || !action.merchant.trim()) throw new Error('결제처를 입력해 주세요.');
      if (action.amount > POLICY.perPaymentLimit) throw new Error('1회 결제 한도는 50만원입니다.');
      if (state.dailySpent + action.amount > POLICY.dailyPaymentLimit) throw new Error('일 결제 한도 100만원을 초과합니다.');
      if (state.monthlySpent + action.amount > POLICY.monthlyPaymentLimit) throw new Error('월 결제 한도 500만원을 초과합니다.');
      if (availableToSpend(state) < action.amount) throw new Error(state.reserveAuto ? '사용 가능한 잔액이 부족합니다.' : '결제 잔액이 부족합니다. 충전하거나 Reserve 자동 사용을 켜 주세요.');
      const fromRewards = state.rewardsAuto ? Math.min(state.rewards, action.amount) : 0;
      const fromSpend = Math.min(state.spend, action.amount - fromRewards);
      const fromReserve = action.amount - fromRewards - fromSpend;
      state.rewards -= fromRewards;
      state.spend -= fromSpend;
      state.reserve -= fromReserve;
      const plan = PLANS[state.card.plan];
      const cashback = Math.min(Math.floor((action.amount - fromRewards) * plan.cashbackRate), Math.max(0, plan.cashbackCap - state.monthlyCashback));
      // Reserve cap at authorization, so multiple pending purchases cannot each use it.
      state.monthlyCashback += cashback;
      state.dailySpent += action.amount;
      state.monthlySpent += action.amount;
      const id = `payment-${++state.sequence}`;
      const payment: Payment = { id, merchant: action.merchant.trim(), amount: action.amount, fromRewards, fromSpend, fromReserve, cashback,
        refunded: 0, rewardsRestored: 0, principalRestored: 0, cashbackReversed: 0, cashbackMonth: state.cashbackMonth, timestamp: now, status: 'pending' };
      state.payments.unshift(payment);
      transaction(state, now, { kind: 'payment', title: payment.merchant, amount: -payment.amount, status: 'pending', paymentId: id,
        note: `리워드 ${fromRewards.toLocaleString('ko-KR')}원 · 결제 지갑 ${fromSpend.toLocaleString('ko-KR')}원 · Reserve ${fromReserve.toLocaleString('ko-KR')}원. 결제 확정 후 페이백 지급.` });
      return state;
    }
    case 'CONFIRM_PAYMENT': {
      const payment = state.payments.find((item) => item.id === action.id);
      if (!payment) throw new Error('결제 내역을 찾을 수 없습니다.');
      if (payment.status !== 'pending') return state;
      payment.status = 'completed';
      const purchase = state.transactions.find((item) => item.kind === 'payment' && item.paymentId === payment.id);
      if (purchase) purchase.status = 'completed';
      if (payment.cashback > 0) {
        const offset = creditRewards(state, payment.cashback);
        transaction(state, now, { kind: 'payback', title: `${payment.merchant} 페이백`, amount: payment.cashback, status: 'completed', paymentId: payment.id,
          note: `리워드 사용분을 제외한 원금 결제액 기준.${offset ? ` 이전 페이백 조정 ${offset.toLocaleString('ko-KR')}원을 먼저 반영했습니다.` : ''}` });
      }
      return state;
    }
    case 'REFUND': {
      const payment = state.payments.find((item) => item.id === action.id);
      if (!payment) throw new Error('결제 내역을 찾을 수 없습니다.');
      if (payment.status === 'pending') throw new Error('결제 확정 후 환불할 수 있습니다.');
      if (payment.status === 'refunded') throw new Error('이미 전액 환불된 결제입니다.');
      const amount = action.amount ?? payment.amount - payment.refunded;
      integer(amount);
      if (amount > payment.amount - payment.refunded) throw new Error('남은 결제 금액보다 많이 환불할 수 없습니다.');
      const cumulative = payment.refunded + amount;
      const rewardsRestored = Math.floor(payment.fromRewards * cumulative / payment.amount);
      const principalRestored = cumulative - rewardsRestored;
      const principalPaid = payment.amount - payment.fromRewards;
      const cashbackReversed = principalPaid > 0 ? Math.floor(payment.cashback * principalRestored / principalPaid) : 0;
      const rewardRefund = rewardsRestored - payment.rewardsRestored;
      const principalRefund = principalRestored - payment.principalRestored;
      const reversed = cashbackReversed - payment.cashbackReversed;
      state.spend = safeAdd(state.spend, principalRefund);
      creditRewards(state, rewardRefund);
      const deduction = Math.min(state.rewards, reversed);
      state.rewards -= deduction;
      state.rewardDebt = safeAdd(state.rewardDebt, reversed - deduction);
      // A February refund of a January purchase must not reopen February's cap.
      if (payment.cashbackMonth === state.cashbackMonth) state.monthlyCashback = Math.max(0, state.monthlyCashback - reversed);
      const refundStatus: Payment['status'] = cumulative === payment.amount ? 'refunded' : 'partially_refunded';
      Object.assign(payment, { refunded: cumulative, rewardsRestored, principalRestored, cashbackReversed, status: refundStatus });
      const purchase = state.transactions.find((item) => item.kind === 'payment' && item.paymentId === payment.id);
      if (purchase) purchase.status = payment.status;
      transaction(state, now, { kind: 'refund', title: `${payment.merchant} ${refundStatus === 'refunded' ? '전액' : '부분'} 환불`, amount, status: 'completed', paymentId: payment.id,
        note: `결제 지갑 ${principalRefund.toLocaleString('ko-KR')}원 · 리워드 ${rewardRefund.toLocaleString('ko-KR')}원 반환. 페이백 ${reversed.toLocaleString('ko-KR')}원 조정${reversed > deduction ? ' (부족분은 향후 리워드에서 상계)' : ''}. 원금에서 페이백을 차감하지 않습니다.` });
      return state;
    }
  }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function whole(value: unknown): value is number { return nonnegative(value) && Number.isSafeInteger(value); }
function timestamp(value: unknown): value is number { return nonnegative(value) && value <= 8.64e15; }
function validCard(value: unknown): value is CardState {
  if (!record(value)) return false;
  return STAGES.includes(value.stage as CardStage) && ['basic', 'plus'].includes(value.plan as string)
    && ['none', 'preparing', 'shipped', 'delivered'].includes(value.delivery as string)
    && ['physical', 'identityVerified', 'locked', 'physicalActive'].every((key) => typeof value[key] === 'boolean')
    && typeof value.last4 === 'string' && /^\d{4}$/.test(value.last4) && typeof value.reference === 'string'
    && (value.submittedAt === null || timestamp(value.submittedAt)) && (value.issuedAt === null || timestamp(value.issuedAt));
}

function cardConsistent(value: CardState): boolean {
  if (['plan', 'details', 'review', 'submitted', 'needs_info', 'approved', 'issued', 'active'].includes(value.stage) && !value.identityVerified) return false;
  if (['issued', 'active'].includes(value.stage) && value.issuedAt === null) return false;
  if (!value.physical && value.delivery !== 'none') return false;
  if (value.physicalActive && (!value.physical || value.delivery !== 'delivered' || value.stage !== 'active')) return false;
  return true;
}

function validState(value: unknown): value is AppState {
  if (!record(value) || value.version !== 1) return false;
  const integers = ['spend', 'reserve', 'rewards', 'rewardDebt', 'monthlyCashback', 'dailySpent', 'monthlySpent', 'sequence'];
  if (!integers.every((key) => whole(value[key])) || !nonnegative(value.accrued) || !nonnegative(value.clockOffsetMs)
    || !timestamp(value.lastAccruedAt) || !nonnegative(value.reserveRate) || value.reserveRate > 1
    || typeof value.reserveAuto !== 'boolean' || typeof value.rewardsAuto !== 'boolean' || !validCard(value.card) || !cardConsistent(value.card)) return false;
  if (!record(value.holdings) || !SYMBOLS.every((symbol) => nonnegative((value.holdings as Record<string, unknown>)[symbol])
    && ((value.holdings as Record<AssetSymbol, number>)[symbol] * ASSETS[symbol].price) <= Number.MAX_SAFE_INTEGER)) return false;
  if (!['cashbackMonth', 'spendingMonth'].every((key) => typeof value[key] === 'string' && /^\d{4}-\d{2}$/.test(value[key] as string))
    || typeof value.spendingDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.spendingDay)) return false;
  if (!Array.isArray(value.rateHistory) || value.rateHistory.length === 0
    || !value.rateHistory.every((item) => record(item) && nonnegative(item.rate) && item.rate <= 1 && timestamp(item.timestamp))) return false;
  if (!Array.isArray(value.payments) || !value.payments.every((item) => {
    if (!record(item) || typeof item.id !== 'string' || typeof item.merchant !== 'string' || !timestamp(item.timestamp)
      || typeof item.cashbackMonth !== 'string' || !/^\d{4}-\d{2}$/.test(item.cashbackMonth)
      || !['pending', 'completed', 'refunded', 'partially_refunded'].includes(item.status as string)) return false;
    if (!['amount', 'fromRewards', 'fromSpend', 'fromReserve', 'cashback', 'refunded', 'rewardsRestored', 'principalRestored', 'cashbackReversed'].every((key) => whole(item[key]))) return false;
    const payment = item as unknown as Payment;
    return payment.amount > 0 && payment.fromRewards + payment.fromSpend + payment.fromReserve === payment.amount
      && payment.refunded <= payment.amount && payment.rewardsRestored <= payment.fromRewards
      && payment.principalRestored <= payment.fromSpend + payment.fromReserve && payment.cashbackReversed <= payment.cashback
      && payment.rewardsRestored + payment.principalRestored === payment.refunded;
  })) return false;
  return Array.isArray(value.transactions) && value.transactions.every((item) => record(item)
    && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.note === 'string'
    && typeof item.amount === 'number' && Number.isSafeInteger(item.amount) && timestamp(item.timestamp)
    && ['deposit', 'transfer', 'convert', 'payment', 'refund', 'reward', 'payback', 'rate'].includes(item.kind as string)
    && ['pending', 'completed', 'refunded', 'partially_refunded'].includes(item.status as string)
    && (item.paymentId === undefined || typeof item.paymentId === 'string'));
}

export function loadState(): AppState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const candidate: unknown = JSON.parse(raw);
      if (validState(candidate)) return applyAction(candidate, { type: 'TICK' });
    }
  } catch { /* Disabled storage or corrupt snapshots reset safely to demo balances. */ }
  return createInitialState();
}

export function saveState(state: AppState): void {
  try {
    if (validState(state)) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* Browsing with disabled/full storage still works for this session. */ }
}
