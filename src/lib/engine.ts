import { EVIDENCE, FUND_SOURCES, ID_TYPES, needsEvidence, OCCUPATIONS, PURPOSES, RECHECK_YEARS } from './auth';
import { ASSETS, FUNDING_ASSETS, fundingLabel, physicalCardName, PLAN_ORDER, PLANS, POLICY } from './policy';
import { findMember, initialTag, maskName, normalizeTag, TAG_PATTERN, tagIssue } from './directory';
import { josa, ro } from './format';
import { assertFundingQuoteFresh, getFundingQuote, unitsToWon } from './funding';
import { createFundingQuote, fundingStatusLabel, getFundingNetworks, validateFundingAddress } from './movements';
import { addressLine, SAMPLE_ADDRESSES, validAddress } from './address';
import { normalizeName, UNLISTED_VENUE, validRecipientName, venueOf } from './travel';
import type { Account, Action, AppState, AssetSymbol, CardStage, CardState, DeliveryStage, FundingOperation, FundingSymbol, NotificationSettings, Payment, PaymentControls, Plan, Transaction, WithdrawalDestination } from './types';

export const STORAGE_KEY = 'aqua-card:poc:v1';
const DAY_MS = 24 * 60 * 60 * 1_000;
const YEAR_MS = POLICY.secondsPerYear * 1_000;
const FUNDING_STAGE_MS = 3_000;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SYMBOLS = Object.keys(ASSETS) as AssetSymbol[];
const FUNDING_SYMBOLS = Object.keys(FUNDING_ASSETS) as FundingSymbol[];
const DELIVERY_ORDER: DeliveryStage[] = ['none', 'preparing', 'shipped', 'delivered'];
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
    version: 1, account: null, signedIn: false, spend: 128_500, reserve: 1_250_000, rewards: 4_280, accrued: 0, rewardDebt: 0,
    reserveAuto: false, rewardsAuto: true, reserveRate: POLICY.reserveAnnualRate,
    rateHistory: [{ rate: POLICY.reserveAnnualRate, timestamp: now }],
    card: { stage: 'not_applied', plan: 'standard', physical: false, delivery: 'none',
      identityVerified: false, locked: false, physicalActive: false, last4: '2048', reference: '',
      submittedAt: null, issuedAt: null, wallets: [], chargedFee: 0, billingAt: null, nextPlan: null, address: null, pinSet: false,
      physicalPlan: null, replacement: null },
    controls: defaultControls(), notifications: defaultNotifications(),
    payments: [], transactions: [], fundingOperations: [], lastAccruedAt: now, clockOffsetMs: 0,
    monthlyCashback: 0, cashbackMonth: month, dailySpent: 0, spendingDay: day,
    monthlySpent: 0, spendingMonth: month, sequence: 0,
  };
}

export const LIMIT_STEP = 10_000;
export const defaultControls = (): PaymentControls => ({
  perPayment: POLICY.perPaymentLimit, daily: POLICY.dailyPaymentLimit, monthly: POLICY.monthlyPaymentLimit, online: true, overseas: true,
});
const defaultNotifications = (): NotificationSettings => ({ payments: true, funding: true, marketing: false, marketingChangedAt: null });
const manWon = (value: number) => `${(value / 10_000).toLocaleString('ko-KR')}만원`;

/** Four digits that are not all the same and not a straight run up or down. */
export function pinIssue(pin: string): string {
  if (!/^\d{4}$/.test(pin)) return '숫자 4자리를 넣어 주세요.';
  if (/^(\d)\1{3}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) return '같거나 이어지는 숫자는 쓸 수 없어요.';
  return '';
}

export function availableToSpend(state: AppState): number {
  return state.spend + (state.rewardsAuto ? state.rewards : 0) + (state.reserveAuto ? state.reserve : 0);
}

export function portfolioValue(state: AppState): number {
  return state.spend + state.reserve + heldSpendWon(state);
}

function integer(value: number, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`금액은 ${minimum.toLocaleString('ko-KR')}원 이상의 정수로 입력해 주세요.`);
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('처리할 수 있는 금액 범위를 넘었어요.');
  return value;
}

function nextSequence(state: AppState): number {
  state.sequence = safeAdd(state.sequence, 1);
  return state.sequence;
}

/** Spend principal reserved by withdrawals that have not finished yet. */
function heldSpendWon(state: AppState, excludeId?: string): number {
  return state.fundingOperations.reduce((sum, item) => sum + (item.id !== excludeId && item.kind === 'withdrawal'
    && item.source === 'spend' && ['reviewing', 'broadcasting'].includes(item.status) ? item.amountWon : 0), 0);
}

function creditSpend(state: AppState, amount: number, excludeId?: string): void {
  const next = safeAdd(state.spend, amount);
  safeAdd(next, heldSpendWon(state, excludeId)); // Keep room to restore every reserved principal in full.
  state.spend = next;
}

function updateFundingTransaction(state: AppState, operation: FundingOperation): void {
  const item = state.transactions.find((entry) => entry.fundingId === operation.id);
  if (!item) return;
  item.status = ['completed', 'failed', 'cancelled'].includes(operation.status) ? operation.status as Transaction['status'] : 'pending';
  item.note = `${fundingStatusLabel(operation.status)} · ${fundingLabel(operation.symbol)} / ${operation.network}. `
    + `전환 수수료 ${operation.feeWon.toLocaleString('ko-KR')}원 · 네트워크 비용 ${operation.networkFeeWon.toLocaleString('ko-KR')}원. `
    + (operation.kind === 'deposit' ? `충전 금액 ${operation.netWon.toLocaleString('ko-KR')}원.`
      : `출금 원금 ${operation.amountWon.toLocaleString('ko-KR')}원 · 예상 ${operation.outputUnits.toLocaleString('en-US', { maximumFractionDigits: 12 })} ${fundingLabel(operation.symbol)}.`)
    + (operation.failureReason ? ` ${operation.failureReason}` : '') + ' 실제로 코인이 오가지는 않아요.';
}

function restoreFundingHold(state: AppState, operation: FundingOperation): void {
  if (operation.kind !== 'withdrawal') return;
  creditSpend(state, operation.amountWon, operation.id);
}

/** Persisted deadlines catch up after reload; terminal effects cannot run twice. */
function progressFunding(state: AppState, wallNow: number): void {
  while (true) {
    const operation = state.fundingOperations.slice().reverse().filter((item) => item.stageDueAt !== null && item.stageDueAt <= wallNow)
      .sort((left, right) => left.stageDueAt! - right.stageDueAt! || left.createdAt - right.createdAt)[0];
    if (!operation) return;
      const dueAt = operation.stageDueAt!;
      if (operation.status === 'confirming') {
        if (operation.simulation === 'failure') {
          operation.status = 'failed'; operation.stageDueAt = null;
          operation.failureReason = '입금을 확인하지 못했어요. 잔액에는 더하지 않았어요.';
        } else { operation.status = 'converting'; operation.stageDueAt = dueAt + FUNDING_STAGE_MS; }
      } else if (operation.status === 'converting') {
        try {
          creditSpend(state, operation.netWon);
          operation.status = 'completed';
        } catch {
          operation.status = 'failed';
          operation.failureReason = '충전할 수 있는 금액 범위를 넘어서 잔액에 더하지 못했어요.';
        }
        operation.stageDueAt = null;
      } else if (operation.status === 'reviewing') {
        if (operation.simulation === 'failure') {
          restoreFundingHold(state, operation);
          operation.status = 'failed'; operation.stageDueAt = null;
          operation.failureReason = '출금을 진행하지 못했어요. 보류한 원금과 비용은 모두 잔액으로 돌려드렸어요.';
        } else { operation.status = 'broadcasting'; operation.stageDueAt = dueAt + FUNDING_STAGE_MS; }
      } else if (operation.status === 'broadcasting') {
        operation.status = 'completed'; operation.stageDueAt = null;
      } else { operation.stageDueAt = null; }
      operation.updatedAt = dueAt;
      updateFundingTransaction(state, operation);
  }
}

/**
 * The travel rule check for a withdrawal: an exchange must be in the directory, which holds only reporting businesses the
 * travel rule network reaches, and a personal wallet must be the holder's own, proven by a signature.
 */
function checkDestination(value: unknown): WithdrawalDestination {
  if (!record(value) || (value.kind !== 'exchange' && value.kind !== 'own_wallet')) throw new Error('받는 곳을 골라 주세요.');
  if (value.kind === 'own_wallet') {
    if (value.proof !== 'signature') throw new Error('내 지갑인지 서명으로 확인해 주세요. 다른 사람의 개인 지갑으로는 보낼 수 없어요.');
    return { kind: 'own_wallet', proof: 'signature' };
  }
  if (typeof value.venue !== 'string' || !venueOf(value.venue)) throw new Error(UNLISTED_VENUE);
  if (value.relation !== 'self' && value.relation !== 'other') throw new Error('받는 사람이 본인인지 골라 주세요.');
  return { kind: 'exchange', venue: value.venue, relation: value.relation };
}

function validDestination(value: unknown): boolean {
  try { return JSON.stringify(checkDestination(value)) === JSON.stringify(value); } catch { return false; }
}

