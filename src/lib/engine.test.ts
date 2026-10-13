import test from 'node:test';
import assert from 'node:assert/strict';
import { accountClosureBlockers, applyAction, availableToSpend, createInitialState, loadState, portfolioValue, saveState, STORAGE_KEY } from './engine';
import { assertFundingQuoteFresh, getFundingQuote } from './funding';
import { getFundingNetworks, getHeldFundingWon } from './movements';
import type { Action, AppState, AssetSymbol, CardState } from './types';

const NOW = Date.UTC(2026, 9, 13, 3);
const SAMPLE_ADDRESS = { zip: '04500', road: '서울특별시 중구 아쿠아로 1', detail: '101호' };
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
function completeDeposit(state: AppState, overrides: Partial<StartFunding> = {}): AppState {
  const started = applyAction(state, depositRequest(overrides), NOW);
  const arrived = applyAction(started, { type: 'SIMULATE_FUNDING_DEPOSIT', id: started.fundingOperations[0].id }, NOW);
  return applyAction(arrived, { type: 'TICK' }, NOW + 6_000);
}
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
  assert.equal(portfolioValue(state), 1_378_500);
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
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '카페', amount: 200_000 }, NOW), /리저브 자동/);
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

test('리저브 이동과 보상률 변경 시 이전 잔액·보상률로 먼저 적립한다', () => {
  let state = createInitialState(NOW);
  state.spend = 1_250_000;
  state = applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'in', amount: 1_250_000 }, NOW + DAY);
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
  assert.throws(() => applyAction(state, withdrawalRequest({ amount: state.spend + 1 }), NOW), /부족/);
  assert.throws(() => applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'out', amount: state.reserve + 1 }, NOW), /부족/);
  state = applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'out', amount: 10_000 }, NOW);
  state = applyAction(state, withdrawalRequest({ amount: 10_000 }), NOW);
  assert.equal(state.reserve, 1_240_000);
  assert.equal(state.spend, 128_500);
  assert.equal(state.rewards, 4_280);
  assert.throws(() => applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'in', amount: 999 }, NOW), /1,000/);
  assert.throws(() => applyAction(state, withdrawalRequest({ requestId: 'too-small', amount: 999 }), NOW), /1,000/);
});

test('외부 코인 입금은 수수료 없이 원화 결제 잔액으로 자동 전환하고 코인으로 보관하지 않는다', () => {
  const initial = createInitialState(NOW);
  const snapshot = structuredClone(initial);
  const quote = getFundingQuote({ direction: 'receive', symbol: 'USDC', units: 10 });
  assert.deepEqual(quote, { direction: 'receive', symbol: 'USDC', price: 1_400, inputUnits: 10,
    grossWon: 14_000, feeWon: 0, netWon: 14_000, outputUnits: 0 });
  const funded = completeDeposit(initial);
  assert.equal(funded.fundingOperations[0].status, 'completed');
  assert.equal(funded.spend, 142_500);
  assert.equal(funded.reserve, initial.reserve);
  assert.equal(funded.rewards, initial.rewards);
  assert.ok(!('holdings' in funded), '입금한 코인을 따로 보관하지 않는다');
  assert.equal(portfolioValue(funded), portfolioValue(initial) + 14_000);
  assert.equal(funded.transactions[0].kind, 'deposit');
  assert.equal(funded.transactions[0].amount, 14_000);
  assert.match(funded.transactions[0].note, /전환 수수료 0원 · 네트워크 비용 0원/);
  assert.deepEqual(initial, snapshot);
});

