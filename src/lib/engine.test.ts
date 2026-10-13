import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, availableToSpend, createInitialState, loadState, portfolioValue, saveState, STORAGE_KEY } from './engine';
import { POLICY } from './policy';
import type { AppState, CardState } from './types';

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

test('Reserve 적립은 시간에 비례하며 동일 시각의 재실행과 시계 역행은 중복 적립하지 않는다', () => {
  const initial = createInitialState(NOW);
  const first = applyAction(initial, { type: 'TICK' }, NOW + DAY);
  close(first.accrued, 1_250_000 * 0.05 / 365);
  assert.deepEqual(applyAction(first, { type: 'TICK' }, NOW + DAY), first);
  assert.deepEqual(applyAction(first, { type: 'TICK' }, NOW), first);
});

test('입금과 보상률 변경 시 이전 잔액·보상률로 먼저 적립한다', () => {
  let state = createInitialState(NOW);
  state = applyAction(state, { type: 'DEPOSIT', bucket: 'reserve', amount: 1_250_000 }, NOW + DAY);
  close(state.accrued, 1_250_000 * 0.05 / 365);
  state = applyAction(state, { type: 'CHANGE_RATE', rate: 0.08 }, NOW + 2 * DAY);
  close(state.accrued, (1_250_000 * 0.05 + 2_500_000 * 0.05) / 365);
  state = applyAction(state, { type: 'TICK' }, NOW + 3 * DAY);
  close(state.accrued, (1_250_000 * 0.05 + 2_500_000 * 0.05 + 2_500_000 * 0.08) / 365);
  assert.equal(state.rateHistory.length, 2);
});

test('Reserve 보상 대상 상한과 하루 진행·정수 수령을 적용한다', () => {
  let state = createInitialState(NOW);
  state.reserve = 20_000_000;
  state = applyAction(state, { type: 'TICK' }, NOW + YEAR);
  assert.equal(state.accrued, 500_000);
  const next = applyAction(createInitialState(NOW), { type: 'ADVANCE_DAY' }, NOW);
  close(next.accrued, 1_250_000 * 0.05 / 365);
  assert.equal(next.clockOffsetMs, DAY);
  const redeemed = applyAction(next, { type: 'REDEEM_ACCRUAL' }, NOW);
  assert.equal(redeemed.rewards, 4_451);
  close(redeemed.accrued, next.accrued - 171);
});

test('Reserve 결제 이후 잔액에만 다음 구간 보상이 적립된다', () => {
  let state = activeState();
  state.spend = 0; state.rewards = 0; state.reserveAuto = true;
  state = applyAction(state, { type: 'PAY', merchant: '서점', amount: 100_000 }, NOW + DAY);
  state = applyAction(state, { type: 'TICK' }, NOW + 2 * DAY);
  close(state.accrued, (1_250_000 + 1_150_000) * 0.05 / 365);
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
  state = applyAction(state, { type: 'REDEEM_ACCRUAL' }, NOW);
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

test('코인 입출금과 전환은 보유량을 반영하고 0.5% 전환 수수료를 공제한다', () => {
  let state = createInitialState(NOW);
  state = applyAction(state, { type: 'DEPOSIT_ASSET', symbol: 'USDT', units: 10 }, NOW);
  state = applyAction(state, { type: 'WITHDRAW_ASSET', symbol: 'USDT', units: 3 }, NOW);
  assert.equal(state.holdings.USDT, 7);
  state = applyAction(state, { type: 'CONVERT', symbol: 'USDT', units: 7, quotedAt: NOW }, NOW);
  assert.equal(state.holdings.USDT, 0);
  assert.equal(state.spend, 128_500 + 9_751);
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