function startFunding(state: AppState, action: Extract<Action, { type: 'START_FUNDING' }>, wallNow: number): void {
  if (typeof action.requestId !== 'string' || !REQUEST_ID.test(action.requestId)) throw new Error('입출금 요청 번호가 올바르지 않아요. 다시 시도해 주세요.');
  if (!Number.isFinite(action.quotedAt) || action.quotedAt < 0 || action.quotedAt > wallNow) throw new Error('입출금 견적 시각이 올바르지 않아요. 새 견적을 확인해 주세요.');
  if (action.simulation !== undefined && !['success', 'failure'].includes(action.simulation)) throw new Error('모의 처리 결과를 확인해 주세요.');
  if (action.source !== 'spend') throw new Error('입출금은 잔액으로만 할 수 있어요.');
  if (action.kind === 'deposit' ? action.amount !== undefined : action.units !== undefined) throw new Error('원금과 코인 수량은 함께 요청할 수 없어요. 하나만 입력해 주세요.');
  const quote = createFundingQuote(action);
  const address = action.address === undefined && action.kind === 'deposit' ? `aqua-preview:${action.network}:${action.symbol.toLowerCase()}` : action.address;
  if (typeof address !== 'string') throw new Error('받는 지갑 주소를 입력해 주세요.');
  const normalizedAddress = address.trim();
  const addressError = validateFundingAddress(action.symbol, action.network, normalizedAddress);
  if (addressError) throw new Error(addressError);
  if (action.kind === 'deposit' && action.destination !== undefined) throw new Error('입금에는 받는 곳을 고르지 않아요.');
  const destination = action.kind === 'withdrawal' ? checkDestination(action.destination) : undefined;
  if (action.recipient !== undefined && typeof action.recipient !== 'string') throw new Error('받는 사람 정보를 확인해 주세요.');
  // To the holder's own wallet or own exchange account the travel rule name is the verified one, whatever was typed.
  const own = destination?.kind === 'own_wallet' || (destination?.kind === 'exchange' && destination.relation === 'self');
  const recipient = own && state.account ? state.account.name : destination ? normalizeName(action.recipient ?? '') : (action.recipient ?? '').trim();
  if (recipient.length > 100 || (action.kind === 'withdrawal' && recipient.length === 0)) throw new Error('받는 사람 이름을 입력해 주세요.');
  if (destination?.kind === 'exchange' && destination.relation === 'other' && !validRecipientName(recipient)) throw new Error('받는 사람 이름을 확인해 주세요. 거래소 계정의 이름과 같아야 해요.');
  if (action.retryOf !== undefined && (typeof action.retryOf !== 'string' || !action.retryOf)) throw new Error('다시 시도할 요청을 확인해 주세요.');
  const simulation = action.simulation ?? 'success';
  const existing = state.fundingOperations.find((item) => item.requestId === action.requestId);
  if (existing) {
    const matches = existing.kind === action.kind && existing.source === action.source && existing.symbol === action.symbol && existing.network === action.network
      && existing.amountWon === quote.amountWon && existing.units === quote.units && existing.address === normalizedAddress
      && existing.recipient === recipient && JSON.stringify(existing.destination) === JSON.stringify(destination)
      && existing.simulation === simulation && existing.retryOf === action.retryOf;
    if (!matches) throw new Error('같은 요청 번호에 다른 입출금 내용이 있어요. 새 요청 번호로 진행해 주세요.');
    return;
  }
  assertFundingQuoteFresh(action.quotedAt, wallNow);
  if (action.retryOf) {
    const original = state.fundingOperations.find((item) => item.id === action.retryOf);
    if (!original || !['failed', 'cancelled'].includes(original.status)) throw new Error('실패하거나 취소된 요청만 새 요청으로 다시 시도할 수 있어요.');
  }
  if (action.kind === 'withdrawal') {
    if (state.spend < quote.amountWon) throw new Error('잔액이 부족해요. 리워드와 리저브는 출금에 쓸 수 없어요.');
    state.spend -= quote.amountWon;
  }
  const operation: FundingOperation = {
    id: `funding-${nextSequence(state)}`, requestId: action.requestId, kind: action.kind, source: action.source,
    symbol: action.symbol, network: action.network, ...quote, address: normalizedAddress, recipient, ...(destination ? { destination } : {}),
    status: action.kind === 'deposit' ? 'awaiting_deposit' : 'reviewing', createdAt: wallNow, updatedAt: wallNow,
    stageDueAt: action.kind === 'deposit' ? null : wallNow + FUNDING_STAGE_MS, simulation,
    ...(action.retryOf ? { retryOf: action.retryOf } : {}),
  };
  state.fundingOperations.unshift(operation);
  transaction(state, wallNow, { kind: action.kind === 'deposit' ? 'deposit' : 'transfer', title: `${fundingLabel(action.symbol)} ${action.kind === 'deposit' ? '입금' : '출금'}`,
    amount: action.kind === 'deposit' ? quote.netWon : -quote.amountWon, status: 'pending', fundingId: operation.id, note: '' });
  updateFundingTransaction(state, operation);
}

function transaction(state: AppState, now: number, fields: Omit<Transaction, 'id' | 'timestamp'>): Transaction {
  const item: Transaction = { id: `tx-${nextSequence(state)}`, timestamp: now, ...fields };
  state.transactions.unshift(item);
  return item;
}

export const RESERVE_REWARD_TITLE = '리저브 보상';

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const fullDate = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' }).format(timestamp);
const wonText = (value: number) => `${value.toLocaleString('ko-KR')}원`;

/** Same date next year in Korea; 29 February becomes 28 February. */
export function addYear(timestamp: number): number {
  const kst = new Date(timestamp + KST_OFFSET_MS);
  const year = kst.getUTCFullYear() + 1, month = kst.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(kst.getUTCDate(), lastDay), kst.getUTCHours(), kst.getUTCMinutes(), kst.getUTCSeconds(), kst.getUTCMilliseconds()) - KST_OFFSET_MS;
}

/** What applying costs, paid from the spend balance: the first year of a paid membership and a Standard physical card. */
export function cardApplicationFee(card: Pick<CardState, 'plan' | 'physical'>): number {
  return PLANS[card.plan].annualFee + (card.physical ? PLANS[card.plan].physicalFee : 0);
}

const rank = (plan: Plan) => PLAN_ORDER.indexOf(plan);

/** The Reserve rate and how much of the Reserve earns it; only an active card's membership counts. */
export function reserveTerms(state: Pick<AppState, 'card' | 'reserveRate'>): { rate: number; cap: number } {
  const plan = PLANS[state.card.stage === 'active' ? state.card.plan : 'standard'];
  return { rate: state.reserveRate + plan.reserveBonus, cap: plan.reserveCap };
}
const reservePerMs = (state: AppState) => { const { rate, cap } = reserveTerms(state); return Math.min(state.reserve, cap) * rate / YEAR_MS; };

/** Adds what the Reserve earned since the last accrual, at the terms in force, up to `until`. */
function earnReserve(state: AppState, until: number): void {
  if (until <= state.lastAccruedAt) return;
  state.accrued += reservePerMs(state) * (until - state.lastAccruedAt);
  state.lastAccruedAt = until;
}

function chargeSpend(state: AppState, amount: number, purpose: string): void {
  if (state.spend < amount) throw new Error(`잔액이 ${wonText(amount - state.spend)} 부족해요. 충전한 뒤 ${purpose}.`);
  state.spend -= amount;
}

/** A new card number ending for reissues and for the next card after a closure. */
function freshLast4(state: AppState, previous: string): string {
  const next = String(1_000 + (Number(previous) * 31 + nextSequence(state) * 7_919) % 9_000);
  return next === previous ? String(1_000 + (Number(next) + 1) % 9_000) : next;
}

function refundCardFee(state: AppState, now: number, card: CardState, reason: string): void {
  if (card.chargedFee <= 0) return;
  creditSpend(state, card.chargedFee);
  transaction(state, now, { kind: 'card', title: '카드 신청 비용 환불', amount: card.chargedFee, status: 'completed', note: `${reason} 낸 비용을 잔액으로 돌려드렸어요.` });
  card.chargedFee = 0;
}

/**
 * What an upgrade does to the physical card: one still being made switches material, one already sent
 * is followed by a card of the new tier, and a card of that tier or better is kept.
 */
export function upgradePhysical(card: CardState, plan: Plan): { patch: Partial<CardState>; note: string } {
  const name = physicalCardName(plan);
  if (!card.physical) return { patch: {}, note: ` ${josa(name, '은', '는')} 카드 설정에서 받을 주소를 넣으면 무료로 보내 드려요.` };
  if (card.delivery === 'preparing') return { patch: { physicalPlan: plan }, note: ` 만들고 있던 실물카드는 ${ro(name)} 바꿔 만들어요.` };
  if (card.replacement && rank(card.replacement.plan) >= rank(plan)) return { patch: {}, note: ` 보내고 있는 ${josa(physicalCardName(card.replacement.plan), '을', '를')} 그대로 받으면 돼요.` };
  if (!card.replacement && rank(card.physicalPlan ?? card.plan) >= rank(plan)) return { patch: {}, note: ` 가지고 있는 ${josa(physicalCardName(card.physicalPlan ?? card.plan), '을', '를')} 그대로 써요.` };
  const stopped = card.replacement && card.replacement.delivery !== 'preparing' ? ` 보내던 ${josa(physicalCardName(card.replacement.plan), '은', '는')} 쓸 수 없게 막았어요.` : '';
  const where = card.address ? `${ro(addressLine(card.address))} ` : '';
  return { patch: { replacement: { plan, delivery: 'preparing' } }, note: `${stopped} ${josa(name, '을', '를')} ${where}새로 보내 드려요. 받을 때까지 지금 카드를 그대로 쓰면 돼요.` };
}