test('원화 결제 잔액을 코인으로 출금하며 수수료를 제외한 수령 예상량만 계산한다', () => {
  const initial = createInitialState(NOW);
  const snapshot = structuredClone(initial);
  const quote = getFundingQuote({ direction: 'withdraw', symbol: 'USDT', amount: 14_000 });
  assert.deepEqual(quote, { direction: 'withdraw', symbol: 'USDT', price: 1_400, inputUnits: 0,
    grossWon: 14_000, feeWon: 70, netWon: 13_930, outputUnits: 9.95 });
  let withdrawn = applyAction(initial, withdrawalRequest({ symbol: 'USDT', network: 'ethereum', address: 'aqua-preview:ethereum:usdt' }), NOW);
  const { feeWon, networkFeeWon, netWon, outputUnits } = withdrawn.fundingOperations[0];
  assert.deepEqual({ feeWon, networkFeeWon, netWon, outputUnits }, { feeWon: 70, networkFeeWon: 2_800, netWon: 11_130, outputUnits: 7.95 });
  assert.equal(withdrawn.spend, 114_500);
  assert.equal(withdrawn.reserve, initial.reserve);
  assert.equal(withdrawn.rewards, initial.rewards);
  assert.equal(withdrawn.transactions[0].amount, -14_000);
  assert.match(withdrawn.transactions[0].note, /예상 7\.95 USDT/);
  assert.match(withdrawn.transactions[0].note, /실제 외부 송금은 실행하지 않습니다/);
  withdrawn = applyAction(withdrawn, { type: 'TICK' }, NOW + 6_000);
  assert.equal(withdrawn.fundingOperations[0].status, 'completed');
  assert.equal(portfolioValue(withdrawn), portfolioValue(initial) - 14_000);
  assert.deepEqual(initial, snapshot);
});

test('출금은 결제 잔액까지만 허용하고 리워드·Reserve 자동 사용으로 부족분을 충당하지 않는다', () => {
  const initial = createInitialState(NOW);
  const withdrawn = applyAction(initial, withdrawalRequest({ symbol: 'BTC', network: 'bitcoin', amount: initial.spend, address: 'aqua-preview:bitcoin:btc' }), NOW);
  assert.equal(withdrawn.spend, 0);
  assert.equal(withdrawn.rewards, 4_280);
  assert.equal(withdrawn.reserve, 1_250_000);
  const insufficient = { ...initial, spend: 999, reserveAuto: true, rewardsAuto: true };
  const snapshot = structuredClone(insufficient);
  assert.ok(availableToSpend(insufficient) > 1_000);
  assert.throws(() => applyAction(insufficient, withdrawalRequest({ amount: 1_000 }), NOW), /결제 잔액이 부족/);
  assert.deepEqual(insufficient, snapshot, '출금 실패는 원금·리워드·거래 내역을 변경하지 않는다');
});

test('입금 평가액은 십진수로 계산해 원 미만을 절사하고 출금 전환 수수료만 원 단위로 올림한다', () => {
  const cases: [AssetSymbol, number, number, number, number][] = [
    ['USDC', 1.005, 1_407, 0, 1_407],
    ['BTC', 0.00000822, 1_233, 0, 1_233],
    ['ETH', 0.000251, 1_004, 0, 1_004],
    ['USDC', 1.001, 1_401, 0, 1_401],
    ['USDC', 1_001.9 / 1_400, 1_001, 0, 1_001],
  ];
  for (const [symbol, units, grossWon, feeWon, netWon] of cases) {
    const quote = getFundingQuote({ direction: 'receive', symbol, units });
    assert.equal(quote.grossWon, grossWon);
    assert.equal(quote.feeWon, feeWon);
    assert.equal(quote.netWon, netWon);
    assert.equal(grossWon, feeWon + netWon);
    assert.ok([grossWon, feeWon, netWon].every(Number.isSafeInteger));
    const funded = completeDeposit(createInitialState(NOW), { symbol, network: getFundingNetworks(symbol)[0].id, units });
    assert.equal(funded.spend, 128_500 + netWon, '화면 견적과 같은 절사 금액만 결제 잔액에 더한다');
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
    assert.throws(() => applyAction(initial, depositRequest({ units }), NOW));
    assert.deepEqual(initial, snapshot);
  }
  for (const amount of [0, -1, 999, 1_000.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => applyAction(initial, withdrawalRequest({ amount }), NOW));
    assert.deepEqual(initial, snapshot);
  }
  assert.throws(() => getFundingQuote({ direction: 'receive', symbol: 'DOGE' as AssetSymbol, units: 10 }), /지원하는/);
  assert.throws(() => getFundingQuote({ direction: 'withdraw', symbol: 'DOGE' as AssetSymbol, amount: 1_000 }), /지원하는/);
  assert.throws(() => applyAction(initial, depositRequest({ symbol: 'DOGE' as AssetSymbol }), NOW), /지원하는/);
});

