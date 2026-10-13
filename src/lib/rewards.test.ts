import test from 'node:test';
import assert from 'node:assert/strict';
import { addYear, applyAction, createInitialState } from './engine';
import { PLANS } from './policy';
import { getCashbackSummary } from './rewards';
import type { AppState, Plan } from './types';

const NOW = Date.UTC(2026, 9, 13, 3);
const DAY = 86_400_000;
const MONTH_END = Date.UTC(2026, 9, 31, 14, 59); // 서울 10월 31일 23:59
const MONTH_START = MONTH_END + 60_000; // 서울 11월 1일 00:00

function activeState(now = NOW, plan: Plan = 'standard'): AppState {
  const state = createInitialState(now);
  state.card = { ...state.card, stage: 'active', plan, identityVerified: true, submittedAt: now, issuedAt: now, billingAt: PLANS[plan].annualFee ? addYear(now) : null };
  state.spend = 3_000_000;
  state.rewards = 0;
  state.rewardsAuto = false;
  return state;
}

function pay(state: AppState, amount: number, now = NOW, merchant = '테스트 상점'): AppState {
  return applyAction(state, { type: 'PAY', amount, merchant }, now);
}

function confirm(state: AppState, id = state.payments[0].id, now = NOW): AppState {
  return applyAction(state, { type: 'CONFIRM_PAYMENT', id }, now);
}

test('월 페이백 집계는 보유 리워드 잔액과 구분하며 스탠다드 기본 지급률·한도를 보여준다', () => {
  const state = createInitialState(NOW);
  assert.equal(state.rewards, 4_280);
  assert.deepEqual(getCashbackSummary(state), {
    month: '2026-10', confirmed: 0, pending: 0, remaining: 10_000,
    rate: 0.01, cap: 10_000, allocated: 0,
  });
});

test('프리미엄 지급률·월 한도를 적용하고 Reserve 보상률 변경과 혼동하지 않는다', () => {
  let state = activeState(NOW, 'premium');
  state = applyAction(state, { type: 'CHANGE_RATE', rate: 0.08 }, NOW);
  state = confirm(pay(state, 10_000));
  assert.equal(state.reserveRate, 0.08);
  assert.deepEqual(getCashbackSummary(state), {
    month: '2026-10', confirmed: 150, pending: 0, remaining: 29_850,
    rate: 0.015, cap: 30_000, allocated: 150,
  });
});

test('프라이빗 지급률·월 한도를 집계에 보여준다', () => {
  const state = confirm(pay(activeState(NOW, 'private'), 10_000));
  assert.deepEqual(getCashbackSummary(state), {
    month: '2026-10', confirmed: 200, pending: 0, remaining: 99_800,
    rate: 0.02, cap: 100_000, allocated: 200,
  });
});

test('승인 시 대기 페이백이 월 한도를 예약하고 확정 시 예약을 다시 차감하지 않는다', () => {
  let state = pay(activeState(), 10_000);
  const id = state.payments[0].id;
  assert.equal(state.rewards, 0);
  assert.deepEqual(getCashbackSummary(state), {
    month: '2026-10', confirmed: 0, pending: 100, remaining: 9_900,
    rate: 0.01, cap: 10_000, allocated: 100,
  });

  state = confirm(state, id);
  assert.equal(state.rewards, 100);
  const settled = getCashbackSummary(state);
  assert.equal(settled.confirmed, 100);
  assert.equal(settled.pending, 0);
  assert.equal(settled.allocated, 100);
  assert.equal(settled.remaining, 9_900);
  assert.deepEqual(getCashbackSummary(confirm(state, id)), settled, '재확정은 월 집계를 중복 지급하지 않는다');
});

test('여러 미확정 승인이 한도를 소진하면 후속 결제의 추가 페이백을 예약하지 않는다', () => {
  let state = pay(activeState(), 500_000);
  const firstId = state.payments[0].id;
  state = pay(state, 500_000);
  const secondId = state.payments[0].id;
  state = pay(state, 10_000, NOW + DAY);
  assert.equal(state.payments[0].cashback, 0);
  assert.deepEqual(getCashbackSummary(state), {
    month: '2026-10', confirmed: 0, pending: 10_000, remaining: 0,
    rate: 0.01, cap: 10_000, allocated: 10_000,
  });

  state = confirm(state, firstId, NOW + DAY);
  assert.equal(getCashbackSummary(state).confirmed, 5_000);
  assert.equal(getCashbackSummary(state).pending, 5_000);
  assert.equal(getCashbackSummary(state).remaining, 0);
  state = confirm(state, secondId, NOW + DAY);
  assert.equal(getCashbackSummary(state).confirmed, 10_000);
  assert.equal(getCashbackSummary(state).pending, 0);
  assert.equal(getCashbackSummary(state).remaining, 0);
});