/** Paid memberships renew yearly from the spend balance. A scheduled lower tier starts that day; a short balance drops to Standard. */
function settleCardBilling(state: AppState, now: number): void {
  const card = state.card;
  while (card.stage === 'active' && PLANS[card.plan].annualFee > 0 && card.billingAt !== null && card.billingAt <= now) {
    const due = card.billingAt;
    earnReserve(state, due); // The current membership's Reserve terms run until the renewal date.
    const scheduled = card.nextPlan !== null;
    const target = card.nextPlan ?? card.plan;
    const fee = PLANS[target].annualFee;
    card.nextPlan = null;
    if (fee === 0 || state.spend < fee) {
      const missed = PLANS[target].short;
      card.plan = 'standard'; card.billingAt = null;
      transaction(state, now, { kind: 'card', title: '스탠다드로 변경', amount: 0, status: 'completed', note: fee === 0
        ? `예약한 대로 ${fullDate(due)}부터 스탠다드가 됐어요. 연회비는 더 나가지 않아요.`
        : `${fullDate(due)} 갱신일에 잔액이 부족해 ${missed} 연회비를 내지 못했어요. 스탠다드로 바뀌었고, 충전한 뒤 다시 바꿀 수 있어요.` });
    } else {
      state.spend -= fee;
      card.plan = target;
      card.billingAt = addYear(due);
      transaction(state, now, { kind: 'card', title: `${PLANS[target].short} 연회비`, amount: -fee, status: 'completed',
        note: `${scheduled ? `예약한 대로 ${ro(PLANS[target].short)} 바뀌었어요. ` : ''}${fullDate(due)} 갱신일 연회비를 잔액에서 냈어요. 다음 갱신일은 ${fullDate(card.billingAt)}이에요.` });
    }
  }
}

/** Reasons the account cannot be closed yet; an empty list means it can. */
export function accountClosureBlockers(state: AppState): string[] {
  const blockers: string[] = [];
  if (!['not_applied', 'rejected'].includes(state.card.stage)) blockers.push(state.card.stage === 'active' ? '카드를 먼저 해지해 주세요.' : '진행 중인 카드 신청을 마치거나 취소해 주세요.');
  if (state.payments.some((item) => item.status === 'pending')) blockers.push('확정되지 않은 카드 결제가 끝날 때까지 기다려 주세요.');
  if (state.fundingOperations.some((item) => !['completed', 'failed', 'cancelled'].includes(item.status))) blockers.push('진행 중인 입출금이 끝날 때까지 기다려 주세요.');
  if (state.spend > 0) blockers.push('잔액을 모두 출금해 주세요.');
  if (state.reserve > 0) blockers.push('리저브에서 잔액으로 옮긴 뒤 출금해 주세요.');
  return blockers;
}

/** Whole won leave the accrual remainder as soon as they exist, so rewards grow without a claim step. */
function sweepAccrued(state: AppState, now: number): void {
  // Tiny floating-point residue should not lose an exactly accrued whole won.
  const amount = Math.floor(state.accrued + 1e-9);
  if (amount < 1) return;
  state.accrued = Math.max(0, state.accrued - amount);
  const offset = creditRewards(state, amount);
  const { day } = dateParts(now);
  const note = '리저브에서 실시간으로 쌓인 보상이에요. 리워드에 바로 더해져 카드 결제에 먼저 쓰여요.';
  const entry = state.transactions.find((item) => item.kind === 'reward' && item.title === RESERVE_REWARD_TITLE && dateParts(item.timestamp).day === day);
  if (entry) {
    entry.amount = safeAdd(entry.amount, amount);
    if (offset) entry.note = `${note} 이전 페이백 조정분을 먼저 차감했어요.`;
  } else {
    transaction(state, now, { kind: 'reward', title: RESERVE_REWARD_TITLE, amount, status: 'completed', note: offset ? `${note} 이전 페이백 조정분을 먼저 차감했어요.` : note });
  }
}

/** Every action accrues the old balance/rate before it changes either one. */
function accrue(state: AppState, wallNow: number): number {
  if (!Number.isFinite(wallNow) || wallNow < 0) throw new Error('시간 정보가 올바르지 않아요. 다시 시도해 주세요.');
  const now = Math.max(state.lastAccruedAt, wallNow + state.clockOffsetMs);
  // Renewal dates passed on the way settle first, so the Reserve earns each stretch at the membership it had.
  settleCardBilling(state, now);
  earnReserve(state, now);
  const { day, month } = dateParts(now);
  if (state.spendingDay !== day) { state.spendingDay = day; state.dailySpent = 0; }
  if (state.spendingMonth !== month) { state.spendingMonth = month; state.monthlySpent = 0; }
  if (state.cashbackMonth !== month) { state.cashbackMonth = month; state.monthlyCashback = 0; }
  sweepAccrued(state, now);
  return now;
}

/** Live reward figure between engine ticks; the fraction is display-only until it becomes a whole won. */
export function liveRewards(state: AppState, wallNow = Date.now()): number {
  const now = Math.max(state.lastAccruedAt, wallNow + state.clockOffsetMs);
  return state.rewards + state.accrued + reservePerMs(state) * (now - state.lastAccruedAt);
}

/** Reserve rewards credited so far plus the remainder still accruing. */
export function reserveEarnings(state: AppState, wallNow = Date.now()): { total: number; today: number } {
  const now = Math.max(state.lastAccruedAt, wallNow + state.clockOffsetMs);
  const pending = state.accrued + reservePerMs(state) * (now - state.lastAccruedAt);
  const { day } = dateParts(now);
  const credits = state.transactions.filter((item) => item.kind === 'reward' && item.title === RESERVE_REWARD_TITLE);
  const total = credits.reduce((sum, item) => sum + item.amount, 0) + pending;
  const today = credits.filter((item) => dateParts(item.timestamp).day === day).reduce((sum, item) => sum + item.amount, 0) + pending;
  return { total, today };
}

/** Reward credits settle any previous cashback reversal before becoming spendable. */
function creditRewards(state: AppState, amount: number): number {
  const offset = Math.min(state.rewardDebt, amount);
  state.rewardDebt -= offset;
  state.rewards = safeAdd(state.rewards, amount - offset);
  return offset;
}

export const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const ADULT_AGE = 19;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PHONE_PATTERN = /^01[016789]\d{7,8}$/;
const normalizeEmail = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';

function validKyc(value: unknown): boolean {
  return record(value) && Object.hasOwn(ID_TYPES, value.idType as string)
    && (OCCUPATIONS as readonly string[]).includes(value.occupation as string)
    && (PURPOSES as readonly string[]).includes(value.purpose as string)
    && (FUND_SOURCES as readonly string[]).includes(value.source as string)
    && (value.match === 'face' || value.match === 'video') && validAddress(value.address) && typeof value.pep === 'boolean'
    // Enhanced due diligence needs its proof, and only then is there one.
    && (needsEvidence({ pep: value.pep, source: value.source as string })
      ? (EVIDENCE as readonly string[]).includes(value.evidence as string) : value.evidence === null);
}

export const addYears = (timestamp: number, years: number) => Array.from({ length: years }).reduce<number>((time) => addYear(time), timestamp);
/** Customer check and transaction records stay for five years after the relationship ends (특정금융정보법 제5조의4), then go. */
export const RECORD_YEARS = 5;
export const recordsKeptUntil = (closedAt: number) => addYears(closedAt, RECORD_YEARS);

/** Validates sign-up input after the email, phone, ID, face and 1원 account checks have passed in the UI. */
function signupAccount(action: Extract<Action, { type: 'COMPLETE_SIGNUP' }>, wallNow: number): Account {
  const email = normalizeEmail(action.email);
  if (!EMAIL_PATTERN.test(email) || email.length > 120) throw new Error('이메일 주소를 확인해 주세요.');
  if (typeof action.passwordHash !== 'string' || !HASH_PATTERN.test(action.passwordHash)) throw new Error('비밀번호를 다시 정해 주세요.');
  if (typeof action.phone !== 'string' || !PHONE_PATTERN.test(action.phone)) throw new Error('휴대폰 번호를 확인해 주세요.');
  if (!validKyc(action.kyc)) throw new Error(record(action.kyc) && needsEvidence({ pep: action.kyc.pep === true, source: String(action.kyc.source) }) && !action.kyc.evidence
    ? '추가 확인 서류를 올려 주세요.' : '고객확인 질문에 모두 답해 주세요.');
  const name = typeof action.name === 'string' ? action.name.trim() : '';
  if (name.length < 2 || name.length > 30) throw new Error('이름은 2자 이상 30자 이하로 입력해 주세요.');
  const birthDate = typeof action.birthDate === 'string' ? action.birthDate : '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  const birth = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || !birth || birth.getUTCMonth() !== Number(match[2]) - 1 || birth.getUTCDate() !== Number(match[3])) throw new Error('생년월일을 확인해 주세요.');
  const today = new Date(wallNow);
  const age = today.getUTCFullYear() - birth.getUTCFullYear() - (today.getUTCMonth() < birth.getUTCMonth()
    || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate()) ? 1 : 0);
  if (age < ADULT_AGE) throw new Error(`만 ${ADULT_AGE}세 이상만 가입할 수 있어요.`);
  if (age > 120) throw new Error('생년월일을 확인해 주세요.');
  const { idType, occupation, purpose, source, match: faceMatch, address, pep, evidence } = action.kyc;
  const risk = needsEvidence(action.kyc) ? 'high' : 'standard';
  return { email, passwordHash: action.passwordHash, name, birthDate, phone: action.phone,
    kyc: { idType, occupation, purpose, source, match: faceMatch, address: { zip: address.zip, road: address.road.trim(), detail: address.detail.trim() }, pep, evidence },
    verifiedAt: wallNow, risk, kycDueAt: addYears(wallNow, RECHECK_YEARS[risk]), tag: initialTag(email), findByPhone: false, findByEmail: false };
}