test('코인 입출금 견적은 실제 시간 30초 경계를 따르며 만료·미래·잘못된 시각이면 원자적으로 실패한다', () => {
  const initial = applyAction(createInitialState(NOW), { type: 'ADVANCE_DAY' }, NOW);
  const snapshot = structuredClone(initial);
  for (const request of [depositRequest(), withdrawalRequest()]) {
    assert.doesNotThrow(() => applyAction(initial, request, NOW + 30_000), '데모 하루 진행과 무관하게 실제 30초까지 유효하다');
    assert.throws(() => applyAction(initial, request, NOW + 30_001), /견적이 만료/);
    assert.throws(() => applyAction(initial, { ...request, quotedAt: NOW + 1 }, NOW), /견적 시각/);
    for (const quotedAt of [NaN, Infinity, -1]) assert.throws(() => applyAction(initial, { ...request, quotedAt }, NOW), /견적 시각/);
    assert.deepEqual(initial, snapshot, '실패한 견적은 시뮬레이션 시계·적립액·잔액도 변경하지 않는다');
  }
  assert.doesNotThrow(() => assertFundingQuoteFresh(NOW, NOW + 30_000));
  assert.throws(() => assertFundingQuoteFresh(NOW, NOW + 30_001));
});

test('원화 안전 정수 범위를 넘기는 코인 입금은 보상 적립과 거래 기록까지 원자적으로 취소한다', () => {
  const initial = createInitialState(NOW);
  const snapshot = structuredClone(initial);
  assert.throws(() => applyAction(initial, depositRequest({ units: 1e13, quotedAt: NOW + 5_000 }), NOW + 5_000), /금액 범위/);
  assert.deepEqual(initial, snapshot);
  assert.equal(initial.transactions.length, 0);
  assert.equal(initial.fundingOperations.length, 0);
  assert.equal(initial.accrued, 0);
});

test('자동 전환된 원화의 Reserve 지정·해제에는 추가 매도나 전환 수수료가 없다', () => {
  const initial = createInitialState(NOW);
  let state = completeDeposit(initial);
  const assets = portfolioValue(state);
  state = applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'in', amount: 10_000 }, NOW + 6_000);
  assert.equal(state.spend, 132_500);
  assert.equal(state.reserve, 1_260_000);
  assert.equal(portfolioValue(state), assets);
  state = applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'out', amount: 10_000 }, NOW + 6_000);
  assert.equal(state.spend, 142_500);
  assert.equal(state.reserve, initial.reserve);
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
  for (const request of [depositRequest(), withdrawalRequest()]) {
    assert.throws(() => applyAction(initial, { ...request, source: 'holdings' as 'spend' }, NOW), /결제 잔액으로만/);
  }
  assert.throws(() => applyAction(initial, depositRequest({ units: undefined }), NOW), /수량/);
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
  assert.throws(() => applyAction(state, { type: 'TRANSFER_RESERVE', direction: 'out', amount: 1_000 }, NOW), /금액 범위/);
  state = applyAction(state, { type: 'CANCEL_FUNDING', id: state.fundingOperations[0].id }, NOW);
  assert.equal(state.spend, Number.MAX_SAFE_INTEGER);
  const exhausted = createInitialState(NOW);
  exhausted.sequence = Number.MAX_SAFE_INTEGER;
  const snapshot = structuredClone(exhausted);
  assert.throws(() => applyAction(exhausted, withdrawalRequest(), NOW), /금액 범위/);
  assert.deepEqual(exhausted, snapshot);
});

test('카드 신청은 단계별로 진행하며 본인 확인·발급·실물 수령 전 활성화를 거절한다', () => {
  const initial = createInitialState(NOW);
  assert.throws(() => applyAction(initial, { type: 'SET_CARD', card: { ...initial.card, stage: 'active' } }, NOW), /순서/);
  let state = applyAction(initial, { type: 'SET_CARD', card: { ...initial.card, stage: 'identity' } }, NOW);
  assert.throws(() => applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage: 'plan' } }, NOW), /본인/);
  for (const stage of ['plan', 'details', 'review'] as const) {
    state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage, identityVerified: true } }, NOW);
  }
  assert.throws(() => applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage: 'submitted' } }, NOW), /신청 확인/);
  state = applyAction(state, { type: 'SUBMIT_CARD' }, NOW);
  for (const stage of ['approved', 'issued', 'active'] as const) {
    state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage, issuedAt: ['issued', 'active'].includes(stage) ? NOW : null } }, NOW);
  }
  assert.equal(state.card.stage, 'active');
  assert.equal(state.spend, initial.spend, 'Basic 가상카드는 비용이 없다');
  assert.throws(() => applyAction(state, { type: 'SET_CARD', card: { ...state.card, physical: true } }, NOW), /카드 관리/);
  const physical = applyAction(state, { type: 'ADD_PHYSICAL_CARD', address: SAMPLE_ADDRESS }, NOW);
  assert.throws(() => applyAction(physical, { type: 'SET_CARD', card: { ...physical.card, physicalActive: true } }, NOW), /비밀번호/);
  const shipped = applyAction(physical, { type: 'SET_CARD', card: { ...physical.card, delivery: 'shipped' } }, NOW);
  assert.throws(() => applyAction(shipped, { type: 'ACTIVATE_PHYSICAL', pin: '2580' }, NOW), /수령/);
});

