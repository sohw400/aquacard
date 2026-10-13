import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, availableToSpend, createInitialState, loadState, portfolioValue, saveState, STORAGE_KEY } from './engine';
import { POLICY } from './policy';
import { assertFundingQuoteFresh, getFundingQuote } from './funding';
import { getHeldFundingWon } from './movements';
import type { Action, AppState, AssetSymbol, CardState } from './types';

const NOW = Date.UTC(2026, 9, 13, 3);
const DAY = 86_400_000;
const YEAR = 365 * DAY;
function activeState(now = NOW): AppState {
  const state = createInitialState(now);
  state.card = { ...state.card, stage: 'active', identityVerified: true, submittedAt: now, issuedAt: now };
  return state;
}
function confirm(state: AppState, now = NOW): AppState {
  return applyAction(state, { type: 'CONFIRM_PAYMENT', id: state.payments[0].id }, now);
}
function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} should equal ${expected}`);
}

type StartFunding = Extract<Action, { type: 'START_FUNDING' }>;
const depositRequest = (overrides: Partial<StartFunding> = {}): StartFunding => ({
  type: 'START_FUNDING', requestId: 'deposit-request', kind: 'deposit', source: 'spend',
  symbol: 'USDC', network: 'polygon', units: 10, quotedAt: NOW, ...overrides,
});
const withdrawalRequest = (overrides: Partial<StartFunding> = {}): StartFunding => ({
  type: 'START_FUNDING', requestId: 'withdrawal-request', kind: 'withdrawal', source: 'spend',
  symbol: 'USDC', network: 'polygon', amount: 14_000, address: 'aqua-preview:polygon:usdc', recipient: '내 지갑', quotedAt: NOW, ...overrides,
});
function withFundingStorage(run: (storage: { values: Map<string, string>; setTime: (time: number) => void }) => void): void {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalNow = Date.now;
  const values = new Map<string, string>();
  let now = NOW;
  Date.now = () => now;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try { run({ values, setTime: (time) => { now = time; } }); }
  finally {
    Date.now = originalNow;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('초기 총 자산과 선택한 결제 잔액만 계산한다', () => {
  const state = createInitialState(NOW);
  assert.equal(availableToSpend(state), 132_780);
  assert.equal(portfolioValue(state), 2_018_500);
  assert.equal(availableToSpend({ ...state, reserveAuto: true }), 1_382_780);
  assert.equal(availableToSpend({ ...state, rewardsAuto: false }), 128_500);
});

test('결제는 리워드→결제 지갑→옵트인 Reserve 순서이며 확정 전 페이백을 지급하지 않는다', () => {
  const before = activeState();
  before.spend = 3_000; before.reserveAuto = true;
  const pending = applyAction(before, { type: 'PAY', merchant: '테스트 카페', amount: 10_000 }, NOW);
  assert.equal(pending.rewards, 0);
  assert.equal(pending.spend, 0);
  assert.equal(pending.reserve, 1_247_280);
  assert.equal(pending.payments[0].fromReserve, 2_720);
  assert.equal(pending.payments[0].cashback, 57);
  assert.equal(pending.payments[0].status, 'pending');
  const completed = confirm(pending);
  assert.equal(completed.rewards, 57);
  assert.equal(completed.payments[0].status, 'completed');
  assert.equal(completed.transactions.find((item) => item.kind === 'payment')?.status, 'completed');
  assert.deepEqual(confirm(completed), completed, '동일한 확정 요청은 보상을 중복 지급하지 않는다');
  assert.equal(before.spend, 3_000, '호출자의 상태를 수정하지 않는다');
});

test('활성화되지 않거나 잠긴 카드와 부족한 결제 잔액을 거절한다', () => {
  assert.throws(() => applyAction(createInitialState(NOW), { type: 'PAY', merchant: '카페', amount: 1_000 }, NOW), /발급/);
  const state = activeState();
  state.card.locked = true;
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '카페', amount: 1_000 }, NOW), /잠금/);
  state.card.locked = false;
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '카페', amount: 200_000 }, NOW), /Reserve 자동/);
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '카페', amount: 0 }, NOW), /정수/);
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '카페', amount: 1.2 }, NOW), /정수/);
});

test('리워드로 결제한 금액에는 페이백이 없다', () => {
  const pending = applyAction(activeState(), { type: 'PAY', merchant: '카페', amount: 4_000 }, NOW);
  assert.equal(pending.payments[0].cashback, 0);
  assert.equal(confirm(pending).rewards, 280);
});

test('5,800원 반복 결제의 잔액 57원은 실제 리워드 차감 후 새 페이백을 받은 결과다', () => {
  let state = activeState();
  for (const [before, cashback] of [[4_280, 15], [15, 57], [57, 57]]) {
    assert.equal(state.rewards, before);
    const pending = applyAction(state, { type: 'PAY', merchant: '한강커피', amount: 5_800 }, NOW);
    assert.equal(pending.payments[0].fromRewards, before);
    assert.equal(pending.payments[0].fromSpend, 5_800 - before);
    assert.equal(pending.rewards, 0, '새 페이백을 지급하기 전에 기존 리워드를 실제로 사용한다');
    assert.equal(pending.payments[0].cashback, cashback);
    state = confirm(pending);
    assert.equal(state.rewards, cashback);
    const repeatedConfirmation = confirm(state);
    assert.deepEqual(repeatedConfirmation, state, '확정 재요청은 새 페이백을 중복 지급하지 않는다');
  }
  assert.equal(state.rewards, 57);
  assert.equal(state.spend, 115_452);
  assert.equal(state.monthlyCashback, 129);
  assert.equal(state.transactions.filter((item) => item.kind === 'payback').length, 3);
});

const earned = (state: AppState, rewardsBefore = 4_280) => state.rewards - rewardsBefore + state.accrued;

test('Reserve 적립은 시간에 비례하며 동일 시각의 재실행과 시계 역행은 중복 적립하지 않는다', () => {
  const initial = createInitialState(NOW);
  const first = applyAction(initial, { type: 'TICK' }, NOW + DAY);
  close(earned(first), 1_250_000 * 0.05 / 365);
  assert.equal(first.rewards, 4_280 + 171, '1원이 된 보상은 받기 없이 바로 리워드에 더한다');
  assert.ok(first.accrued < 1);
  assert.deepEqual(applyAction(first, { type: 'TICK' }, NOW + DAY), first);
  assert.deepEqual(applyAction(first, { type: 'TICK' }, NOW), first);
});

test('같은 날 쌓인 리저브 보상은 이용 내역 한 줄에 합산하고 다음 날은 새 줄로 남긴다', () => {
  let state = createInitialState(NOW);
  state = applyAction(state, { type: 'TICK' }, NOW + 3_600_000);
  state = applyAction(state, { type: 'TICK' }, NOW + 7_200_000);
  const today = state.transactions.filter((item) => item.kind === 'reward' && item.title === '리저브 보상');
  assert.equal(today.length, 1);
  assert.equal(today[0].amount, state.rewards - 4_280);
  state = applyAction(state, { type: 'TICK' }, NOW + DAY);
  assert.equal(state.transactions.filter((item) => item.kind === 'reward' && item.title === '리저브 보상').length, 2);
  assert.equal(state.transactions.filter((item) => item.title === '리저브 보상').reduce((sum, item) => sum + item.amount, 0), state.rewards - 4_280);
});

test('입금과 보상률 변경 시 이전 잔액·보상률로 먼저 적립한다', () => {
  let state = createInitialState(NOW);
  state = applyAction(state, { type: 'DEPOSIT', bucket: 'reserve', amount: 1_250_000 }, NOW + DAY);
  close(earned(state), 1_250_000 * 0.05 / 365);
  state = applyAction(state, { type: 'CHANGE_RATE', rate: 0.08 }, NOW + 2 * DAY);
  close(earned(state), (1_250_000 * 0.05 + 2_500_000 * 0.05) / 365);
  state = applyAction(state, { type: 'TICK' }, NOW + 3 * DAY);
  close(earned(state), (1_250_000 * 0.05 + 2_500_000 * 0.05 + 2_500_000 * 0.08) / 365);
  assert.equal(state.rateHistory.length, 2);
});

test('Reserve 보상 대상 상한과 하루 진행을 적용하고 정수 원만 리워드로 옮긴다', () => {
  let state = createInitialState(NOW);
  state.reserve = 20_000_000;
  state = applyAction(state, { type: 'TICK' }, NOW + YEAR);
  assert.equal(state.rewards, 4_280 + 500_000);
  close(state.accrued, 0);
  const next = applyAction(createInitialState(NOW), { type: 'ADVANCE_DAY' }, NOW);
  assert.equal(next.clockOffsetMs, DAY);
  assert.equal(next.rewards, 4_451);
  close(next.accrued, 1_250_000 * 0.05 / 365 - 171);
});

test('Reserve 결제 이후 잔액에만 다음 구간 보상이 적립된다', () => {
  let state = activeState();
  state.spend = 0; state.rewards = 0; state.reserveAuto = true; state.rewardsAuto = false;
  state = applyAction(state, { type: 'PAY', merchant: '서점', amount: 100_000 }, NOW + DAY);
  assert.equal(state.reserve, 1_150_000);
  state = applyAction(state, { type: 'TICK' }, NOW + 2 * DAY);
  close(earned(state, 0), (1_250_000 + 1_150_000) * 0.05 / 365);
});

test('일·월 결제 한도는 서울 날짜 경계에 갱신되며 건별 한도도 적용한다', () => {
  const late = Date.UTC(2026, 9, 13, 14, 59); // 서울 23:59
  let state = activeState(late);
  state.spend = 6_000_000; state.rewardsAuto = false;
  state = applyAction(state, { type: 'PAY', merchant: '상점', amount: 500_000 }, late);
  state = applyAction(state, { type: 'PAY', merchant: '상점', amount: 500_000 }, late);
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '상점', amount: 1 }, late), /일 결제 한도/);
  state = applyAction(state, { type: 'PAY', merchant: '상점', amount: 1 }, late + 60_000);
  assert.equal(state.dailySpent, 1);
  assert.equal(state.spendingDay, '2026-10-14');
  assert.equal(state.monthlySpent, 1_000_001);
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '상점', amount: 500_001 }, late + 60_000), /1회 결제 한도/);
  state.monthlySpent = 5_000_000;
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '상점', amount: 1 }, late + 60_000), /월 결제 한도/);
  state = applyAction(state, { type: 'TICK' }, Date.UTC(2026, 9, 31, 15));
  assert.equal(state.monthlySpent, 0);
  assert.equal(state.spendingMonth, '2026-11');
});

test('페이백 한도는 승인 시 예약해서 미확정 결제로 한도를 초과하지 않는다', () => {
  let state = activeState();
  state.spend = 3_000_000; state.rewardsAuto = false;
  state.monthlyCashback = 9_900;
  state = applyAction(state, { type: 'PAY', merchant: 'A', amount: 20_000 }, NOW);
  assert.equal(state.payments[0].cashback, 100);
  state = applyAction(state, { type: 'PAY', merchant: 'B', amount: 20_000 }, NOW);
  assert.equal(state.payments[0].cashback, 0);
  assert.equal(state.monthlyCashback, 10_000);
});

test('Plus 페이백과 월 상한을 적용하되 Reserve 보상률은 동일하다', () => {
  let state = activeState();
  state.card.plan = 'plus'; state.rewardsAuto = false;
  state = applyAction(state, { type: 'PAY', merchant: '상점', amount: 10_000 }, NOW);
  assert.equal(state.payments[0].cashback, 150);
  assert.equal(state.reserveRate, 0.05);
});

test('부분 환불을 누적 배분해 원금·리워드를 복구하고 전액 환불 후 중복 환불을 막는다', () => {
  let state = activeState();
  state.rewards = 101; state.spend = 1_000;
  state = confirm(applyAction(state, { type: 'PAY', merchant: '환불 상점', amount: 201 }, NOW));
  const id = state.payments[0].id;
  state = applyAction(state, { type: 'REFUND', id, amount: 100 }, NOW);
  assert.equal(state.payments[0].rewardsRestored, 50);
  assert.equal(state.payments[0].principalRestored, 50);
  assert.equal(state.payments[0].cashbackReversed, 0);
  assert.equal(state.payments[0].status, 'partially_refunded');
  state = applyAction(state, { type: 'REFUND', id }, NOW);
  assert.equal(state.rewards, 101);
  assert.equal(state.spend, 1_000);
  assert.equal(state.payments[0].cashbackReversed, 1);
  assert.equal(state.payments[0].status, 'refunded');
  assert.equal(state.monthlyCashback, 0);
  assert.throws(() => applyAction(state, { type: 'REFUND', id }, NOW), /이미 전액/);
});

test('사용한 페이백 환수 부족분은 향후 리워드에서 상계하고 고객 원금은 보존한다', () => {
  let state = activeState();
  state.rewards = 0;
  state = confirm(applyAction(state, { type: 'PAY', merchant: '첫 결제', amount: 10_000 }, NOW));
  const firstId = state.payments[0].id;
  state = confirm(applyAction(state, { type: 'PAY', merchant: '보상 사용', amount: 100 }, NOW));
  const spendBeforeRefund = state.spend;
  state = applyAction(state, { type: 'REFUND', id: firstId }, NOW);
  assert.equal(state.spend, spendBeforeRefund + 10_000);
  assert.equal(state.rewardDebt, 100);
  assert.equal(state.rewards, 0);
  state.accrued = 150.75;
  state = applyAction(state, { type: 'TICK' }, NOW);
  assert.equal(state.rewardDebt, 0);
  assert.equal(state.rewards, 50);
  assert.equal(state.accrued, 0.75);
});

test('전월 결제 환불은 현재 월 페이백 한도를 복구하지 않는다', () => {
  const january = Date.UTC(2026, 0, 30, 3);
  let state = activeState(january);
  state.rewardsAuto = false;
  state = confirm(applyAction(state, { type: 'PAY', merchant: '1월 상점', amount: 10_000 }, january), january);
  const januaryId = state.payments[0].id;
  const february = Date.UTC(2026, 1, 2, 3);
  state = applyAction(state, { type: 'PAY', merchant: '2월 상점', amount: 20_000 }, february);
  assert.equal(state.monthlyCashback, 200);
  state = applyAction(state, { type: 'REFUND', id: januaryId }, february);
  assert.equal(state.monthlyCashback, 200);
  assert.equal(state.payments.find((item) => item.id === januaryId)?.cashbackMonth, '2026-01');
});

test('미확정 결제와 남은 금액을 초과하는 부분 환불을 거절한다', () => {
  const pending = applyAction(activeState(), { type: 'PAY', merchant: '상점', amount: 10_000 }, NOW);
  const id = pending.payments[0].id;
  assert.throws(() => applyAction(pending, { type: 'REFUND', id }, NOW), /확정 후/);
  assert.throws(() => applyAction(confirm(pending), { type: 'REFUND', id, amount: 10_001 }, NOW), /남은 결제/);
});

test('지갑 이동·출금은 원금만 대상으로 하며 음수 잔액을 허용하지 않는다', () => {
  let state = createInitialState(NOW);
  const assetsBefore = portfolioValue(state);
  state = applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'in', amount: 10_000 }, NOW);
  state = applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'out', amount: 10_000 }, NOW);
  assert.equal(portfolioValue(state), assetsBefore);
  assert.throws(() => applyAction(state, { type: 'WITHDRAW_FUNDS', bucket: 'spend', amount: state.spend + 1 }, NOW), /부족/);
  state = applyAction(state, { type: 'WITHDRAW_FUNDS', bucket: 'reserve', amount: 10_000 }, NOW);
  assert.equal(state.reserve, 1_240_000);
  assert.equal(state.rewards, 4_280);
  assert.throws(() => applyAction(state, { type: 'DEPOSIT', bucket: 'reserve', amount: 999 }, NOW), /1,000/);
});

test('코인 입출금과 원화 전환은 보유량을 반영하고 받는 쪽 전환에는 수수료가 없다', () => {
  let state = createInitialState(NOW);
  state = applyAction(state, { type: 'DEPOSIT_ASSET', symbol: 'USDT', units: 10 }, NOW);
  state = applyAction(state, { type: 'WITHDRAW_ASSET', symbol: 'USDT', units: 3 }, NOW);
  assert.equal(state.holdings.USDT, 7);
  state = applyAction(state, { type: 'CONVERT', symbol: 'USDT', units: 7, quotedAt: NOW }, NOW);
  assert.equal(state.holdings.USDT, 0);
  assert.equal(state.spend, 128_500 + 9_800);
  assert.throws(() => applyAction(state, { type: 'WITHDRAW_ASSET', symbol: 'USDT', units: 1 }, NOW), /부족/);
  assert.throws(() => applyAction(state, { type: 'CONVERT', symbol: 'BTC', units: 0.000001 }, NOW), /1,000/);
  assert.throws(() => applyAction(state, { type: 'CONVERT', symbol: 'USDC', units: 101 }, NOW), /부족/);
});

test('전환 견적 TTL은 실시간 기준이며 하루 진행 시뮬레이션에 영향을 받지 않는다', () => {
  const state = applyAction(createInitialState(NOW), { type: 'ADVANCE_DAY' }, NOW);
  assert.doesNotThrow(() => applyAction(state, { type: 'CONVERT', symbol: 'USDC', units: 1, quotedAt: NOW }, NOW + POLICY.quoteTtlSeconds * 1_000));
  assert.throws(() => applyAction(state, { type: 'CONVERT', symbol: 'USDC', units: 1, quotedAt: NOW }, NOW + POLICY.quoteTtlSeconds * 1_000 + 1), /만료/);
  assert.throws(() => applyAction(state, { type: 'CONVERT', symbol: 'USDC', units: 1, quotedAt: NOW + 1 }, NOW), /만료/);
});

test('외부 코인 입금은 수수료 없이 원화 결제 잔액으로 자동 전환하며 기존 보유 코인은 유지한다', () => {
  const initial = createInitialState(NOW);
  const snapshot = structuredClone(initial);
  const quote = getFundingQuote({ direction: 'receive', symbol: 'USDC', units: 10 });
  assert.deepEqual(quote, { direction: 'receive', symbol: 'USDC', price: 1_400, inputUnits: 10,
    grossWon: 14_000, feeWon: 0, netWon: 14_000, outputUnits: 0 });
  const funded = applyAction(initial, { type: 'RECEIVE_ASSET', symbol: 'USDC', units: 10, quotedAt: NOW }, NOW);
  assert.equal(funded.spend, 142_500);
  assert.equal(funded.reserve, initial.reserve);
  assert.equal(funded.rewards, initial.rewards);
  assert.deepEqual(funded.holdings, initial.holdings, '입금 수량을 보유 코인 지갑에 중복 반영하지 않는다');
  assert.equal(portfolioValue(funded), portfolioValue(initial) + 14_000);
  assert.equal(funded.transactions[0].kind, 'deposit');
  assert.equal(funded.transactions[0].amount, 14_000);
  assert.match(funded.transactions[0].note, /입금 수수료 없이 14,000원/);
  assert.deepEqual(initial, snapshot);
});

test('원화 결제 잔액을 코인으로 출금하며 수수료를 제외한 수령 예상량만 계산한다', () => {
  const initial = createInitialState(NOW);
  const snapshot = structuredClone(initial);
  const quote = getFundingQuote({ direction: 'withdraw', symbol: 'USDT', amount: 14_000 });
  assert.deepEqual(quote, { direction: 'withdraw', symbol: 'USDT', price: 1_400, inputUnits: 0,
    grossWon: 14_000, feeWon: 70, netWon: 13_930, outputUnits: 9.95 });
  assert.equal(initial.holdings.USDT, 0, '원화 출금은 기존 USDT 보유량을 필요로 하지 않는다');
  const withdrawn = applyAction(initial, { type: 'WITHDRAW_CRYPTO', symbol: 'USDT', amount: 14_000, quotedAt: NOW }, NOW);
  assert.equal(withdrawn.spend, 114_500);
  assert.equal(withdrawn.reserve, initial.reserve);
  assert.equal(withdrawn.rewards, initial.rewards);
  assert.deepEqual(withdrawn.holdings, initial.holdings);
  assert.equal(portfolioValue(withdrawn), portfolioValue(initial) - 14_000);
  assert.equal(withdrawn.transactions[0].amount, -14_000);
  assert.match(withdrawn.transactions[0].note, /예상 9\.95 USDT/);
  assert.match(withdrawn.transactions[0].note, /외부 지갑 전송은 실행하지 않습니다/);
  assert.deepEqual(initial, snapshot);
});

test('출금은 결제 잔액까지만 허용하고 리워드·Reserve 자동 사용으로 부족분을 충당하지 않는다', () => {
  const initial = createInitialState(NOW);
  const withdrawn = applyAction(initial, { type: 'WITHDRAW_CRYPTO', symbol: 'BTC', amount: initial.spend, quotedAt: NOW }, NOW);
  assert.equal(withdrawn.spend, 0);
  assert.equal(withdrawn.rewards, 4_280);
  assert.equal(withdrawn.reserve, 1_250_000);
  const insufficient = { ...initial, spend: 999, reserveAuto: true, rewardsAuto: true };
  const snapshot = structuredClone(insufficient);
  assert.ok(availableToSpend(insufficient) > 1_000);
  assert.throws(() => applyAction(insufficient, { type: 'WITHDRAW_CRYPTO', symbol: 'ETH', amount: 1_000, quotedAt: NOW }, NOW), /결제 잔액이 부족/);
  assert.deepEqual(insufficient, snapshot, '출금 실패는 원금·리워드·보유 코인·거래 내역을 변경하지 않는다');
});

test('입금 평가액은 십진수로 계산해 원 미만을 절사하고 출금 전환 수수료만 원 단위로 올림한다', () => {
  const cases: [AssetSymbol, number, number, number, number][] = [
    ['USDC', 1.005, 1_407, 0, 1_407],
    ['BTC', 0.00000822, 1_233, 0, 1_233],
    ['ETH', 0.000251, 1_004, 0, 1_004],
    ['USDC', 1.001, 1_401, 0, 1_401],
  ];
  for (const [symbol, units, grossWon, feeWon, netWon] of cases) {
    const quote = getFundingQuote({ direction: 'receive', symbol, units });
    assert.equal(quote.grossWon, grossWon);
    assert.equal(quote.feeWon, feeWon);
    assert.equal(quote.netWon, netWon);
    assert.equal(grossWon, feeWon + netWon);
    assert.ok([grossWon, feeWon, netWon].every(Number.isSafeInteger));
    const funded = applyAction(createInitialState(NOW), { type: 'RECEIVE_ASSET', symbol, units, quotedAt: NOW }, NOW);
    assert.equal(funded.spend, 128_500 + netWon);
  }
  for (const [amount, feeWon, netWon] of [[1_000, 5, 995], [1_001, 6, 995], [1_200, 6, 1_194]]) {
    const quote = getFundingQuote({ direction: 'withdraw', symbol: 'USDC', amount });
    assert.equal(quote.feeWon, feeWon);
    assert.equal(quote.netWon, netWon);
    close(quote.outputUnits * quote.price, netWon);
  }
});

test('코인 입출금은 최소 평가액·정수 출금액·지원 자산·유한 수량을 검증한다', () => {
  const initial = createInitialState(NOW);
  const snapshot = structuredClone(initial);
  for (const units of [0, -1, NaN, Infinity, 0.1, Number.MAX_VALUE]) {
    assert.throws(() => applyAction(initial, { type: 'RECEIVE_ASSET', symbol: 'USDC', units, quotedAt: NOW }, NOW));
    assert.deepEqual(initial, snapshot);
  }
  for (const amount of [0, -1, 999, 1_000.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => applyAction(initial, { type: 'WITHDRAW_CRYPTO', symbol: 'USDC', amount, quotedAt: NOW }, NOW));
    assert.deepEqual(initial, snapshot);
  }
  assert.throws(() => getFundingQuote({ direction: 'receive', symbol: 'DOGE' as AssetSymbol, units: 10 }), /지원하는/);
  assert.throws(() => getFundingQuote({ direction: 'withdraw', symbol: 'DOGE' as AssetSymbol, amount: 1_000 }), /지원하는/);
});

test('코인 입출금 견적은 실제 시간 30초 경계를 따르며 만료·미래·잘못된 시각이면 원자적으로 실패한다', () => {
  const initial = applyAction(createInitialState(NOW), { type: 'ADVANCE_DAY' }, NOW);
  const snapshot = structuredClone(initial);
  const actions: Extract<Action, { type: 'RECEIVE_ASSET' | 'WITHDRAW_CRYPTO' }>[] = [
    { type: 'RECEIVE_ASSET', symbol: 'USDC', units: 10, quotedAt: NOW },
    { type: 'WITHDRAW_CRYPTO', symbol: 'USDC', amount: 14_000, quotedAt: NOW },
  ];
  for (const action of actions) {
    assert.doesNotThrow(() => applyAction(initial, action, NOW + 30_000), '데모 하루 진행과 무관하게 실제 30초까지 유효하다');
    assert.throws(() => applyAction(initial, action, NOW + 30_001), /견적이 만료/);
    assert.throws(() => applyAction(initial, { ...action, quotedAt: NOW + 1 }, NOW), /견적이 만료/);
    for (const quotedAt of [NaN, Infinity, -1]) assert.throws(() => applyAction(initial, { ...action, quotedAt }, NOW), /견적이 만료/);
    assert.deepEqual(initial, snapshot, '실패한 견적은 시뮬레이션 시계·적립액·잔액도 변경하지 않는다');
  }
  assert.doesNotThrow(() => assertFundingQuoteFresh(NOW, NOW + 30_000));
  assert.throws(() => assertFundingQuoteFresh(NOW, NOW + 30_001));
});

test('원화 안전 정수 범위를 넘기는 코인 입금은 보상 적립과 거래 기록까지 원자적으로 취소한다', () => {
  const initial = createInitialState(NOW);
  initial.spend = Number.MAX_SAFE_INTEGER - 10;
  const snapshot = structuredClone(initial);
  assert.throws(() => applyAction(initial, { type: 'RECEIVE_ASSET', symbol: 'USDC', units: 10, quotedAt: NOW + 5_000 }, NOW + 5_000), /금액 범위/);
  assert.deepEqual(initial, snapshot);
  assert.equal(initial.transactions.length, 0);
  assert.equal(initial.accrued, 0);
});

test('자동 전환된 원화의 Reserve 지정·해제에는 추가 매도나 전환 수수료가 없다', () => {
  const initial = createInitialState(NOW);
  let state = applyAction(initial, { type: 'RECEIVE_ASSET', symbol: 'USDC', units: 10, quotedAt: NOW }, NOW);
  const assets = portfolioValue(state);
  state = applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'in', amount: 10_000 }, NOW);
  assert.equal(state.spend, 132_500);
  assert.equal(state.reserve, 1_260_000);
  assert.equal(portfolioValue(state), assets);
  state = applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'out', amount: 10_000 }, NOW);
  assert.equal(state.spend, 142_500);
  assert.equal(state.reserve, initial.reserve);
  assert.deepEqual(state.holdings, initial.holdings);
  assert.equal(portfolioValue(state), assets);
  assert.equal(state.transactions.filter((item) => item.kind === 'convert').length, 0);
});

test('입금 대기·확인·전환이 끝난 뒤에만 순 원화를 한 번 반영하고 같은 거래 행을 갱신한다', () => {
  const initial = createInitialState(NOW);
  let state = applyAction(initial, depositRequest(), NOW);
  const id = state.fundingOperations[0].id;
  const txId = state.transactions[0].id;
  assert.equal(state.fundingOperations[0].status, 'awaiting_deposit');
  assert.equal(state.fundingOperations[0].stageDueAt, null);
  assert.equal(state.spend, initial.spend);
  assert.equal(state.transactions[0].amount, 14_000);
  assert.equal(state.transactions[0].status, 'pending');
  state = applyAction(state, { type: 'SIMULATE_FUNDING_DEPOSIT', id }, NOW);
  state = applyAction(state, { type: 'SIMULATE_FUNDING_DEPOSIT', id }, NOW + 1_000);
  assert.equal(state.fundingOperations[0].stageDueAt, NOW + 3_000);
  state = applyAction(state, { type: 'TICK' }, NOW + 2_999);
  assert.equal(state.fundingOperations[0].status, 'confirming');
  state = applyAction(state, { type: 'TICK' }, NOW + 3_000);
  assert.equal(state.fundingOperations[0].status, 'converting');
  assert.equal(state.spend, initial.spend);
  state = applyAction(state, { type: 'TICK' }, NOW + 6_000);
  assert.equal(state.fundingOperations[0].status, 'completed');
  assert.equal(state.spend, initial.spend + 14_000);
  assert.deepEqual(state.holdings, initial.holdings);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].id, txId);
  assert.equal(state.transactions[0].status, 'completed');
  state = applyAction(state, { type: 'TICK' }, NOW + 20_000);
  state = applyAction(state, { type: 'SIMULATE_FUNDING_DEPOSIT', id }, NOW + 20_000);
  assert.equal(state.spend, initial.spend + 14_000);
  assert.equal(state.transactions.length, 1);
});

test('출금 보류 원금은 카드 사용 가능액에서 빠지지만 완료 전까지 총 자산에 포함된다', () => {
  const initial = createInitialState(NOW);
  let state = applyAction(initial, withdrawalRequest(), NOW);
  assert.equal(state.spend, 114_500);
  assert.equal(state.fundingOperations[0].status, 'reviewing');
  assert.equal(state.fundingOperations[0].feeWon, 70);
  assert.equal(state.fundingOperations[0].networkFeeWon, 140);
  assert.equal(state.fundingOperations[0].netWon, 13_790);
  assert.equal(state.fundingOperations[0].outputUnits, 9.85);
  assert.equal(getHeldFundingWon(state), 14_000);
  assert.equal(availableToSpend(state), availableToSpend(initial) - 14_000);
  assert.equal(portfolioValue(state), portfolioValue(initial));
  state = applyAction(state, { type: 'TICK' }, NOW + 3_000);
  assert.equal(state.fundingOperations[0].status, 'broadcasting');
  assert.equal(getHeldFundingWon(state), 14_000);
  assert.throws(() => applyAction(state, { type: 'CANCEL_FUNDING', id: state.fundingOperations[0].id }, NOW + 3_001), /취소할 수 없습니다/);
  state = applyAction(state, { type: 'TICK' }, NOW + 6_000);
  assert.equal(state.fundingOperations[0].status, 'completed');
  assert.equal(getHeldFundingWon(state), 0);
  assert.equal(portfolioValue(state), portfolioValue(initial) - 14_000);
  assert.equal(state.spend, 114_500);
  assert.equal(state.transactions.length, 1);
  state = applyAction(state, withdrawalRequest(), NOW + 90_000);
  assert.equal(state.spend, 114_500, '완료 요청의 재전송도 원금을 다시 보류하지 않는다');
  assert.equal(state.fundingOperations.length, 1);
  assert.equal(state.transactions.length, 1);
});

test('검토 중 취소는 예약 수수료까지 전액 복원하고 재취소·기한 진행에도 중복 복원하지 않는다', () => {
  const initial = createInitialState(NOW);
  let state = applyAction(initial, withdrawalRequest(), NOW);
  const id = state.fundingOperations[0].id;
  state = applyAction(state, { type: 'CANCEL_FUNDING', id }, NOW + 2_999);
  assert.equal(state.spend, initial.spend);
  assert.equal(state.fundingOperations[0].status, 'cancelled');
  assert.equal(state.fundingOperations[0].stageDueAt, null);
  assert.equal(state.transactions[0].status, 'cancelled');
  state = applyAction(state, { type: 'CANCEL_FUNDING', id }, NOW + 10_000);
  assert.equal(state.spend, initial.spend);
  assert.equal(state.transactions.length, 1);
  assert.equal(getHeldFundingWon(state), 0);
  const pending = applyAction(initial, withdrawalRequest(), NOW);
  assert.throws(() => applyAction(pending, { type: 'CANCEL_FUNDING', id: pending.fundingOperations[0].id }, NOW + 3_000), /취소할 수 없습니다/);
});

test('출금 실패는 송신 전에 원금 전체를 복원하고 재시도는 새 요청·새 견적의 별도 기록이다', () => {
  const initial = createInitialState(NOW);
  const failedRequest = withdrawalRequest({ simulation: 'failure' });
  let state = applyAction(initial, failedRequest, NOW);
  const originalId = state.fundingOperations[0].id;
  state = applyAction(state, { type: 'TICK' }, NOW + 3_000);
  assert.equal(state.fundingOperations[0].status, 'failed');
  assert.equal(state.spend, initial.spend);
  assert.match(state.fundingOperations[0].failureReason!, /모두 복원/);
  assert.equal(state.transactions[0].status, 'failed');
  state = applyAction(state, failedRequest, NOW + 40_000);
  assert.equal(state.spend, initial.spend, '동일 요청 재전송은 실패 요청을 다시 활성화하지 않는다');
  assert.equal(state.fundingOperations.length, 1);
  assert.throws(() => applyAction(state, withdrawalRequest({ requestId: 'retry-expired', retryOf: originalId }), NOW + 40_000), /견적이 만료/);
  state = applyAction(state, withdrawalRequest({ requestId: 'retry-new', retryOf: originalId, quotedAt: NOW + 40_000 }), NOW + 40_000);
  assert.equal(state.fundingOperations.length, 2);
  assert.equal(state.fundingOperations[1].status, 'failed');
  assert.equal(state.fundingOperations[0].retryOf, originalId);
  assert.equal(state.spend, initial.spend - 14_000);
  state = applyAction(state, { type: 'TICK' }, NOW + 46_000);
  assert.equal(state.fundingOperations[0].status, 'completed');
  assert.equal(state.spend, initial.spend - 14_000);
  assert.equal(state.transactions.length, 2);
});

test('입금 실패와 대기 취소는 아직 반영하지 않은 자산을 새로 지급하거나 환급하지 않는다', () => {
  const initial = createInitialState(NOW);
  let failed = applyAction(initial, depositRequest({ simulation: 'failure' }), NOW);
  failed = applyAction(failed, { type: 'SIMULATE_FUNDING_DEPOSIT', id: failed.fundingOperations[0].id }, NOW);
  failed = applyAction(failed, { type: 'TICK' }, NOW + 6_000);
  assert.equal(failed.fundingOperations[0].status, 'failed');
  assert.equal(failed.spend, initial.spend);
  assert.equal(failed.transactions[0].status, 'failed');
  let cancelled = applyAction(initial, depositRequest(), NOW);
  const id = cancelled.fundingOperations[0].id;
  cancelled = applyAction(cancelled, { type: 'CANCEL_FUNDING', id }, NOW);
  cancelled = applyAction(cancelled, { type: 'SIMULATE_FUNDING_DEPOSIT', id }, NOW + 8_000);
  assert.equal(cancelled.fundingOperations[0].status, 'cancelled');
  assert.equal(cancelled.spend, initial.spend);
  assert.deepEqual(cancelled.holdings, initial.holdings);
});

test('같은 요청 키의 재전송은 동일 효과만 유지하고 내용 변경·잘못된 입력은 원자적으로 거절한다', () => {
  const initial = createInitialState(NOW);
  const request = withdrawalRequest();
  const started = applyAction(initial, request, NOW);
  assert.deepEqual(applyAction(started, request, NOW), started);
  for (const change of [{ amount: 15_000 }, { recipient: '다른 지갑' }, { simulation: 'failure' as const }]) {
    assert.throws(() => applyAction(started, { ...request, ...change }, NOW), /같은 요청 번호/);
    assert.equal(started.spend, initial.spend - 14_000);
    assert.equal(started.fundingOperations.length, 1);
  }
  for (const change of [{ address: '0x' + '0'.repeat(40) }, { recipient: '' }, { quotedAt: NaN }, { requestId: '' }, { amount: Infinity }]) {
    assert.throws(() => applyAction(initial, { ...request, ...change }, NOW));
    assert.equal(initial.spend, 128_500);
    assert.equal(initial.fundingOperations.length, 0);
  }
  assert.throws(() => applyAction(initial, withdrawalRequest({ source: 'holdings', amount: undefined, units: 101 }), NOW), /보유 코인 잔액/);
  assert.throws(() => applyAction(initial, depositRequest({ units: undefined }), NOW), /수량/);
});

test('원물 출금은 높은 소수 정밀도와 원 미만 평가액을 보류 중에도 유지하고 취소 시 원래 수량으로 복원한다', () => {
  const initial = createInitialState(NOW);
  const units = 1.234567891234567;
  let state = applyAction(initial, withdrawalRequest({ source: 'holdings', amount: undefined, units }), NOW);
  assert.equal(state.spend, initial.spend);
  assert.equal(state.fundingOperations[0].feeWon, 0);
  assert.equal(state.fundingOperations[0].networkFeeWon, 140);
  close(portfolioValue(state), portfolioValue(initial));
  assert.ok(state.holdings.USDC < initial.holdings.USDC);
  state = applyAction(state, { type: 'CANCEL_FUNDING', id: state.fundingOperations[0].id }, NOW + 1_000);
  assert.deepEqual(state.holdings, initial.holdings);
  close(portfolioValue(state), portfolioValue(initial));
  assert.equal(state.spend, initial.spend);
});

test('높은 정밀도의 원물 출금 실패는 원래 코인 수량과 예약 네트워크 비용 전체를 한 번 복원한다', () => {
  const initial = createInitialState(NOW);
  let state = applyAction(initial, withdrawalRequest({ source: 'holdings', symbol: 'ETH', network: 'ethereum', amount: undefined,
    units: 0.01000000000001234, address: 'aqua-preview:ethereum:eth', simulation: 'failure' }), NOW);
  assert.equal(state.fundingOperations[0].feeWon, 0);
  assert.equal(state.fundingOperations[0].networkFeeWon, 2_000);
  assert.ok(state.holdings.ETH < initial.holdings.ETH);
  state = applyAction(state, { type: 'TICK' }, NOW + 3_000);
  assert.equal(state.fundingOperations[0].status, 'failed');
  assert.deepEqual(state.holdings, initial.holdings);
  assert.equal(state.spend, initial.spend);
  close(portfolioValue(state), portfolioValue(initial));
  state = applyAction(state, { type: 'TICK' }, NOW + 10_000);
  assert.deepEqual(state.holdings, initial.holdings);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].status, 'failed');
});

test('입출금 기한은 데모 1일 진행과 무관하게 실제 시간만 따르고 카드 결제는 보류 원금을 쓰지 못한다', () => {
  const initial = activeState();
  let state = applyAction(initial, withdrawalRequest({ amount: 120_000 }), NOW);
  state = applyAction(state, { type: 'ADVANCE_DAY' }, NOW);
  assert.equal(state.fundingOperations[0].status, 'reviewing');
  assert.equal(state.spend, 8_500);
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '카페', amount: 20_000 }, NOW), /잔액이 부족/);
  state = applyAction(state, { type: 'TICK' }, NOW + 3_000);
  assert.equal(state.fundingOperations[0].status, 'broadcasting');
  assert.equal(state.clockOffsetMs, DAY);
});

test('재로드는 저장 기한을 이어서 진행하고 완료 후 재로드·재전송으로 중복 입금하지 않는다', () => withFundingStorage(({ setTime }) => {
  let state = applyAction(createInitialState(NOW), depositRequest(), NOW);
  const id = state.fundingOperations[0].id;
  state = applyAction(state, { type: 'SIMULATE_FUNDING_DEPOSIT', id }, NOW);
  saveState(state);
  setTime(NOW + 3_500);
  state = loadState();
  assert.equal(state.fundingOperations[0].status, 'converting');
  assert.equal(state.fundingOperations[0].stageDueAt, NOW + 6_000);
  assert.equal(state.spend, 128_500);
  saveState(state);
  setTime(NOW + 10_000);
  state = loadState();
  assert.equal(state.fundingOperations[0].status, 'completed');
  assert.equal(state.spend, 142_500);
  saveState(state);
  setTime(NOW + 60_000);
  state = loadState();
  state = applyAction(state, depositRequest(), NOW + 60_000);
  assert.equal(state.spend, 142_500);
  assert.equal(state.fundingOperations.length, 1);
  assert.equal(state.transactions.length, 1);
}));

test('보류 출금 재로드는 전송 기한을 이어서 진행하고 원금을 재차 차감하거나 복원하지 않는다', () => withFundingStorage(({ setTime }) => {
  let state = applyAction(createInitialState(NOW), withdrawalRequest(), NOW);
  const id = state.fundingOperations[0].id;
  saveState(state);
  setTime(NOW + 3_500);
  state = loadState();
  assert.equal(state.fundingOperations[0].id, id);
  assert.equal(state.fundingOperations[0].status, 'broadcasting');
  assert.equal(state.fundingOperations[0].stageDueAt, NOW + 6_000);
  assert.equal(state.spend, 114_500);
  assert.equal(getHeldFundingWon(state), 14_000);
  saveState(state);
  setTime(NOW + 9_000);
  state = loadState();
  assert.equal(state.fundingOperations[0].status, 'completed');
  assert.equal(state.spend, 114_500);
  assert.equal(getHeldFundingWon(state), 0);
  saveState(state);
  state = loadState();
  assert.equal(state.spend, 114_500);
  assert.equal(state.transactions.length, 1);
}));

test('기존 v1 저장 데이터는 입출금 배열만 보충해 잔액과 카드·이용 내역을 보존한다', () => withFundingStorage(({ values }) => {
  const original = activeState();
  original.spend = 777_000;
  const legacy = { ...original } as Partial<AppState>;
  delete legacy.fundingOperations;
  values.set(STORAGE_KEY, JSON.stringify(legacy));
  const restored = loadState();
  assert.equal(restored.spend, 777_000);
  assert.equal(restored.reserve, original.reserve);
  assert.equal(restored.rewards, original.rewards);
  assert.deepEqual(restored.card, original.card);
  assert.deepEqual(restored.holdings, original.holdings);
  assert.deepEqual(restored.payments, original.payments);
  assert.deepEqual(restored.fundingOperations, []);
}));

test('모순된 저장 견적과 중복 요청 기록을 거절해 잘못된 기한 입금 효과를 실행하지 않는다', () => withFundingStorage(({ values, setTime }) => {
  let original = applyAction(createInitialState(NOW), depositRequest(), NOW);
  original = applyAction(original, { type: 'SIMULATE_FUNDING_DEPOSIT', id: original.fundingOperations[0].id }, NOW);
  const corrupted = structuredClone(original);
  corrupted.fundingOperations[0].amountWon = 1_000_000;
  corrupted.fundingOperations[0].netWon = 999_930;
  corrupted.transactions[0].amount = 999_930;
  values.set(STORAGE_KEY, JSON.stringify(corrupted));
  setTime(NOW + 10_000);
  assert.equal(loadState().spend, 128_500);
  const duplicate = structuredClone(original);
  duplicate.fundingOperations.push(structuredClone(duplicate.fundingOperations[0]));
  values.set(STORAGE_KEY, JSON.stringify(duplicate));
  assert.deepEqual(loadState().fundingOperations, []);
}));

test('완료 시 원화 범위 초과는 명시적인 입금 실패로 종결되어 TICK과 화면을 막지 않는다', () => {
  const initial = createInitialState(NOW);
  initial.spend = Number.MAX_SAFE_INTEGER;
  let state = applyAction(initial, depositRequest(), NOW);
  state = applyAction(state, { type: 'SIMULATE_FUNDING_DEPOSIT', id: state.fundingOperations[0].id }, NOW);
  state = applyAction(state, { type: 'TICK' }, NOW + 6_000);
  assert.equal(state.spend, Number.MAX_SAFE_INTEGER);
  assert.equal(state.fundingOperations[0].status, 'failed');
  assert.equal(state.fundingOperations[0].stageDueAt, null);
  assert.match(state.fundingOperations[0].failureReason!, /금액 범위/);
  assert.equal(state.transactions[0].status, 'failed');
  assert.doesNotThrow(() => applyAction(state, { type: 'TICK' }, NOW + 10_000));
});

test('보류금 복원 공간과 요청 번호 범위를 지켜 오버플로 시에도 출금·취소는 원자적이다', () => {
  const initial = createInitialState(NOW);
  initial.spend = Number.MAX_SAFE_INTEGER;
  let state = applyAction(initial, withdrawalRequest(), NOW);
  assert.throws(() => applyAction(state, { type: 'DEPOSIT', bucket: 'spend', amount: 1_000 }, NOW), /금액 범위/);
  state = applyAction(state, { type: 'CANCEL_FUNDING', id: state.fundingOperations[0].id }, NOW);
  assert.equal(state.spend, Number.MAX_SAFE_INTEGER);
  const exhausted = createInitialState(NOW);
  exhausted.sequence = Number.MAX_SAFE_INTEGER;
  const snapshot = structuredClone(exhausted);
  assert.throws(() => applyAction(exhausted, withdrawalRequest(), NOW), /금액 범위/);
  assert.deepEqual(exhausted, snapshot);
});

test('전환 모달과 원장 모두 소수 평가액을 먼저 절사하고 보유 코인 전환에는 수수료를 받지 않는다', () => {
  const units = 1_001.9 / 1_400;
  const quote = getFundingQuote({ direction: 'receive', symbol: 'USDC', units });
  assert.equal(quote.grossWon, 1_001);
  assert.equal(quote.feeWon, 0);
  assert.equal(quote.netWon, 1_001);
  const state = applyAction(createInitialState(NOW), { type: 'CONVERT', symbol: 'USDC', units, quotedAt: NOW }, NOW);
  assert.equal(state.spend, 128_500 + quote.netWon);
  assert.match(state.transactions[0].note, /수수료가 없습니다/);
});

test('카드 신청은 단계별로 진행하며 본인 확인·발급·실물 수령 전 활성화를 거절한다', () => {
  const initial = createInitialState(NOW);
  assert.throws(() => applyAction(initial, { type: 'SET_CARD', card: { ...initial.card, stage: 'active' } }, NOW), /순서/);
  let state = applyAction(initial, { type: 'SET_CARD', card: { ...initial.card, stage: 'identity' } }, NOW);
  assert.throws(() => applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage: 'plan' } }, NOW), /본인/);
  const steps: CardState['stage'][] = ['plan', 'details', 'review', 'submitted', 'approved', 'issued', 'active'];
  for (const stage of steps) {
    state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage, identityVerified: true,
      submittedAt: NOW, issuedAt: ['issued', 'active'].includes(stage) ? NOW : null } }, NOW);
  }
  assert.equal(state.card.stage, 'active');
  assert.equal(state.spend, initial.spend, '데모 발급 비용과 월 구독료는 실제로 차감하지 않는다');
  assert.throws(() => applyAction(state, { type: 'SET_CARD', card: { ...state.card, physical: true, physicalActive: true, delivery: 'shipped' } }, NOW), /수령/);
});

test('심사 보완 재본인확인에서는 접수번호와 자금을 유지하고 재제출할 수 있다', () => {
  let state = createInitialState(NOW);
  state.card = { ...state.card, stage: 'submitted', identityVerified: true, reference: 'AQ-DEMO-1234', submittedAt: NOW };
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage: 'needs_info' } }, NOW);
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage: 'identity', identityVerified: false } }, NOW);
  assert.equal(state.card.reference, 'AQ-DEMO-1234');
  assert.equal(state.spend, 128_500);
  for (const stage of ['plan', 'details', 'review', 'submitted'] as const) {
    state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage, identityVerified: true } }, NOW);
  }
  assert.equal(state.card.stage, 'submitted');
  assert.equal(state.card.reference, 'AQ-DEMO-1234');
});

test('로컬 저장은 유효한 상태를 복원하고 손상·음수·알 수 없는 스키마는 초기화한다', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    const valid = createInitialState(Date.now());
    valid.spend = 777_000;
    saveState(valid);
    assert.equal(loadState().spend, 777_000);
    values.set(STORAGE_KEY, JSON.stringify({ ...valid, spend: -1 }));
    assert.equal(loadState().spend, 128_500);
    values.set(STORAGE_KEY, JSON.stringify({ ...valid, holdings: { ...valid.holdings, BTC: 'NaN' } }));
    assert.equal(loadState().holdings.BTC, 0.0012);
    values.set(STORAGE_KEY, '{corrupted');
    assert.equal(loadState().version, 1);
    values.set(STORAGE_KEY, JSON.stringify({ ...valid, version: 99 }));
    assert.equal(loadState().version, 1);
    values.set(STORAGE_KEY, JSON.stringify({ ...valid, card: { ...valid.card, stage: 'other' } }));
    assert.equal(loadState().card.stage, 'not_applied');
    values.set(STORAGE_KEY, JSON.stringify({ ...valid, reserveRate: null }));
    assert.equal(loadState().reserveRate, 0.05);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('저장소 접근이 차단되어도 세션과 초기 상태는 사용할 수 있다', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  try {
    assert.equal(loadState().spend, 128_500);
    assert.doesNotThrow(() => saveState(createInitialState(NOW)));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('원화 스테이블 입금은 확인이 끝나면 같은 금액을 결제 잔액에 더하고 보유 코인은 바꾸지 않는다', () => withFundingStorage(({ setTime }) => {
  const initial = createInitialState(NOW);
  let state = applyAction(initial, depositRequest({ requestId: 'krws-in', symbol: 'KRWS', units: 50_000 }), NOW);
  assert.equal(state.transactions[0].title, '원화 스테이블 입금');
  assert.equal(state.transactions[0].amount, 50_000);
  const id = state.fundingOperations[0].id;
  state = applyAction(state, { type: 'SIMULATE_FUNDING_DEPOSIT', id }, NOW);
  state = applyAction(state, { type: 'TICK' }, NOW + 6_000);
  assert.equal(state.fundingOperations[0].status, 'completed');
  assert.equal(state.spend, initial.spend + 50_000);
  assert.deepEqual(state.holdings, initial.holdings);
  state = applyAction(state, withdrawalRequest({ requestId: 'krws-out', symbol: 'KRWS', amount: 20_000, address: 'aqua-preview:polygon:krws' }), NOW + 7_000);
  assert.equal(state.fundingOperations[0].feeWon, 0);
  assert.equal(state.fundingOperations[0].outputUnits, 19_860);
  saveState(state);
  setTime(NOW + 7_500);
  const restored = loadState();
  assert.equal(restored.fundingOperations.length, 2, '원화 스테이블 입출금 기록도 저장 후 다시 불러온다');
  assert.equal(restored.spend, initial.spend + 30_000);
}));

const HASH = 'a'.repeat(64);
const signup = {
  type: 'COMPLETE_SIGNUP', email: ' Tester@Aqua.Example ', passwordHash: HASH, name: '아쿠아 사용자', birthDate: '1995-04-12',
  phone: '01012345678', kyc: { idType: 'resident', occupation: '회사원', purpose: '카드 결제', source: '근로소득' },
} as const satisfies Action;

test('가입은 이메일·비밀번호·휴대폰·만 19세 이상·고객확인 답변을 확인한 뒤 한 번만 완료한다', () => withFundingStorage(({ values }) => {
  const initial = createInitialState(NOW);
  assert.equal(initial.account, null);
  assert.equal(initial.signedIn, false);
  const state = applyAction(initial, signup, NOW);
  assert.equal(state.account?.email, 'tester@aqua.example');
  assert.equal(state.account?.kyc.purpose, '카드 결제');
  assert.equal(state.account?.verifiedAt, NOW);
  assert.equal(state.signedIn, true);
  assert.equal(state.spend, initial.spend);
  assert.throws(() => applyAction(state, signup, NOW), /이미 가입/);
  assert.throws(() => applyAction(initial, { ...signup, email: 'not-an-email' }, NOW), /이메일/);
  assert.throws(() => applyAction(initial, { ...signup, passwordHash: 'plain-password' }, NOW), /비밀번호/);
  assert.throws(() => applyAction(initial, { ...signup, phone: '0212345678' }, NOW), /휴대폰/);
  assert.throws(() => applyAction(initial, { ...signup, name: '김' }, NOW), /이름/);
  assert.throws(() => applyAction(initial, { ...signup, birthDate: '2009-02-30' }, NOW), /생년월일/);
  assert.throws(() => applyAction(initial, { ...signup, birthDate: '2010-01-01' }, NOW), /만 19세/);
  assert.throws(() => applyAction(initial, { ...signup, kyc: { ...signup.kyc, source: '' } }, NOW), /고객확인/);
  saveState(state);
  assert.deepEqual(loadState().account, state.account);
  const legacy = { ...initial } as Partial<AppState>;
  delete legacy.account;
  delete legacy.signedIn;
  values.set(STORAGE_KEY, JSON.stringify(legacy));
  const restored = loadState();
  assert.equal(restored.account, null, '가입 기록이 없던 저장 데이터는 가입부터 다시 진행한다');
  assert.equal(restored.signedIn, false);
}));

test('로그아웃 뒤에는 같은 이메일과 비밀번호로만 로그인하고 비밀번호를 바꾸면 다시 로그인한다', () => {
  let state = applyAction(createInitialState(NOW), signup, NOW);
  state = applyAction(state, { type: 'SIGN_OUT' }, NOW);
  assert.equal(state.signedIn, false);
  assert.throws(() => applyAction(state, { type: 'SIGN_IN', email: 'other@aqua.example', passwordHash: HASH }, NOW), /가입한 이메일/);
  assert.throws(() => applyAction(state, { type: 'SIGN_IN', email: 'tester@aqua.example', passwordHash: 'b'.repeat(64) }, NOW), /비밀번호가 맞지/);
  state = applyAction(state, { type: 'SIGN_IN', email: 'TESTER@aqua.example', passwordHash: HASH }, NOW);
  assert.equal(state.signedIn, true);
  state = applyAction(state, { type: 'RESET_PASSWORD', email: 'tester@aqua.example', passwordHash: 'c'.repeat(64) }, NOW);
  assert.equal(state.signedIn, false);
  assert.throws(() => applyAction(state, { type: 'SIGN_IN', email: 'tester@aqua.example', passwordHash: HASH }, NOW), /비밀번호가 맞지/);
  assert.equal(applyAction(state, { type: 'SIGN_IN', email: 'tester@aqua.example', passwordHash: 'c'.repeat(64) }, NOW).signedIn, true);
});