function validateCardChange(previous: CardState, next: CardState): void {
  if (!validCard(next)) throw new Error('카드 정보가 올바르지 않아요. 다시 시도해 주세요.');
  if (next.stage !== previous.stage && !TRANSITIONS[previous.stage].includes(next.stage)) {
    throw new Error('카드 신청은 순서대로 진행해 주세요.');
  }
  if (['plan', 'details', 'review', 'submitted', 'needs_info', 'approved', 'issued', 'active'].includes(next.stage) && !next.identityVerified) {
    throw new Error('본인 확인을 먼저 마쳐 주세요.');
  }
  if (['issued', 'active'].includes(next.stage) && next.issuedAt === null) throw new Error('카드 발급을 먼저 마쳐 주세요.');
  if (next.physicalActive && (!next.physical || next.delivery !== 'delivered' || next.stage !== 'active')) {
    throw new Error('실물카드를 수령한 뒤 활성화해 주세요.');
  }
  if (!next.physical && next.delivery !== 'none') throw new Error('실물카드 신청 정보를 확인해 주세요.');
  if (next.wallets.length && next.stage !== 'active') throw new Error('카드를 발급하고 활성화한 뒤 휴대폰에 추가해 주세요.');
  if (next.wallets.some((wallet) => !previous.wallets.includes(wallet)) && next.locked) throw new Error('카드 잠금을 해제한 뒤 휴대폰에 추가해 주세요.');
}