test('심사 보완 재본인확인에서는 접수번호와 자금을 유지하고 재제출할 수 있다', () => {
  let state = createInitialState(NOW);
  state.card = { ...state.card, stage: 'submitted', identityVerified: true, reference: 'AQ-DEMO-1234', submittedAt: NOW };
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage: 'needs_info' } }, NOW);
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage: 'identity', identityVerified: false } }, NOW);
  assert.equal(state.card.reference, 'AQ-DEMO-1234');
  assert.equal(state.spend, 128_500);
  for (const stage of ['plan', 'details', 'review'] as const) {
    state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage, identityVerified: true } }, NOW);
  }
  state = applyAction(state, { type: 'SUBMIT_CARD' }, NOW);
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

test('원화 스테이블 입금은 확인이 끝나면 같은 금액을 결제 잔액에 더하고 출금에는 전환 수수료가 없다', () => withFundingStorage(({ setTime }) => {
  const initial = createInitialState(NOW);
  let state = applyAction(initial, depositRequest({ requestId: 'krws-in', symbol: 'KRWS', units: 50_000 }), NOW);
  assert.equal(state.transactions[0].title, '원화 스테이블 입금');
  assert.equal(state.transactions[0].amount, 50_000);
  const id = state.fundingOperations[0].id;
  state = applyAction(state, { type: 'SIMULATE_FUNDING_DEPOSIT', id }, NOW);
  state = applyAction(state, { type: 'TICK' }, NOW + 6_000);
  assert.equal(state.fundingOperations[0].status, 'completed');
  assert.equal(state.spend, initial.spend + 50_000);
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

test('삼성페이·애플페이는 활성화하고 잠그지 않은 카드에만 추가하고 기존 저장 카드도 불러온다', () => withFundingStorage(({ values }) => {
  const pending = createInitialState(NOW);
  assert.throws(() => applyAction(pending, { type: 'SET_CARD', card: { ...pending.card, wallets: ['samsung'] } }, NOW), /활성화한 뒤/);
  let state = activeState();
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, wallets: ['samsung'] } }, NOW);
  assert.deepEqual(state.card.wallets, ['samsung']);
  const locked = applyAction(state, { type: 'SET_CARD', card: { ...state.card, locked: true } }, NOW);
  assert.throws(() => applyAction(locked, { type: 'SET_CARD', card: { ...locked.card, wallets: ['samsung', 'apple'] } }, NOW), /잠금을 해제/);
  assert.throws(() => applyAction(state, { type: 'SET_CARD', card: { ...state.card, wallets: ['samsung', 'samsung'] } }, NOW), /카드 정보/);
  const legacy = structuredClone(activeState()) as Partial<AppState>;
  delete (legacy.card as Partial<CardState>).wallets;
  values.set(STORAGE_KEY, JSON.stringify(legacy));
  assert.deepEqual(loadState().card.wallets, []);
}));

function reviewState(plan: CardState['plan'], physical: boolean): AppState {
  const state = createInitialState(NOW);
  state.card = { ...state.card, stage: 'review', identityVerified: true, plan, physical, address: physical ? SAMPLE_ADDRESS : null };
  return state;
}
function activate(state: AppState): AppState {
  let next = applyAction(state, { type: 'SUBMIT_CARD' }, NOW);
  for (const stage of ['approved', 'issued', 'active'] as const) {
    next = applyAction(next, { type: 'SET_CARD', card: { ...next.card, stage, issuedAt: NOW, delivery: next.card.physical ? 'preparing' : 'none' } }, NOW);
  }
  return next;
}