test('동월 부분 환불은 확정 페이백과 한도 예약을 줄이고 전액 환불은 모두 복구한다', () => {
  let state = confirm(pay(activeState(), 10_000));
  const id = state.payments[0].id;
  state = applyAction(state, { type: 'REFUND', id, amount: 4_000 }, NOW);
  assert.equal(state.payments[0].status, 'partially_refunded');
  assert.equal(state.payments[0].cashbackReversed, 40);
  assert.equal(getCashbackSummary(state).confirmed, 60);
  assert.equal(getCashbackSummary(state).pending, 0);
  assert.equal(getCashbackSummary(state).allocated, 60);
  assert.equal(getCashbackSummary(state).remaining, 9_940);

  state = applyAction(state, { type: 'REFUND', id }, NOW);
  assert.equal(state.payments[0].status, 'refunded');
  assert.equal(getCashbackSummary(state).confirmed, 0);
  assert.equal(getCashbackSummary(state).pending, 0);
  assert.equal(getCashbackSummary(state).allocated, 0);
  assert.equal(getCashbackSummary(state).remaining, 10_000);
});

test('달 중간에 멤버십을 올리면 그달 집계는 새 지급률·상한을 쓰고 이미 받은 페이백은 새 상한에서 뺀다', () => {
  let state = activeState();
  state.spend = 5_000_000;
  state = confirm(pay(state, 500_000));
  state = applyAction(state, { type: 'CHANGE_PLAN', plan: 'premium' }, NOW);
  assert.deepEqual(getCashbackSummary(state), {
    month: '2026-10', confirmed: 5_000, pending: 0, remaining: 25_000,
    rate: 0.015, cap: 30_000, allocated: 5_000,
  });
  state = pay(state, 100_000);
  assert.equal(state.payments[0].cashback, 1_500);
  assert.deepEqual(getCashbackSummary(state), {
    month: '2026-10', confirmed: 5_000, pending: 1_500, remaining: 23_500,
    rate: 0.015, cap: 30_000, allocated: 6_500,
  });
});

test('갱신일에 연회비를 못 내 스탠다드가 되면 그달 집계도 스탠다드 상한을 쓰고 이미 예약한 페이백은 그대로 둔다', () => {
  let state = activeState(Date.UTC(2025, 9, 18, 3), 'premium'); // 2026년 10월 18일이 갱신일이다.
  state.spend = 1_010_000;
  state = pay(state, 500_000);
  state = pay(state, 500_000);
  assert.equal(getCashbackSummary(state).pending, 15_000, '프리미엄 1.5%로 예약한 페이백');
  const renewal = Date.UTC(2026, 9, 18, 3);
  state = applyAction(state, { type: 'TICK' }, renewal);
  assert.deepEqual([state.card.plan, state.spend], ['standard', 10_000], '잔액 10,000원으로는 연회비 100,000원을 낼 수 없다');
  assert.deepEqual(getCashbackSummary(state), {
    month: '2026-10', confirmed: 0, pending: 15_000, remaining: 0,
    rate: 0.01, cap: 10_000, allocated: 15_000,
  });
  state = pay(state, 10_000, renewal);
  assert.equal(state.payments[0].cashback, 0, '이번 달 페이백이 이미 스탠다드 상한을 넘었다');
});

test('리워드 혼합 결제의 부분 환불은 실제 원금별 페이백 환수와 같은 금액을 집계한다', () => {
  let state = activeState();
  state.rewardsAuto = true;
  state.rewards = 101;
  state = confirm(pay(state, 201));
  const id = state.payments[0].id;
  assert.equal(state.payments[0].cashback, 1);
  assert.equal(getCashbackSummary(state).confirmed, 1);

  state = applyAction(state, { type: 'REFUND', id, amount: 100 }, NOW);
  assert.equal(state.payments[0].principalRestored, 50);
  assert.equal(state.payments[0].cashbackReversed, 0);
  assert.equal(getCashbackSummary(state).confirmed, 1, '원 단위 누적 반올림 전까지 페이백을 조기에 환수하지 않는다');
  assert.equal(getCashbackSummary(state).remaining, 9_999);
  state = applyAction(state, { type: 'REFUND', id }, NOW);
  assert.equal(getCashbackSummary(state).confirmed, 0);
  assert.equal(getCashbackSummary(state).remaining, 10_000);
});