export function applyAction(input: AppState, action: Action, wallNow = Date.now()): AppState {
  const state = structuredClone(input);
  state.fundingOperations ??= [];
  let now = accrue(state, wallNow);
  progressFunding(state, wallNow);
  switch (action.type) {
    case 'TICK': return state;
    case 'COMPLETE_SIGNUP':
      if (state.account) throw new Error('이미 가입한 계정이 있어요. 로그인해 주세요.');
      state.account = signupAccount(action, wallNow);
      state.signedIn = true;
      return state;
    case 'SIGN_IN':
      if (!state.account || normalizeEmail(action.email) !== state.account.email) throw new Error('가입한 이메일이 아니에요. 이메일 주소를 다시 확인해 주세요.');
      if (action.passwordHash !== state.account.passwordHash) throw new Error('비밀번호가 맞지 않아요. 다시 입력해 주세요.');
      state.signedIn = true;
      return state;
    case 'SIGN_OUT':
      state.signedIn = false;
      return state;
    case 'RESET_PASSWORD':
      if (!state.account || normalizeEmail(action.email) !== state.account.email) throw new Error('가입한 이메일이 아니에요. 이메일 주소를 다시 확인해 주세요.');
      if (typeof action.passwordHash !== 'string' || !HASH_PATTERN.test(action.passwordHash)) throw new Error('새 비밀번호를 다시 정해 주세요.');
      state.account.passwordHash = action.passwordHash;
      state.signedIn = false;
      return state;
    case 'ADVANCE_DAY': {
      state.clockOffsetMs += DAY_MS;
      now = accrue(state, wallNow);
      transaction(state, now, { kind: 'rate', title: '하루 지나기 체험', amount: 0, status: 'completed', note: '체험 시간이 24시간 흘렀어요. 그동안 쌓인 리저브 보상은 리워드에 바로 더했어요.' });
      return state;
    }
    case 'CHANGE_RATE': {
      if (!Number.isFinite(action.rate) || action.rate < 0 || action.rate > 1) throw new Error('보상률은 0%에서 100% 사이로 정해 주세요.');
      if (action.rate === state.reserveRate) return state;
      state.reserveRate = action.rate;
      state.rateHistory.push({ rate: action.rate, timestamp: now });
      transaction(state, now, { kind: 'rate', title: '리저브 보상률 변경', amount: 0, status: 'completed', note: `바꾼 시점부터 연 ${(action.rate * 100).toFixed(1)}%를 적용해요. 그전에 쌓인 보상은 그대로예요.` });
      return state;
    }
    case 'START_FUNDING': startFunding(state, action, wallNow); return state;
    case 'SIMULATE_FUNDING_DEPOSIT': {
      const operation = state.fundingOperations.find((item) => item.id === action.id);
      if (!operation || operation.kind !== 'deposit') throw new Error('입금 요청을 찾을 수 없어요.');
      if (operation.status !== 'awaiting_deposit') return state;
      operation.status = 'confirming'; operation.updatedAt = Math.max(operation.updatedAt, wallNow); operation.stageDueAt = operation.updatedAt + FUNDING_STAGE_MS;
      updateFundingTransaction(state, operation); return state;
    }
    case 'CANCEL_FUNDING': {
      const operation = state.fundingOperations.find((item) => item.id === action.id);
      if (!operation) throw new Error('입출금 요청을 찾을 수 없어요.');
      if (operation.status === 'cancelled') return state;
      if (!['awaiting_deposit', 'reviewing'].includes(operation.status)) throw new Error('입금 확인이나 네트워크 전송이 시작된 요청은 취소할 수 없어요.');
      restoreFundingHold(state, operation);
      operation.status = 'cancelled'; operation.stageDueAt = null; operation.updatedAt = Math.max(operation.updatedAt, wallNow);
      updateFundingTransaction(state, operation); return state;
    }
    case 'TRANSFER_RESERVE': {
      integer(action.amount, POLICY.minimumTopup);
      if (action.direction !== 'in' && action.direction !== 'out') throw new Error('이동 방향을 선택해 주세요.');
      const source = action.direction === 'in' ? 'spend' : 'reserve';
      const target = action.direction === 'in' ? 'reserve' : 'spend';
      if (state[source] < action.amount) throw new Error('옮길 수 있는 금액이 부족해요. 금액을 줄여 주세요.');
      if (target === 'spend') creditSpend(state, action.amount);
      else state.reserve = safeAdd(state.reserve, action.amount);
      state[source] -= action.amount;
      transaction(state, now, { kind: 'transfer', title: action.direction === 'in' ? '리저브로 이동' : '잔액으로 이동', amount: action.amount, status: 'completed', note: '수수료 없이 옮겼어요. 보상은 옮긴 시점부터 바뀐 금액으로 계산해요.' });
      return state;
    }
    case 'SEND_TO_MEMBER': {
      const member = typeof action.tag === 'string' ? findMember(action.tag) : undefined;
      if (!member) throw new Error('받을 회원을 찾지 못했어요. 태그를 다시 확인해 주세요.');
      integer(action.amount, POLICY.minimumTopup);
      if (state.spend < action.amount) throw new Error('잔액이 부족해요. 보낼 금액을 줄여 주세요.');
      state.spend -= action.amount;
      transaction(state, now, { kind: 'transfer', title: `${maskName(member.name)}님에게 보냄`, amount: -action.amount, status: 'completed', member: member.tag,
        note: `@${member.tag}에게 수수료 없이 바로 보냈어요. 체험판이라 실제로 보내지는 않아요.` });
      return state;
    }
    case 'RECEIVE_FROM_MEMBER': {
      if (!state.account || !state.signedIn) throw new Error('로그인한 뒤 받을 수 있어요.');
      const member = typeof action.tag === 'string' ? findMember(action.tag) : undefined;
      if (!member) throw new Error('보낸 회원을 찾지 못했어요.');
      integer(action.amount, POLICY.minimumTopup);
      creditSpend(state, action.amount);
      transaction(state, now, { kind: 'transfer', title: `${maskName(member.name)}님이 보냄`, amount: action.amount, status: 'completed', member: member.tag,
        note: `@${member.tag}님이 내 태그 @${state.account.tag}로 보냈어요. 수수료 없이 잔액에 바로 더했어요. 체험판이라 실제로 받은 돈은 아니에요.` });
      return state;
    }
    case 'SET_TAG': {
      if (!state.account || !state.signedIn) throw new Error('로그인한 뒤 바꿀 수 있어요.');
      const tag = typeof action.tag === 'string' ? normalizeTag(action.tag) : '';
      if (tag === state.account.tag) throw new Error('지금 쓰는 태그와 같아요.');
      const issue = tagIssue(tag);
      if (issue) throw new Error(issue);
      state.account = { ...state.account, tag };
      return state;
    }
    case 'SET_FINDABLE':
      if (!state.account || !state.signedIn) throw new Error('로그인한 뒤 바꿀 수 있어요.');
      if ((action.by !== 'phone' && action.by !== 'email') || typeof action.enabled !== 'boolean') throw new Error('설정 값을 확인해 주세요.');
      state.account = { ...state.account, [action.by === 'phone' ? 'findByPhone' : 'findByEmail']: action.enabled };
      return state;
    case 'SET_RESERVE_AUTO':
      if (typeof action.enabled !== 'boolean') throw new Error('리저브 자동 사용 설정을 확인해 주세요.');
      state.reserveAuto = action.enabled; return state;
    case 'SET_REWARDS_AUTO':
      if (typeof action.enabled !== 'boolean') throw new Error('리워드 자동 사용 설정을 확인해 주세요.');
      state.rewardsAuto = action.enabled; return state;
    case 'SET_CARD': {
      const previous = state.card;
      if (!record(action.card)) throw new Error('카드 정보가 올바르지 않아요. 다시 시도해 주세요.');
      // Money-bearing fields only move through the actions below.
      const next: CardState = { ...structuredClone(action.card), chargedFee: previous.chargedFee, billingAt: previous.billingAt, nextPlan: previous.nextPlan, pinSet: previous.pinSet,
        physicalPlan: action.card.physical ? previous.physicalPlan : null, replacement: previous.replacement };
      if (next.physicalActive !== previous.physicalActive) throw new Error('실물카드는 카드 비밀번호를 정해 활성화해 주세요.');
      // A card already issued only moves forward through delivery; reissues start over through their own action.
      if (previous.stage === 'active' && DELIVERY_ORDER.indexOf(next.delivery) < DELIVERY_ORDER.indexOf(previous.delivery)) throw new Error('배송 단계는 되돌릴 수 없어요.');
      if (next.stage === 'submitted' && previous.stage !== 'submitted') throw new Error('신청 확인 화면에서 신청해 주세요.');
      if (['submitted', 'approved', 'issued', 'active'].includes(previous.stage) && (next.plan !== previous.plan || next.physical !== previous.physical)) {
        throw new Error('멤버십과 실물카드는 카드 화면에서 바꿔 주세요.');
      }
      if (JSON.stringify(next.address) !== JSON.stringify(previous.address)
        && !(['plan', 'details', 'review'].includes(next.stage) || (next.stage === 'active' && (previous.delivery === 'preparing' || previous.replacement?.delivery === 'preparing')))) {
        throw new Error('배송이 시작되면 배송지를 바꿀 수 없어요.');
      }
      validateCardChange(previous, next);
      if (previous.stage === 'submitted' && next.stage === 'needs_info') refundCardFee(state, now, next, '보완 요청으로 신청이 돌아와');
      if (previous.stage === 'submitted' && next.stage === 'rejected') refundCardFee(state, now, next, '신청이 승인되지 않아');
      if (previous.stage === 'issued' && next.stage === 'active') {
        next.chargedFee = 0;
        if (PLANS[next.plan].annualFee > 0) next.billingAt = addYear(now);
      }
      state.card = next;
      return state;
    }
    case 'SUBMIT_CARD': {
      const card = state.card;
      if (card.stage !== 'review') throw new Error('신청 내용을 확인한 뒤 신청해 주세요.');
      if (card.plan !== 'standard' && !card.physical) throw new Error(`${josa(PLANS[card.plan].short, '은', '는')} ${PLANS[card.plan].card}가 함께 나와요. 받을 주소를 입력해 주세요.`);
      if (card.physical && !card.address) throw new Error('실물카드를 받을 주소를 입력해 주세요.');
      const fee = cardApplicationFee(card);
      const next: CardState = { ...card, stage: 'submitted', reference: card.reference || `AQ-DEMO-${String(wallNow).slice(-8)}`, submittedAt: now, chargedFee: fee, physicalPlan: card.physical ? card.plan : null };
      validateCardChange(card, next);
      if (fee > 0) {
        chargeSpend(state, fee, '신청해 주세요');
        const parts = [PLANS[card.plan].annualFee ? `${PLANS[card.plan].short} 첫해 연회비 ${wonText(PLANS[card.plan].annualFee)}` : '', card.physical && PLANS[card.plan].physicalFee ? `실물카드 발급비 ${wonText(PLANS[card.plan].physicalFee)}` : ''].filter(Boolean);
        transaction(state, now, { kind: 'card', title: '카드 신청 비용', amount: -fee, status: 'completed', note: `${parts.join(' · ')}. 승인되지 않으면 돌려드려요.` });
      }
      state.card = next;
      return state;
    }
    case 'CHANGE_PLAN': {
      const card = state.card;
      if (card.stage !== 'active') throw new Error('카드를 발급받은 뒤 멤버십을 바꿀 수 있어요.');
      if (!PLAN_ORDER.includes(action.plan)) throw new Error('멤버십을 선택해 주세요.');
      const target = PLANS[action.plan];
      if (action.plan === card.plan) {
        if (card.nextPlan === null) throw new Error(`이미 ${josa(target.short, '을', '를')} 쓰고 있어요.`);
        state.card = { ...card, nextPlan: null };
        transaction(state, now, { kind: 'card', title: '멤버십 변경 취소', amount: 0, status: 'completed', note: `${josa(target.short, '을', '를')} 계속 써요. ${fullDate(card.billingAt ?? now)}에 다음 연회비가 나가요.` });
        return state;
      }
      if (rank(action.plan) > rank(card.plan)) {
        chargeSpend(state, target.annualFee, '바꿔 주세요');
        const billingAt = addYear(now);
        const physical = upgradePhysical(card, action.plan);
        state.card = { ...card, plan: action.plan, billingAt, nextPlan: null, ...physical.patch };
        transaction(state, now, { kind: 'card', title: `${target.short} 연회비`, amount: -target.annualFee, status: 'completed',
          note: `${ro(target.short)} 바꿨어요. 페이백 ${target.cashbackRate * 100}%와 리저브 추가 보상이 바로 적용돼요.${PLANS[card.plan].annualFee ? ' 이전 멤버십의 남은 기간 연회비는 돌려드리지 않아요.' : ''} 다음 갱신일은 ${fullDate(billingAt)}이에요.${physical.note}` });
        return state;
      }
      if (card.nextPlan === action.plan) throw new Error(`${target.short} 변경은 이미 예약돼 있어요.`);
      state.card = { ...card, nextPlan: action.plan };
      transaction(state, now, { kind: 'card', title: `${target.short} 변경 예약`, amount: 0, status: 'completed',
        note: `${fullDate(card.billingAt ?? now)}까지 ${PLANS[card.plan].short} 혜택을 쓰고 그날부터 ${ro(target.short)} 바뀌어요.${target.annualFee ? ` 그날 ${target.short} 연회비 ${wonText(target.annualFee)}이 나가요.` : ' 연회비는 더 나가지 않아요.'}` });
      return state;
    }
    case 'ADVANCE_TO_BILLING': {
      if (state.card.stage !== 'active' || state.card.billingAt === null) throw new Error('다가오는 멤버십 갱신일이 없어요.');
      state.clockOffsetMs += Math.max(0, state.card.billingAt - now);
      now = accrue(state, wallNow);
      transaction(state, now, { kind: 'rate', title: '갱신일로 이동 체험', amount: 0, status: 'completed', note: '체험 시간을 다음 멤버십 갱신일로 옮겼어요. 그동안 쌓인 리저브 보상도 리워드에 더했어요.' });
      return state;
    }
    case 'ADD_PHYSICAL_CARD': {
      const card = state.card;
      if (card.stage !== 'active') throw new Error('카드를 발급받은 뒤 신청해 주세요.');
      if (card.physical) throw new Error('이미 실물카드를 신청했어요.');
      if (!validAddress(action.address)) throw new Error('실물카드를 받을 주소를 입력해 주세요.');
      const fee = PLANS[card.plan].physicalFee;
      if (fee) chargeSpend(state, fee, '신청해 주세요');
      state.card = { ...card, physical: true, delivery: 'preparing', physicalActive: false, physicalPlan: card.plan, address: { zip: action.address.zip, road: action.address.road.trim(), detail: action.address.detail.trim() } };
      const cardName = physicalCardName(card.plan);
      transaction(state, now, { kind: 'card', title: fee ? '실물카드 발급비' : `${cardName} 신청`, amount: fee ? -fee : 0, status: 'completed', note: `${josa(cardName, '을', '를')} 신청했어요. 배송까지 ${POLICY.deliveryEstimate}이 걸려요.` });
      return state;
    }
    case 'REISSUE_CARD': {
      const card = state.card;
      if (card.stage !== 'active') throw new Error('사용 중인 카드만 재발급할 수 있어요.');
      const fee = card.physical ? PLANS[card.plan].physicalFee : 0;
      if (fee) chargeSpend(state, fee, '재발급해 주세요');
      const last4 = freshLast4(state, card.last4);
      state.card = { ...card, last4, locked: false, wallets: [], issuedAt: now, delivery: card.physical ? 'preparing' : 'none', physicalActive: false,
        physicalPlan: card.physical ? card.plan : null, replacement: null };
      transaction(state, now, { kind: 'card', title: '카드 재발급', amount: fee ? -fee : 0, status: 'completed',
        note: `끝번호 ${card.last4} 카드는 바로 막혔어요. 새 카드(끝번호 ${last4})를 발급했어요.${card.wallets.length ? ' 휴대폰 결제는 새 카드로 다시 추가해 주세요.' : ''}${card.replacement ? ` 보내던 ${physicalCardName(card.replacement.plan)}도 막고 ${josa(physicalCardName(card.plan), '을', '를')} 새로 보내 드려요.` : ''}${fee ? ` 실물카드 재발급비 ${wonText(fee)}을 냈어요.` : ''}` });
      return state;
    }
    case 'CLOSE_CARD': {
      const card = state.card;
      if (card.stage !== 'active') throw new Error('사용 중인 카드가 없어요.');
      state.card = { ...createInitialState(now).card, last4: freshLast4(state, card.last4) };
      transaction(state, now, { kind: 'card', title: '카드 해지', amount: 0, status: 'completed',
        note: `끝번호 ${card.last4} 카드와 휴대폰 결제가 모두 멈췄어요. 잔액, 리저브, 리워드는 그대로 남아 있어요.${PLANS[card.plan].annualFee ? ` ${PLANS[card.plan].short} 멤버십도 끝나고, 이미 낸 연회비는 돌려드리지 않아요.` : ''}` });
      return state;
    }
    case 'ACTIVATE_PHYSICAL': {
      const card = state.card;
      if (card.stage !== 'active' || !card.physical || card.delivery !== 'delivered') throw new Error('실물카드를 수령한 뒤 활성화해 주세요.');
      if (card.physicalActive) throw new Error('이미 활성화한 실물카드예요.');
      const issue = pinIssue(action.pin);
      if (issue) throw new Error(issue);
      state.card = { ...card, physicalActive: true, pinSet: true };
      return state;
    }
    case 'SET_CARD_PIN': {
      if (state.card.stage !== 'active' || !state.card.physical) throw new Error('실물카드가 있어야 비밀번호를 정할 수 있어요.');
      const issue = pinIssue(action.pin);
      if (issue) throw new Error(issue);
      state.card = { ...state.card, pinSet: true };
      return state;
    }
    case 'ADVANCE_REPLACEMENT': {
      const replacement = state.card.replacement;
      if (state.card.stage !== 'active' || !replacement) throw new Error('보내는 중인 새 카드가 없어요.');
      if (replacement.delivery === 'delivered') throw new Error('새 카드가 이미 도착했어요.');
      state.card = { ...state.card, replacement: { ...replacement, delivery: replacement.delivery === 'preparing' ? 'shipped' : 'delivered' } };
      return state;
    }
    case 'ACTIVATE_REPLACEMENT': {
      const card = state.card;
      if (card.stage !== 'active' || card.replacement?.delivery !== 'delivered') throw new Error('새 카드를 받은 뒤 쓰기 시작해 주세요.');
      if (!card.pinSet) {
        const issue = pinIssue(action.pin ?? '');
        if (issue) throw new Error(issue);
      }
      const name = physicalCardName(card.replacement.plan);
      state.card = { ...card, physicalPlan: card.replacement.plan, replacement: null, delivery: 'delivered', physicalActive: true, pinSet: true };
      transaction(state, now, { kind: 'card', title: `${name} 쓰기 시작`, amount: 0, status: 'completed',
        note: `이제 ${ro(name)} 결제해요. 카드 번호는 그대로이고, 이전 실물카드는 더 이상 결제되지 않아요.${card.pinSet ? ' 카드 비밀번호도 그대로예요.' : ''}` });
      return state;
    }
    case 'SET_LIMITS': {
      const { perPayment, daily, monthly } = action;
      const valid = (value: number, low: number, high: number) => Number.isSafeInteger(value) && value % LIMIT_STEP === 0 && value >= low && value <= high;
      if (!valid(perPayment, LIMIT_STEP, POLICY.perPaymentLimit)) throw new Error(`1회 한도는 1만원부터 ${manWon(POLICY.perPaymentLimit)}까지 1만원 단위로 정해 주세요.`);
      if (!valid(daily, perPayment, POLICY.dailyPaymentLimit)) throw new Error(`일 한도는 1회 한도 이상, ${manWon(POLICY.dailyPaymentLimit)} 이하로 정해 주세요.`);
      if (!valid(monthly, daily, POLICY.monthlyPaymentLimit)) throw new Error(`월 한도는 일 한도 이상, ${manWon(POLICY.monthlyPaymentLimit)} 이하로 정해 주세요.`);
      state.controls = { ...state.controls, perPayment, daily, monthly };
      return state;
    }
    case 'SET_CHANNEL':
      if (action.channel !== 'online' && action.channel !== 'overseas') throw new Error('결제 방식을 확인해 주세요.');
      if (typeof action.enabled !== 'boolean') throw new Error('설정 값을 확인해 주세요.');
      state.controls = { ...state.controls, [action.channel]: action.enabled };
      return state;
    case 'SET_NOTIFICATION':
      if (!['payments', 'funding', 'marketing'].includes(action.key) || typeof action.enabled !== 'boolean') throw new Error('알림 설정을 확인해 주세요.');
      state.notifications = { ...state.notifications, [action.key]: action.enabled, ...(action.key === 'marketing' ? { marketingChangedAt: wallNow } : {}) };
      return state;
    case 'CHANGE_PASSWORD':
      if (!state.account || !state.signedIn) throw new Error('로그인한 뒤 바꿀 수 있어요.');
      if (action.currentHash !== state.account.passwordHash) throw new Error('지금 비밀번호가 맞지 않아요. 다시 입력해 주세요.');
      if (typeof action.nextHash !== 'string' || !HASH_PATTERN.test(action.nextHash)) throw new Error('새 비밀번호를 다시 정해 주세요.');
      if (action.nextHash === state.account.passwordHash) throw new Error('지금과 다른 비밀번호로 정해 주세요.');
      state.account.passwordHash = action.nextHash;
      return state;
    case 'DELETE_ACCOUNT': {
      if (!state.account || !state.signedIn) throw new Error('로그인한 뒤 탈퇴할 수 있어요.');
      if (action.passwordHash !== state.account.passwordHash) throw new Error('비밀번호가 맞지 않아요. 다시 입력해 주세요.');
      const blockers = accountClosureBlockers(state);
      if (blockers.length) throw new Error(blockers[0]);
      return createInitialState(wallNow);
    }
    case 'PAY': {
      integer(action.amount);
      if (state.card.stage !== 'active') throw new Error('카드 신청과 발급을 마친 뒤 결제해 주세요.');
      if (state.card.locked) throw new Error('카드 잠금을 해제한 뒤 결제해 주세요.');
      if (typeof action.merchant !== 'string' || !action.merchant.trim()) throw new Error('결제처를 입력해 주세요.');
      const channel = action.channel ?? 'store';
      if (!['store', 'online', 'overseas'].includes(channel)) throw new Error('결제 방식을 확인해 주세요.');
      if (channel === 'online' && !state.controls.online) throw new Error('온라인 결제를 막아 두었어요. 결제 설정에서 풀 수 있어요.');
      if (channel === 'overseas' && !state.controls.overseas) throw new Error('해외 결제를 막아 두었어요. 결제 설정에서 풀 수 있어요.');
      if (action.amount > state.controls.perPayment) throw new Error(`1회 결제 한도는 ${manWon(state.controls.perPayment)}이에요.`);
      if (state.dailySpent + action.amount > state.controls.daily) throw new Error(`일 결제 한도 ${manWon(state.controls.daily)}을 넘어요.`);
      if (state.monthlySpent + action.amount > state.controls.monthly) throw new Error(`월 결제 한도 ${manWon(state.controls.monthly)}을 넘어요.`);
      if (availableToSpend(state) < action.amount) throw new Error(state.reserveAuto ? '쓸 수 있는 금액이 부족해요. 충전한 뒤 다시 결제해 주세요.' : '잔액이 부족해요. 충전하거나 리저브 자동 사용을 켜 주세요.');
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
      const id = `payment-${nextSequence(state)}`;
      const payment: Payment = { id, merchant: action.merchant.trim(), amount: action.amount, fromRewards, fromSpend, fromReserve, cashback,
        refunded: 0, rewardsRestored: 0, principalRestored: 0, cashbackReversed: 0, cashbackMonth: state.cashbackMonth, timestamp: now, status: 'pending', channel };
      state.payments.unshift(payment);
      transaction(state, now, { kind: 'payment', title: payment.merchant, amount: -payment.amount, status: 'pending', paymentId: id,
        note: `리워드 ${fromRewards.toLocaleString('ko-KR')}원, 잔액 ${fromSpend.toLocaleString('ko-KR')}원, 리저브 ${fromReserve.toLocaleString('ko-KR')}원을 썼어요. 페이백은 결제가 확정되면 쌓여요.` });
      return state;
    }
    case 'CONFIRM_PAYMENT': {
      const payment = state.payments.find((item) => item.id === action.id);
      if (!payment) throw new Error('결제 내역을 찾을 수 없어요.');
      if (payment.status !== 'pending') return state;
      payment.status = 'completed';
      const purchase = state.transactions.find((item) => item.kind === 'payment' && item.paymentId === payment.id);
      if (purchase) purchase.status = 'completed';
      if (payment.cashback > 0) {
        const offset = creditRewards(state, payment.cashback);
        transaction(state, now, { kind: 'payback', title: `${payment.merchant} 페이백`, amount: payment.cashback, status: 'completed', paymentId: payment.id,
          note: `페이백은 리워드로 낸 금액을 빼고 계산했어요.${offset ? ` 이전 페이백 조정분 ${offset.toLocaleString('ko-KR')}원을 먼저 차감했어요.` : ''}` });
      }
      return state;
    }
    case 'REFUND': {
      const payment = state.payments.find((item) => item.id === action.id);
      if (!payment) throw new Error('결제 내역을 찾을 수 없어요.');
      if (payment.status === 'pending') throw new Error('결제 확정 후 환불할 수 있어요.');
      if (payment.status === 'refunded') throw new Error('이미 전액 환불한 결제예요.');
      const amount = action.amount ?? payment.amount - payment.refunded;
      integer(amount);
      if (amount > payment.amount - payment.refunded) throw new Error('남은 결제 금액보다 많이 환불할 수 없어요.');
      const cumulative = payment.refunded + amount;
      const rewardsRestored = Math.floor(payment.fromRewards * cumulative / payment.amount);
      const principalRestored = cumulative - rewardsRestored;
      const principalPaid = payment.amount - payment.fromRewards;
      const cashbackReversed = principalPaid > 0 ? Math.floor(payment.cashback * principalRestored / principalPaid) : 0;
      const rewardRefund = rewardsRestored - payment.rewardsRestored;
      const principalRefund = principalRestored - payment.principalRestored;
      const reversed = cashbackReversed - payment.cashbackReversed;
      creditSpend(state, principalRefund);
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
        note: `잔액 ${principalRefund.toLocaleString('ko-KR')}원과 리워드 ${rewardRefund.toLocaleString('ko-KR')}원을 돌려드렸어요. 페이백은 ${reversed.toLocaleString('ko-KR')}원 조정했어요.${reversed > deduction ? ' 모자란 만큼은 앞으로 쌓일 리워드에서 차감해요.' : ''} 환불 원금에서는 페이백을 빼지 않았어요.` });
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
  return STAGES.includes(value.stage as CardStage) && PLAN_ORDER.includes(value.plan as Plan)
    && ['none', 'preparing', 'shipped', 'delivered'].includes(value.delivery as string)
    && ['physical', 'identityVerified', 'locked', 'physicalActive'].every((key) => typeof value[key] === 'boolean')
    && typeof value.last4 === 'string' && /^\d{4}$/.test(value.last4) && typeof value.reference === 'string'
    && (value.submittedAt === null || timestamp(value.submittedAt)) && (value.issuedAt === null || timestamp(value.issuedAt))
    && Array.isArray(value.wallets) && value.wallets.every((wallet) => wallet === 'samsung' || wallet === 'apple')
    && new Set(value.wallets).size === value.wallets.length
    && whole(value.chargedFee) && (value.billingAt === null || timestamp(value.billingAt))
    && (value.nextPlan === null || PLAN_ORDER.includes(value.nextPlan as Plan))
    && (value.address === null || validAddress(value.address)) && typeof value.pinSet === 'boolean'
    && (value.physicalPlan === null || PLAN_ORDER.includes(value.physicalPlan as Plan))
    && (value.replacement === null || (record(value.replacement) && PLAN_ORDER.includes(value.replacement.plan as Plan)
      && ['preparing', 'shipped', 'delivered'].includes(value.replacement.delivery as string)));
}