test('카드 신청 비용은 결제 잔액에서 내고 반려·보완 요청이면 돌려준다', () => {
  const short = reviewState('plus', true);
  short.spend = 10_000;
  assert.throws(() => applyAction(short, { type: 'SUBMIT_CARD' }, NOW), /4,800원 부족/);
  const submitted = applyAction(reviewState('plus', true), { type: 'SUBMIT_CARD' }, NOW);
  assert.equal(submitted.spend, 128_500 - 14_800);
  assert.equal(submitted.card.chargedFee, 14_800);
  assert.deepEqual([submitted.transactions[0].kind, submitted.transactions[0].amount], ['card', -14_800]);
  assert.match(submitted.transactions[0].note, /첫 달 이용료 4,900원 · 실물카드 발급비 9,900원/);
  const approved = applyAction(submitted, { type: 'SET_CARD', card: { ...submitted.card, stage: 'approved', chargedFee: 0 } }, NOW);
  assert.equal(approved.card.chargedFee, 14_800, '화면에서 보낸 값으로 비용 기록을 지우지 못한다');
  for (const stage of ['rejected', 'needs_info'] as const) {
    const returned = applyAction(submitted, { type: 'SET_CARD', card: { ...submitted.card, stage } }, NOW);
    assert.equal(returned.spend, 128_500);
    assert.equal(returned.card.chargedFee, 0);
    assert.deepEqual([returned.transactions[0].title, returned.transactions[0].amount], ['카드 신청 비용 환불', 14_800]);
  }
});

test('Plus는 발급한 날부터 한 달마다 결제 잔액에서 이용료를 내고 모자라면 Basic이 된다', () => {
  let state = activate(reviewState('plus', false));
  assert.equal(state.spend, 128_500 - 4_900);
  assert.equal(state.card.chargedFee, 0);
  assert.equal(state.card.billingAt, Date.UTC(2026, 10, 13, 3));
  state = applyAction(state, { type: 'ADVANCE_TO_BILLING' }, NOW);
  assert.equal(state.spend, 128_500 - 9_800);
  assert.equal(state.card.billingAt, Date.UTC(2026, 11, 13, 3));
  assert.ok(state.transactions.some((item) => item.title === 'Aqua Plus 이용료' && item.amount === -4_900));
  state.spend = 1_000;
  state = applyAction(state, { type: 'ADVANCE_TO_BILLING' }, NOW);
  assert.deepEqual([state.card.plan, state.card.billingAt, state.spend], ['basic', null, 1_000]);
  assert.match(state.transactions.find((item) => item.kind === 'card')!.note, /부족해/);
  assert.throws(() => applyAction(state, { type: 'ADVANCE_TO_BILLING' }, NOW), /결제일이 없습니다/);
});

test('Plus로는 바로 내고 바뀌고, Basic은 다음 결제일에 이용료 없이 바뀐다', () => {
  const short = activeState();
  short.spend = 3_000;
  assert.throws(() => applyAction(short, { type: 'CHANGE_PLAN', plan: 'plus' }, NOW), /1,900원 부족/);
  assert.throws(() => applyAction(activeState(), { type: 'SET_CARD', card: { ...activeState().card, plan: 'plus' } }, NOW), /카드 관리/);
  let state = applyAction(activeState(), { type: 'CHANGE_PLAN', plan: 'plus' }, NOW);
  assert.deepEqual([state.card.plan, state.spend, state.card.billingAt], ['plus', 123_600, Date.UTC(2026, 10, 13, 3)]);
  assert.throws(() => applyAction(state, { type: 'CHANGE_PLAN', plan: 'plus' }, NOW), /이미 Plus/);
  state = applyAction(state, { type: 'CHANGE_PLAN', plan: 'basic' }, NOW);
  assert.deepEqual([state.card.plan, state.card.nextPlan], ['plus', 'basic']);
  const kept = applyAction(state, { type: 'CHANGE_PLAN', plan: 'plus' }, NOW);
  assert.deepEqual([kept.card.nextPlan, kept.spend], [null, 123_600]);
  state = applyAction(state, { type: 'ADVANCE_TO_BILLING' }, NOW);
  assert.deepEqual([state.card.plan, state.card.nextPlan, state.card.billingAt, state.spend], ['basic', null, null, 123_600]);
});

