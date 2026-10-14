import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createInitialState } from './engine';
import { STATEMENT_COLUMNS, statementText, statementYears, summarizeYear } from './statement';
import type { Action, AppState } from './types';

const NOW = Date.UTC(2026, 9, 13, 3);
const signup: Action = {
  type: 'COMPLETE_SIGNUP', email: 'tester@aqua.example', passwordHash: 'a'.repeat(64), name: '아쿠아 사용자', birthDate: '1995-04-12',
  phone: '01012345678', kyc: { idType: 'resident', occupation: '회사원', purpose: '카드 결제', source: '근로소득', match: 'face',
    address: { zip: '04500', road: '서울특별시 중구 아쿠아로 1', detail: '' }, pep: false, evidence: null },
};

function deposit(state: AppState, requestId: string, symbol: 'USDC' | 'KRWS', units: number): AppState {
  let next = applyAction(state, { type: 'START_FUNDING', requestId, kind: 'deposit', source: 'spend', symbol, network: 'polygon', units, quotedAt: NOW }, NOW);
  next = applyAction(next, { type: 'SIMULATE_FUNDING_DEPOSIT', id: next.fundingOperations[0].id }, NOW);
  return applyAction(next, { type: 'TICK' }, NOW + 6_000);
}

/** A year with every kind of movement the statement sums up. */
function busyYear(): AppState {
  let state = applyAction(createInitialState(NOW), signup, NOW);
  state = deposit(state, 'usdc-in', 'USDC', 10);
  state = deposit(state, 'krws-in', 'KRWS', 20_000);
  state = applyAction(state, { type: 'START_FUNDING', requestId: 'usdt-out', kind: 'withdrawal', source: 'spend', symbol: 'USDT', network: 'ethereum',
    amount: 14_000, address: 'aqua-preview:ethereum:usdt', destination: { kind: 'own_wallet', proof: 'signature' }, quotedAt: NOW }, NOW);
  state = applyAction(state, { type: 'TICK' }, NOW + 6_000);
  state.card = { ...state.card, stage: 'active', identityVerified: true, submittedAt: NOW, issuedAt: NOW };
  state = applyAction(state, { type: 'SET_REWARDS_AUTO', enabled: false }, NOW);
  state = applyAction(state, { type: 'PAY', merchant: '한강커피', amount: 10_000 }, NOW);
  state = applyAction(state, { type: 'CONFIRM_PAYMENT', id: state.payments[0].id }, NOW);
  state = applyAction(state, { type: 'REFUND', id: state.payments[0].id, amount: 4_000 }, NOW);
  state = applyAction(state, { type: 'PAY', merchant: '아쿠아커피', amount: 5_000 }, NOW);
  state = applyAction(state, { type: 'SEND_TO_MEMBER', tag: 'junho', amount: 3_000 }, NOW);
  state = applyAction(state, { type: 'RECEIVE_FROM_MEMBER', tag: 'minji.k', amount: 10_000 }, NOW);
  state = applyAction(state, { type: 'CHANGE_PLAN', plan: 'premium' }, NOW);
  return applyAction(state, { type: 'ADVANCE_DAY' }, NOW);
}

test('연간 요약은 완료된 충전·코인 전환·보내기·받기·환불 뺀 결제·페이백·리저브 보상·연회비를 한국 연도로 묶는다', () => {
  const state = busyYear();
  const summary = summarizeYear(state, 2026);
  assert.deepEqual(summary.deposits, { count: 2, won: 34_000 }, 'USDC 10개 14,000원과 원화 스테이블 20,000원');
  assert.deepEqual(summary.coinSales, { count: 1, won: 14_000 }, '원화 스테이블 충전은 코인 전환이 아니다');
  assert.deepEqual(summary.withdrawals, { count: 1, won: 14_000, fees: 70 + 2_800 });
  assert.deepEqual(summary.sentToMembers, { count: 1, won: 3_000 });
  assert.deepEqual(summary.receivedFromMembers, { count: 1, won: 10_000 });
  assert.deepEqual(summary.cardSpent, { count: 2, won: 6_000 + 5_000 }, '부분 환불을 뺀 결제와 아직 확정 전인 결제');
  assert.equal(summary.payback, 100 - 40, '확정된 결제의 페이백에서 환불로 줄어든 만큼을 뺀다');
  assert.equal(summary.cardFees, 100_000);
  const rewards = state.transactions.filter((item) => item.kind === 'reward').reduce((sum, item) => sum + item.amount, 0);
  assert.ok(rewards > 0);
  assert.equal(summary.reserveRewards, rewards);
  assert.deepEqual(statementYears(state, NOW), [2026]);
  assert.deepEqual(summarizeYear(state, 2025).deposits, { count: 0, won: 0 });
});

test('갱신일로 시간을 옮기면 다음 해가 생기고 해마다 따로 센다', () => {
  let state = busyYear();
  const before = summarizeYear(state, 2026);
  state = applyAction(state, { type: 'ADVANCE_TO_BILLING' }, NOW);
  assert.deepEqual(statementYears(state, NOW + state.clockOffsetMs), [2027, 2026]);
  const next = summarizeYear(state, 2027);
  assert.equal(next.cardFees, 0, '잔액이 모자라 연회비 없이 스탠다드로 바뀌었다');
  assert.ok(next.reserveRewards > 0, '1년 동안 쌓인 리저브 보상');
  assert.deepEqual(summarizeYear(state, 2026), before);
});

test('복사할 내역은 탭으로 칸을 나누고 오래된 거래부터 코인·수량·상대를 함께 적는다', () => {
  const state = busyYear();
  const { text, rows } = statementText(state, 2026);
  const lines = text.split('\n');
  assert.equal(lines[0], STATEMENT_COLUMNS.join('\t'));
  assert.equal(rows, state.transactions.length);
  assert.equal(lines.length, rows + 1);
  assert.ok(lines.every((line) => line.split('\t').length === STATEMENT_COLUMNS.length), '칸 안에는 탭이나 줄바꿈이 없다');
  const cells = lines.slice(1).map((line) => line.split('\t'));
  assert.deepEqual(cells[0].slice(0, 7), ['2026-10-13 12:00', '충전', 'USDC 입금', '14000', '완료', 'USDC', '10']);
  const withdrawal = cells.find((row) => row[1] === '지갑으로 보내기')!;
  assert.deepEqual([withdrawal[3], withdrawal[5], withdrawal[6], withdrawal[7]], ['-14000', 'USDT', '7.95', '내 지갑']);
  assert.deepEqual(cells.find((row) => row[1] === '회원에게 받기')!.slice(2, 8), ['김*지님이 보냄', '10000', '완료', '', '', '@minji.k']);
  assert.deepEqual(cells.find((row) => row[1] === '회원에게 보내기')!.slice(3, 8), ['-3000', '완료', '', '', '@junho']);
  assert.equal(cells.find((row) => row[2] === '아쿠아커피')?.[4], '처리 중', '확정 전 결제는 처리 중으로 적는다');
  assert.deepEqual(statementText(state, 2025), { text: STATEMENT_COLUMNS.join('\t'), rows: 0 });
});