function cardConsistent(value: CardState): boolean {
  if (['plan', 'details', 'review', 'submitted', 'needs_info', 'approved', 'issued', 'active'].includes(value.stage) && !value.identityVerified) return false;
  if (['issued', 'active'].includes(value.stage) && value.issuedAt === null) return false;
  if (!value.physical && value.delivery !== 'none') return false;
  if (value.physicalActive && (!value.physical || value.delivery !== 'delivered' || value.stage !== 'active')) return false;
  if (value.wallets.length && value.stage !== 'active') return false;
  if (value.chargedFee > 0 && !['submitted', 'approved', 'issued'].includes(value.stage)) return false;
  if ((value.billingAt !== null) !== (value.stage === 'active' && PLANS[value.plan].annualFee > 0)) return false;
  if (value.nextPlan !== null && (rank(value.nextPlan) >= rank(value.plan) || value.billingAt === null)) return false;
  if (value.physical && value.address === null && ['submitted', 'approved', 'issued', 'active'].includes(value.stage)) return false;
  if (value.physicalActive && !value.pinSet) return false;
  if (value.physicalPlan !== null && !value.physical) return false;
  if (value.replacement !== null && (value.stage !== 'active' || !value.physical || value.delivery === 'preparing')) return false;
  return true;
}

function validFundingOperation(value: unknown): value is FundingOperation {
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.requestId !== 'string'
    || !REQUEST_ID.test(value.requestId)
    || !['deposit', 'withdrawal'].includes(value.kind as string) || value.source !== 'spend'
    || !FUNDING_SYMBOLS.includes(value.symbol as FundingSymbol) || !['polygon', 'ethereum', 'bitcoin'].includes(value.network as string)
    || !['awaiting_deposit', 'confirming', 'converting', 'reviewing', 'broadcasting', 'completed', 'failed', 'cancelled'].includes(value.status as string)
    || !['success', 'failure'].includes(value.simulation as string)
    || !['amountWon', 'feeWon', 'networkFeeWon', 'netWon'].every((key) => whole(value[key]))
    || !nonnegative(value.units) || value.units <= 0 || !nonnegative(value.outputUnits)
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || value.updatedAt < value.createdAt
    || !(value.stageDueAt === null || timestamp(value.stageDueAt))
    || typeof value.address !== 'string' || typeof value.recipient !== 'string' || value.recipient.length > 100
    || (value.destination !== undefined && (value.kind !== 'withdrawal' || !validDestination(value.destination)))
    || (value.failureReason !== undefined && typeof value.failureReason !== 'string')
    || (value.retryOf !== undefined && (typeof value.retryOf !== 'string' || !value.retryOf))) return false;
  const operation = value as unknown as FundingOperation;
  if (!getFundingNetworks(operation.symbol).some((item) => item.id === operation.network)
    || validateFundingAddress(operation.symbol, operation.network, operation.address) !== null
    || operation.amountWon < POLICY.minimumTopup || operation.netWon <= 0
    || operation.amountWon !== operation.feeWon + operation.networkFeeWon + operation.netWon) return false;
  try {
    const quote = createFundingQuote({ kind: operation.kind, source: operation.source, symbol: operation.symbol, network: operation.network,
      ...(operation.kind === 'withdrawal' && operation.source === 'spend' ? { amount: operation.amountWon } : { units: operation.units }) });
    // Deposits saved before inbound conversion became free carry the old 0.5% fee.
    const legacyDepositFee = operation.kind === 'deposit' && operation.feeWon === Math.ceil(operation.amountWon * POLICY.conversionFee - 1e-9);
    const keys = legacyDepositFee ? ['amountWon', 'units', 'networkFeeWon', 'outputUnits'] as const : ['amountWon', 'units', 'feeWon', 'networkFeeWon', 'netWon', 'outputUnits'] as const;
    if (!keys.every((key) => quote[key] === operation[key])) return false;
  } catch { return false; }
  const dueRequired = ['confirming', 'converting', 'reviewing', 'broadcasting'].includes(operation.status);
  if (dueRequired ? operation.stageDueAt === null || operation.stageDueAt < operation.updatedAt : operation.stageDueAt !== null) return false;
  if (operation.kind === 'deposit') {
    return operation.source === 'spend' && operation.networkFeeWon === 0 && operation.outputUnits === 0
      && !['reviewing', 'broadcasting'].includes(operation.status);
  }
  return operation.recipient.trim().length > 0 && operation.outputUnits > 0
    && !['awaiting_deposit', 'confirming', 'converting'].includes(operation.status);
}