test('실물카드 추가·분실 재발급·해지는 비용과 카드 상태를 함께 바꾸고 잔액은 남긴다', () => {
  let state = activeState();
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, wallets: ['samsung'] } }, NOW);
  const reissued = applyAction(state, { type: 'REISSUE_CARD' }, NOW);
  assert.notEqual(reissued.card.last4, state.card.last4);
  assert.match(reissued.card.last4, /^\d{4}$/);
  assert.deepEqual([reissued.card.wallets, reissued.spend], [[], state.spend]);
  state = applyAction(state, { type: 'ADD_PHYSICAL_CARD', address: SAMPLE_ADDRESS }, NOW);
  assert.deepEqual([state.spend, state.card.physical, state.card.delivery], [118_600, true, 'preparing']);
  assert.throws(() => applyAction(state, { type: 'ADD_PHYSICAL_CARD', address: SAMPLE_ADDRESS }, NOW), /이미/);
  state = applyAction(state, { type: 'REISSUE_CARD' }, NOW);
  assert.equal(state.spend, 108_700);
  const closed = applyAction(state, { type: 'CLOSE_CARD' }, NOW);
  assert.deepEqual([closed.card.stage, closed.card.physical, closed.card.wallets, closed.card.billingAt], ['not_applied', false, [], null]);
  assert.deepEqual([closed.spend, closed.reserve, closed.rewards], [state.spend, state.reserve, state.rewards]);
  assert.notEqual(closed.card.last4, state.card.last4, '다음 카드는 새 번호로 나온다');
  assert.throws(() => applyAction(closed, { type: 'PAY', merchant: '카페', amount: 1_000 }, NOW), /카드 신청/);
  assert.throws(() => applyAction(closed, { type: 'CLOSE_CARD' }, NOW), /사용 중인 카드/);
});

test('회원 탈퇴는 카드 해지와 잔액 정리를 마친 뒤 비밀번호를 확인하고 처음 상태로 돌린다', () => {
  let state = applyAction(activeState(), signup, NOW);
  assert.ok(accountClosureBlockers(state).includes('카드를 먼저 해지해 주세요.'));
  assert.throws(() => applyAction(state, { type: 'DELETE_ACCOUNT', passwordHash: HASH }, NOW), /카드를 먼저/);
  state = applyAction(state, { type: 'CLOSE_CARD' }, NOW);
  Object.assign(state, { spend: 0, reserve: 0 });
  assert.deepEqual(accountClosureBlockers(state), []);
  assert.throws(() => applyAction(state, { type: 'DELETE_ACCOUNT', passwordHash: 'b'.repeat(64) }, NOW), /비밀번호/);
  const deleted = applyAction(state, { type: 'DELETE_ACCOUNT', passwordHash: HASH }, NOW);
  assert.deepEqual([deleted.account, deleted.signedIn, deleted.transactions.length], [null, false, 0]);
});

test('카드 비용 항목이 없던 저장 데이터도 불러오고 Plus는 다음 결제일을 새로 잡는다', () => withFundingStorage(({ values }) => {
  const legacy = structuredClone(activeState()) as AppState;
  legacy.card.plan = 'plus';
  for (const key of ['chargedFee', 'billingAt', 'nextPlan'] as const) delete (legacy.card as Partial<CardState>)[key];
  values.set(STORAGE_KEY, JSON.stringify(legacy));
  const loaded = loadState();
  assert.equal(loaded.card.plan, 'plus');
  assert.equal(loaded.card.chargedFee, 0);
  assert.ok(loaded.card.billingAt !== null && loaded.card.billingAt > Date.now());
}));