test('전월 결제의 부분·전액 환불은 현재 월 확정·대기 페이백과 한도를 변경하지 않는다', () => {
  let state = confirm(pay(activeState(MONTH_END), 10_000, MONTH_END), undefined, MONTH_END);
  const oldId = state.payments[0].id;
  state = pay(state, 20_000, MONTH_START);
  const currentId = state.payments[0].id;
  state = confirm(state, currentId, MONTH_START);
  state = pay(state, 5_000, MONTH_START);
  const beforeRefund = getCashbackSummary(state);
  assert.deepEqual(beforeRefund, {
    month: '2026-11', confirmed: 200, pending: 50, remaining: 9_750,
    rate: 0.01, cap: 10_000, allocated: 250,
  });

  state = applyAction(state, { type: 'REFUND', id: oldId, amount: 4_000 }, MONTH_START);
  assert.deepEqual(getCashbackSummary(state), beforeRefund);
  state = applyAction(state, { type: 'REFUND', id: oldId }, MONTH_START);
  assert.deepEqual(getCashbackSummary(state), beforeRefund);
});

test('서울 월 경계를 넘긴 미확정 결제는 원승인월에 귀속되고 새 월 한도를 점유하지 않는다', () => {
  let state = pay(activeState(MONTH_END), 10_000, MONTH_END);
  const oldId = state.payments[0].id;
  assert.equal(getCashbackSummary(state).month, '2026-10');
  assert.equal(getCashbackSummary(state).pending, 100);

  state = applyAction(state, { type: 'TICK' }, MONTH_START);
  assert.equal(state.payments.find((payment) => payment.id === oldId)?.status, 'pending');
  assert.equal(state.payments.find((payment) => payment.id === oldId)?.cashbackMonth, '2026-10');
  assert.deepEqual(getCashbackSummary(state), {
    month: '2026-11', confirmed: 0, pending: 0, remaining: 10_000,
    rate: 0.01, cap: 10_000, allocated: 0,
  });
  state = pay(state, 20_000, MONTH_START);
  assert.equal(getCashbackSummary(state).pending, 200);
  assert.equal(getCashbackSummary(state).remaining, 9_800);
});

test('월초에 지급한 전월 페이백은 지급월 잔액에는 더해지지만 승인월 집계를 바꾸지 않는다', () => {
  let state = pay(activeState(MONTH_END), 10_000, MONTH_END);
  const oldId = state.payments[0].id;
  state = pay(state, 20_000, MONTH_START);
  const currentId = state.payments[0].id;
  const beforeOldConfirmation = getCashbackSummary(state);

  state = confirm(state, oldId, MONTH_START);
  assert.equal(state.rewards, 100);
  const oldPayout = state.transactions.find((item) => item.kind === 'payback' && item.paymentId === oldId);
  assert.equal(oldPayout?.timestamp, MONTH_START);
  assert.equal(state.payments.find((payment) => payment.id === oldId)?.cashbackMonth, '2026-10');
  assert.deepEqual(getCashbackSummary(state), beforeOldConfirmation);

  state = confirm(state, currentId, MONTH_START);
  assert.equal(state.rewards, 300);
  assert.equal(getCashbackSummary(state).confirmed, 200);
  assert.equal(getCashbackSummary(state).pending, 0);
  assert.equal(getCashbackSummary(state).remaining, 9_800);
});

test('과거 페이백 상계가 있으면 확정 집계는 실제 결제 가능 리워드 증가보다 클 수 있다', () => {
  let state = activeState();
  state.rewardsAuto = true;
  state = confirm(pay(state, 10_000));
  const originalId = state.payments[0].id;
  state = confirm(pay(state, 100)); // 앞서 받은 페이백을 모두 사용한다.
  assert.equal(state.rewards, 0);
  assert.equal(state.payments[0].cashback, 0, '리워드 사용분에는 다시 페이백이 붙지 않는다');
  state = applyAction(state, { type: 'REFUND', id: originalId }, NOW);
  assert.equal(state.rewardDebt, 100);
  assert.equal(getCashbackSummary(state).confirmed, 0);

  state = pay(state, 20_000);
  assert.equal(getCashbackSummary(state).pending, 200);
  assert.equal(getCashbackSummary(state).confirmed, 0);
  const rewardsBefore = state.rewards;
  state = confirm(state);
  assert.equal(state.rewardDebt, 0);
  assert.equal(state.rewards - rewardsBefore, 100);
  assert.equal(getCashbackSummary(state).confirmed, 200, '확정 페이백은 상계 전 발생액이며 보유 잔액과 구분한다');
  assert.equal(getCashbackSummary(state).pending, 0);
  assert.equal(getCashbackSummary(state).remaining, 9_800);
});