function validControls(value: unknown): value is PaymentControls {
  if (!record(value) || typeof value.online !== 'boolean' || typeof value.overseas !== 'boolean') return false;
  const { perPayment, daily, monthly } = value;
  return whole(perPayment) && whole(daily) && whole(monthly) && perPayment >= LIMIT_STEP && perPayment <= POLICY.perPaymentLimit
    && daily >= perPayment && daily <= POLICY.dailyPaymentLimit && monthly >= daily && monthly <= POLICY.monthlyPaymentLimit;
}

function validNotifications(value: unknown): value is NotificationSettings {
  return record(value) && ['payments', 'funding', 'marketing'].every((key) => typeof value[key] === 'boolean')
    && (value.marketingChangedAt === null || timestamp(value.marketingChangedAt));
}

function validAccount(value: unknown): value is Account {
  return value === null || (record(value) && typeof value.email === 'string' && EMAIL_PATTERN.test(value.email)
    && typeof value.passwordHash === 'string' && HASH_PATTERN.test(value.passwordHash)
    && typeof value.name === 'string' && value.name.trim().length >= 2 && value.name.length <= 30
    && typeof value.birthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.birthDate)
    && typeof value.phone === 'string' && PHONE_PATTERN.test(value.phone) && validKyc(value.kyc) && timestamp(value.verifiedAt)
    && (value.risk === 'standard' || value.risk === 'high') && timestamp(value.kycDueAt) && value.kycDueAt > value.verifiedAt
    && typeof value.tag === 'string' && TAG_PATTERN.test(value.tag) && typeof value.findByPhone === 'boolean' && typeof value.findByEmail === 'boolean');
}