test('이전 체험에 남은 보유 코인은 불러올 때 한 번만 원화로 바꿔 결제 잔액에 더하고 진행 중이던 코인 출금도 원화로 돌려준다', () => withFundingStorage(({ values }) => {
  const saved = applyAction(createInitialState(NOW), signup, NOW);
  values.set(STORAGE_KEY, JSON.stringify({ ...saved, holdings: { USDC: 100, USDT: 12.5, BTC: 0.001, ETH: 0.08 } }));
  const loaded = loadState();
  assert.equal(loaded.spend, saved.spend + 627_500);
  assert.equal(loaded.sequence, saved.sequence + 1);
  assert.deepEqual(loaded.transactions[0], { id: `tx-${saved.sequence + 1}`, kind: 'convert', title: '보유 코인 자동 전환', amount: 627_500,
    timestamp: saved.lastAccruedAt, status: 'completed', note: '이전 체험에서 남아 있던 코인을 원화 스테이블로 바꿔 결제 잔액에 더했습니다.' });
  assert.ok(!('holdings' in loaded));
  assert.equal(loaded.account?.email, 'tester@aqua.example');
  saveState(loaded);
  assert.equal(loadState().spend, loaded.spend, '다시 불러와도 두 번 전환하지 않는다');
  values.set(STORAGE_KEY, JSON.stringify({ ...saved, holdings: { USDC: 0, USDT: 0, BTC: 0, ETH: 0 } }));
  const empty = loadState();
  assert.deepEqual([empty.spend, empty.sequence, empty.transactions.length, 'holdings' in empty], [saved.spend, saved.sequence, 0, false]);
  const withdrawing = applyAction(saved, withdrawalRequest(), NOW);
  values.set(STORAGE_KEY, JSON.stringify(withdrawing));
  assert.equal(loadState().fundingOperations.length, 1, '결제 잔액 출금 기록은 그대로 불러온다');
  const legacy = structuredClone(withdrawing);
  legacy.fundingOperations[0].source = 'holdings' as 'spend';
  values.set(STORAGE_KEY, JSON.stringify({ ...legacy, holdings: { USDC: 100, USDT: 0, BTC: 0, ETH: 0 } }));
  const migrated = loadState();
  assert.equal(migrated.account?.email, 'tester@aqua.example', '보유 코인 출금 기록이 있어도 계정을 지우지 않는다');
  assert.deepEqual(migrated.fundingOperations, []);
  assert.equal(migrated.transactions[0].amount, 140_000 + 14_000, '보유 USDC 100개와 출금 중이던 USDC 10개를 원화로 바꾼다');
  assert.equal(migrated.spend, legacy.spend + 154_000);
  const dropped = migrated.transactions.find((item) => item.title === 'USDC 출금');
  assert.deepEqual([dropped?.status, dropped?.fundingId], ['cancelled', undefined]);
  const finished = structuredClone(legacy);
  finished.fundingOperations[0].status = 'completed';
  finished.transactions.find((item) => item.fundingId)!.status = 'completed';
  values.set(STORAGE_KEY, JSON.stringify({ ...finished, holdings: { USDC: 0, USDT: 0, BTC: 0, ETH: 0 } }));
  const history = loadState();
  assert.deepEqual([history.spend, history.fundingOperations.length, history.transactions.find((item) => item.title === 'USDC 출금')?.status], [legacy.spend, 0, 'completed'],
    '끝난 코인 출금은 내역으로만 남긴다');
}));

test('기본 보유 코인(USDC 100·BTC 0.0012·ETH 0.08)은 1원도 잃지 않고 640,000원으로 바꿔 결제 잔액에 더한다', () => withFundingStorage(({ values }) => {
  const saved = createInitialState(NOW);
  values.set(STORAGE_KEY, JSON.stringify({ ...saved, holdings: { USDC: 100, USDT: 0, BTC: 0.0012, ETH: 0.08 } }));
  const loaded = loadState();
  assert.equal(loaded.transactions[0].title, '보유 코인 자동 전환');
  assert.equal(loaded.transactions[0].amount, 640_000);
  assert.equal(loaded.spend, saved.spend + 640_000);
  assert.ok(!('holdings' in loaded));
}));

test('실물카드는 배송지가 있어야 접수하고 배송이 시작되기 전까지만 배송지를 바꾼다', () => {
  const noAddress = reviewState('basic', true);
  noAddress.card.address = null;
  assert.throws(() => applyAction(noAddress, { type: 'SUBMIT_CARD' }, NOW), /주소/);
  let state = activate(reviewState('basic', true));
  const moved = { ...SAMPLE_ADDRESS, detail: '202호' };
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, address: moved } }, NOW);
  assert.equal(state.card.address?.detail, '202호');
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, delivery: 'shipped' } }, NOW);
  assert.throws(() => applyAction(state, { type: 'SET_CARD', card: { ...state.card, address: SAMPLE_ADDRESS } }, NOW), /배송이 시작되면/);
  assert.throws(() => applyAction(activeState(), { type: 'ADD_PHYSICAL_CARD', address: { zip: '1', road: '', detail: '' } }, NOW), /주소/);
});

test('실물카드는 쉬운 비밀번호를 거절하고 비밀번호를 정해야 활성화하며 비밀번호 자체는 저장하지 않는다', () => {
  let state = activate(reviewState('basic', true));
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, delivery: 'shipped' } }, NOW);
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, delivery: 'delivered' } }, NOW);
  for (const pin of ['1111', '1234', '9876', '12a4', '123']) assert.throws(() => applyAction(state, { type: 'ACTIVATE_PHYSICAL', pin }, NOW), /숫자/);
  state = applyAction(state, { type: 'ACTIVATE_PHYSICAL', pin: '2580' }, NOW);
  assert.deepEqual([state.card.physicalActive, state.card.pinSet], [true, true]);
  assert.ok(!JSON.stringify(state).includes('2580'));
  assert.throws(() => applyAction(state, { type: 'ACTIVATE_PHYSICAL', pin: '2580' }, NOW), /이미/);
  assert.equal(applyAction(state, { type: 'SET_CARD_PIN', pin: '7395' }, NOW).card.pinSet, true);
});

test('결제 한도는 최대 한도 안에서 1만원 단위로 낮추고 결제에 바로 적용한다', () => {
  let state = activeState();
  assert.throws(() => applyAction(state, { type: 'SET_LIMITS', perPayment: 600_000, daily: 1_000_000, monthly: 5_000_000 }, NOW), /1회 한도/);
  assert.throws(() => applyAction(state, { type: 'SET_LIMITS', perPayment: 105_000, daily: 1_000_000, monthly: 5_000_000 }, NOW), /1만원 단위/);
  assert.throws(() => applyAction(state, { type: 'SET_LIMITS', perPayment: 300_000, daily: 200_000, monthly: 5_000_000 }, NOW), /일 한도/);
  assert.throws(() => applyAction(state, { type: 'SET_LIMITS', perPayment: 100_000, daily: 300_000, monthly: 200_000 }, NOW), /월 한도/);
  state = applyAction(state, { type: 'SET_LIMITS', perPayment: 50_000, daily: 60_000, monthly: 1_000_000 }, NOW);
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '상점', amount: 50_001 }, NOW), /1회 결제 한도는 5만원/);
  state = applyAction(state, { type: 'PAY', merchant: '상점', amount: 50_000 }, NOW);
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '상점', amount: 10_001 }, NOW), /일 결제 한도 6만원/);
});

test('온라인·해외 결제를 막으면 그 결제만 거절하고 매장 결제는 그대로 된다', () => {
  let state = applyAction(activeState(), { type: 'SET_CHANNEL', channel: 'online', enabled: false }, NOW);
  state = applyAction(state, { type: 'SET_CHANNEL', channel: 'overseas', enabled: false }, NOW);
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: '쇼핑몰', amount: 1_000, channel: 'online' }, NOW), /온라인 결제를 막아/);
  assert.throws(() => applyAction(state, { type: 'PAY', merchant: 'Cafe', amount: 1_000, channel: 'overseas' }, NOW), /해외 결제를 막아/);
  const paid = applyAction(state, { type: 'PAY', merchant: '카페', amount: 1_000 }, NOW);
  assert.equal(paid.payments[0].channel, 'store');
  const reopened = applyAction(state, { type: 'SET_CHANNEL', channel: 'online', enabled: true }, NOW);
  assert.equal(applyAction(reopened, { type: 'PAY', merchant: '쇼핑몰', amount: 1_000, channel: 'online' }, NOW).payments[0].channel, 'online');
});

test('비밀번호 변경은 지금 비밀번호를 확인하고, 광고성 정보 수신 동의는 바꾼 날짜를 남긴다', () => {
  let state = applyAction(createInitialState(NOW), signup, NOW);
  assert.throws(() => applyAction(state, { type: 'CHANGE_PASSWORD', currentHash: 'b'.repeat(64), nextHash: 'c'.repeat(64) }, NOW), /지금 비밀번호/);
  assert.throws(() => applyAction(state, { type: 'CHANGE_PASSWORD', currentHash: HASH, nextHash: HASH }, NOW), /다른 비밀번호/);
  state = applyAction(state, { type: 'CHANGE_PASSWORD', currentHash: HASH, nextHash: 'c'.repeat(64) }, NOW);
  assert.equal(state.account?.passwordHash, 'c'.repeat(64));
  assert.deepEqual(state.notifications, { payments: true, funding: true, marketing: false, marketingChangedAt: null });
  state = applyAction(state, { type: 'SET_NOTIFICATION', key: 'marketing', enabled: true }, NOW + 5_000);
  assert.deepEqual([state.notifications.marketing, state.notifications.marketingChangedAt], [true, NOW + 5_000]);
});