function validState(value: unknown): value is AppState {
  if (!record(value) || value.version !== 1 || !validAccount(value.account) || typeof value.signedIn !== 'boolean' || (value.signedIn && !value.account)) return false;
  const integers = ['spend', 'reserve', 'rewards', 'rewardDebt', 'monthlyCashback', 'dailySpent', 'monthlySpent', 'sequence'];
  if (!integers.every((key) => whole(value[key])) || !nonnegative(value.accrued) || !nonnegative(value.clockOffsetMs)
    || !timestamp(value.lastAccruedAt) || !nonnegative(value.reserveRate) || value.reserveRate > 1
    || typeof value.reserveAuto !== 'boolean' || typeof value.rewardsAuto !== 'boolean' || !validCard(value.card) || !cardConsistent(value.card)
    || !validControls(value.controls) || !validNotifications(value.notifications)) return false;
  if (!['cashbackMonth', 'spendingMonth'].every((key) => typeof value[key] === 'string' && /^\d{4}-\d{2}$/.test(value[key] as string))
    || typeof value.spendingDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.spendingDay)) return false;
  if (!Array.isArray(value.rateHistory) || value.rateHistory.length === 0
    || !value.rateHistory.every((item) => record(item) && nonnegative(item.rate) && item.rate <= 1 && timestamp(item.timestamp))) return false;
  if (!Array.isArray(value.payments) || !value.payments.every((item) => {
    if (!record(item) || typeof item.id !== 'string' || typeof item.merchant !== 'string' || !timestamp(item.timestamp)
      || typeof item.cashbackMonth !== 'string' || !/^\d{4}-\d{2}$/.test(item.cashbackMonth)
      || !['pending', 'completed', 'refunded', 'partially_refunded'].includes(item.status as string)
      || (item.channel !== undefined && !['store', 'online', 'overseas'].includes(item.channel as string))) return false;
    if (!['amount', 'fromRewards', 'fromSpend', 'fromReserve', 'cashback', 'refunded', 'rewardsRestored', 'principalRestored', 'cashbackReversed'].every((key) => whole(item[key]))) return false;
    const payment = item as unknown as Payment;
    return payment.amount > 0 && payment.fromRewards + payment.fromSpend + payment.fromReserve === payment.amount
      && payment.refunded <= payment.amount && payment.rewardsRestored <= payment.fromRewards
      && payment.principalRestored <= payment.fromSpend + payment.fromReserve && payment.cashbackReversed <= payment.cashback
      && payment.rewardsRestored + payment.principalRestored === payment.refunded;
  })) return false;
  if (!Array.isArray(value.fundingOperations) || !value.fundingOperations.every(validFundingOperation)) return false;
  const operations = value.fundingOperations as FundingOperation[];
  if (new Set(operations.map((item) => item.id)).size !== operations.length || new Set(operations.map((item) => item.requestId)).size !== operations.length) return false;
  if (operations.some((item) => item.retryOf && (item.retryOf === item.id || !operations.some((original) => original.id === item.retryOf && ['failed', 'cancelled'].includes(original.status))))) return false;
  const heldSpend = operations.reduce((sum, item) => sum + (item.kind === 'withdrawal' && item.source === 'spend'
    && ['reviewing', 'broadcasting'].includes(item.status) ? item.amountWon : 0), 0);
  if (!whole((value.spend as number) + heldSpend)) return false;
  const transactionsValid = Array.isArray(value.transactions) && value.transactions.every((item) => record(item)
    && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.note === 'string'
    && typeof item.amount === 'number' && Number.isSafeInteger(item.amount) && timestamp(item.timestamp)
    && ['deposit', 'transfer', 'convert', 'payment', 'refund', 'reward', 'payback', 'rate', 'card'].includes(item.kind as string)
    && ['pending', 'completed', 'refunded', 'partially_refunded', 'failed', 'cancelled'].includes(item.status as string)
    && (item.paymentId === undefined || typeof item.paymentId === 'string')
    && (item.fundingId === undefined || typeof item.fundingId === 'string')
    && (item.member === undefined || typeof item.member === 'string'));
  if (!transactionsValid) return false;
  const transactions = value.transactions as Transaction[];
  if (transactions.some((item) => item.fundingId && !operations.some((operation) => operation.id === item.fundingId))) return false;
  return operations.every((operation) => {
    const entries = transactions.filter((item) => item.fundingId === operation.id);
    const status = ['completed', 'failed', 'cancelled'].includes(operation.status) ? operation.status : 'pending';
    return entries.length === 1 && entries[0].status === status
      && entries[0].amount === (operation.kind === 'deposit' ? operation.netWon : -operation.amountWon);
  });
}

/** Saved states from before coins were converted on arrival: sell what was held, and any coin withdrawal still in flight, into the spend balance once. */
function convertHeldCoins(candidate: Record<string, unknown>): Record<string, unknown> {
  if (!('holdings' in candidate)) return candidate;
  const { holdings, ...rest } = candidate;
  const coinWon = (symbol: unknown, units: unknown) => SYMBOLS.includes(symbol as AssetSymbol) && nonnegative(units) ? unitsToWon(units, ASSETS[symbol as AssetSymbol].price) : 0;
  const operations: unknown[] = Array.isArray(rest.fundingOperations) ? rest.fundingOperations : [];
  const legacy = operations.filter((item): item is Record<string, unknown> => record(item) && item.source === 'holdings');
  // Coins already taken out of the wallet for a withdrawal that never finished go back as won; the request itself is dropped.
  const inFlight = legacy.filter((item) => item.kind === 'withdrawal' && ['reviewing', 'broadcasting'].includes(item.status as string));
  const won = (record(holdings) ? SYMBOLS.reduce((sum, symbol) => sum + coinWon(symbol, holdings[symbol]), 0) : 0)
    + inFlight.reduce((sum, item) => sum + coinWon(item.symbol, item.units), 0);
  const ids = new Set(legacy.map((item) => item.id));
  const transactions = Array.isArray(rest.transactions) ? rest.transactions.map((item) => {
    if (!record(item) || !ids.has(item.fundingId)) return item;
    const { fundingId: _dropped, ...entry } = item;
    return entry.status === 'pending' ? { ...entry, status: 'cancelled' } : entry;
  }) : rest.transactions;
  const cleaned = { ...rest, fundingOperations: operations.filter((item) => !legacy.includes(item as Record<string, unknown>)), transactions };
  if (won <= 0 || !whole(rest.spend) || !whole(rest.sequence) || !timestamp(rest.lastAccruedAt) || !Array.isArray(transactions)) return cleaned;
  const sequence = rest.sequence + 1;
  const entry: Transaction = { id: `tx-${sequence}`, kind: 'convert', title: '보유 코인 자동 전환', amount: won, timestamp: rest.lastAccruedAt, status: 'completed',
    note: '이전 체험에서 남아 있던 코인을 원화 스테이블로 바꿔 잔액에 더했어요.' };
  return { ...cleaned, spend: rest.spend + won, sequence, transactions: [entry, ...transactions] };
}

/** Older saves: fill fields added later, and move Basic and Plus to Standard (the monthly Plus fee is not carried over). */
function migrateCard(card: Record<string, unknown>): Record<string, unknown> {
  const filled: Record<string, unknown> = { wallets: [], chargedFee: 0, nextPlan: null, billingAt: null,
    address: card.physical ? { zip: '04500', road: '서울특별시 중구 아쿠아로 1', detail: '데모동 101호' } : null, pinSet: Boolean(card.physicalActive), ...card };
  if (filled.plan === 'basic' || filled.plan === 'plus') Object.assign(filled, { plan: 'standard', nextPlan: null, billingAt: null });
  // Cards made before tiers had their own material carry the tier they hold now.
  if (!('physicalPlan' in filled)) filled.physicalPlan = filled.physical && !['not_applied', 'identity', 'plan', 'details', 'review'].includes(filled.stage as string) ? filled.plan : null;
  if (!('replacement' in filled)) filled.replacement = null;
  return filled;
}

/**
 * Older saves: accounts from before tags were stored get one made from the email, the way new accounts do; finding by phone
 * or email stays off. Those from before the fuller customer check get a made-up home address, the face check, and the
 * standard three years until it is repeated.
 */
function migrateAccount(account: Record<string, unknown>): Record<string, unknown> {
  const kyc = record(account.kyc) ? { match: 'face', address: { ...SAMPLE_ADDRESSES[0], detail: '' }, pep: false, evidence: null, ...account.kyc } : account.kyc;
  return { findByPhone: false, findByEmail: false, ...(typeof account.email === 'string' ? { tag: initialTag(account.email) } : {}),
    risk: 'standard', ...(timestamp(account.verifiedAt) ? { kycDueAt: addYears(account.verifiedAt, RECHECK_YEARS.standard) } : {}), ...account, kyc };
}

export function loadState(): AppState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const candidate: unknown = JSON.parse(raw);
      const migrated = record(candidate) && candidate.version === 1
        ? convertHeldCoins({ ...candidate, fundingOperations: candidate.fundingOperations ?? [], account: record(candidate.account) ? migrateAccount(candidate.account) : candidate.account ?? null, signedIn: candidate.signedIn ?? false,
          controls: candidate.controls ?? defaultControls(), notifications: candidate.notifications ?? defaultNotifications(),
          card: record(candidate.card) ? migrateCard(candidate.card) : candidate.card }) : candidate;
      if (validState(migrated)) return applyAction(migrated, { type: 'TICK' });
    }
  } catch { /* Disabled storage or corrupt snapshots reset safely to demo balances. */ }
  return createInitialState();
}

export function saveState(state: AppState): void {
  try {
    if (validState(state)) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* Browsing with disabled/full storage still works for this session. */ }
}
