import test from 'node:test';
import assert from 'node:assert/strict';
import { createFundingQuote, fundingStatusLabel, getFundingNetworks, getHeldFundingWon, isFundingPending, validateFundingAddress } from './movements';
import { createInitialState } from './engine';
import type { AssetSymbol, FundingNetwork, FundingOperation } from './types';

test('지원하는 코인·네트워크의 수수료와 예상 확인 정보를 제공한다', () => {
  assert.deepEqual(getFundingNetworks('USDC').map(({ id, feeWon }) => ({ id, feeWon })), [
    { id: 'polygon', feeWon: 140 }, { id: 'ethereum', feeWon: 2_800 },
  ]);
  for (const [symbol, network, fee] of [
    ['USDT', 'ethereum', 2_800], ['BTC', 'bitcoin', 1_500], ['ETH', 'ethereum', 2_000],
  ] as const) {
    const options = getFundingNetworks(symbol);
    assert.equal(options.length, 1);
    assert.equal(options[0].id, network);
    assert.equal(options[0].feeWon, fee);
    assert.ok(options[0].confirmationLabel);
    assert.ok(options[0].estimatedTime);
  }
  assert.deepEqual(getFundingNetworks('DOGE' as AssetSymbol), []);
  const options = getFundingNetworks('USDC');
  options[0].feeWon = 0;
  assert.equal(getFundingNetworks('USDC')[0].feeWon, 140, '호출자가 반환값을 수정해도 공용 수수료는 변하지 않는다');
});

test('입금은 0.5% 전환 수수료만 공제하고 선택 네트워크 수수료는 부과하지 않는다', () => {
  for (const network of ['polygon', 'ethereum'] as const) {
    assert.deepEqual(createFundingQuote({ kind: 'deposit', source: 'spend', symbol: 'USDC', network, units: 2.35 }), {
      amountWon: 3_290, units: 2.35, feeWon: 17, networkFeeWon: 0, netWon: 3_273, outputUnits: 0,
    });
  }
  assert.throws(() => createFundingQuote({ kind: 'deposit', source: 'holdings', symbol: 'USDC', network: 'polygon', units: 10 }), /원화 결제/);
});

test('결제 잔액 출금에는 전환·네트워크 수수료를 모두 반영한다', () => {
  const quote = createFundingQuote({ kind: 'withdrawal', source: 'spend', symbol: 'USDC', network: 'polygon', amount: 10_000 });
  assert.deepEqual(quote, {
    amountWon: 10_000, units: 10_000 / 1_400, feeWon: 50, networkFeeWon: 140,
    netWon: 9_810, outputUnits: 9_810 / 1_400,
  });
  const ethereum = createFundingQuote({ kind: 'withdrawal', source: 'spend', symbol: 'USDC', network: 'ethereum', amount: 10_000 });
  assert.equal(ethereum.feeWon, 50);
  assert.equal(ethereum.networkFeeWon, 2_800);
  assert.equal(ethereum.netWon, 7_150);
});

test('보유 코인 출금에는 원화 전환 수수료를 부과하지 않는다', () => {
  assert.deepEqual(createFundingQuote({ kind: 'withdrawal', source: 'holdings', symbol: 'USDC', network: 'polygon', units: 2.35 }), {
    amountWon: 3_290, units: 2.35, feeWon: 0, networkFeeWon: 140, netWon: 3_150, outputUnits: 3_150 / 1_400,
  });
  const quote = createFundingQuote({ kind: 'withdrawal', source: 'holdings', symbol: 'ETH', network: 'ethereum', units: 0.00057 });
  assert.equal(quote.amountWon, 2_280);
  assert.equal(quote.feeWon, 0);
  assert.equal(quote.netWon, 280);
  assert.equal(quote.outputUnits, 0.00007);
});

test('소수 원화 평가는 정확히 내림하고 표시 자릿수보다 작은 코인 수량도 받는다', () => {
  for (const [symbol, network, units, amountWon, feeWon] of [
    ['USDC', 'polygon', 2.35001, 3_290, 17],
    ['BTC', 'bitcoin', 0.00000822, 1_233, 7],
    ['ETH', 'ethereum', 0.000251, 1_004, 6],
  ] as const) {
    const quote = createFundingQuote({ kind: 'deposit', source: 'spend', symbol, network, units });
    assert.equal(quote.amountWon, amountWon);
    assert.equal(quote.feeWon, feeWon);
    assert.equal(quote.units, units);
    assert.equal(quote.netWon, amountWon - feeWon);
  }
  const exact = createFundingQuote({ kind: 'deposit', source: 'spend', symbol: 'ETH', network: 'ethereum', units: 0.00057 });
  assert.equal(exact.amountWon, 2_280, '부동소수 곱셈에 따른 1원 손실을 방지한다');
});

test('최소 평가액·안전한 정수·유한 수량과 수수료 이하 출금을 거절한다', () => {
  for (const units of [undefined, 0, -1, NaN, Infinity, 0.000001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createFundingQuote({ kind: 'deposit', source: 'spend', symbol: 'BTC', network: 'bitcoin', units }));
  }
  for (const amount of [undefined, 0, -1, 999, 1_000.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createFundingQuote({ kind: 'withdrawal', source: 'spend', symbol: 'USDC', network: 'polygon', amount }));
  }
  assert.throws(() => createFundingQuote({ kind: 'withdrawal', source: 'spend', symbol: 'USDC', network: 'ethereum', amount: 2_800 }), /수수료/);
  assert.throws(() => createFundingQuote({ kind: 'withdrawal', source: 'holdings', symbol: 'ETH', network: 'ethereum', units: 0.0005 }), /수수료/);
  const minimum = createFundingQuote({ kind: 'deposit', source: 'spend', symbol: 'ETH', network: 'ethereum', units: 0.00025 });
  assert.equal(minimum.amountWon, 1_000);
  assert.equal(minimum.netWon, 995);
  const upper = createFundingQuote({ kind: 'withdrawal', source: 'spend', symbol: 'USDC', network: 'polygon', amount: Number.MAX_SAFE_INTEGER });
  assert.ok(Number.isSafeInteger(upper.feeWon));
  assert.ok(Number.isSafeInteger(upper.netWon));
  assert.equal(upper.amountWon, Number.MAX_SAFE_INTEGER);
});

test('견적과 주소 검증 모두 지원하지 않는 자산·네트워크 조합을 거절한다', () => {
  for (const [symbol, network] of [
    ['USDT', 'polygon'], ['BTC', 'ethereum'], ['ETH', 'bitcoin'], ['DOGE', 'polygon'], ['USDC', 'arbitrum'],
  ] as [AssetSymbol, FundingNetwork][]) {
    assert.throws(() => createFundingQuote({ kind: 'deposit', source: 'spend', symbol, network, units: 10 }), /지원하는 네트워크/);
    assert.match(validateFundingAddress(symbol, network, `aqua-preview:${network}:${symbol.toLowerCase()}`)!, /지원하는 네트워크/);
  }
});

test('EVM 주소는 40자리 hex·비영 주소와 명시적인 미리보기 주소만 받는다', () => {
  const address = `0x${'aB12'.repeat(10)}`;
  assert.equal(validateFundingAddress('USDC', 'polygon', address), null);
  assert.equal(validateFundingAddress('USDT', 'ethereum', address), null);
  assert.equal(validateFundingAddress('ETH', 'ethereum', ` ${address} `), null);
  assert.equal(validateFundingAddress('USDC', 'polygon', 'aqua-preview:polygon:usdc'), null);
  for (const invalid of ['', ' ', `0x${'0'.repeat(40)}`, `0x${'a'.repeat(39)}`, `0x${'a'.repeat(41)}`, `0x${'g'.repeat(40)}`, `0X${'a'.repeat(40)}`, 'aqua-preview:ethereum:usdc', 'aqua-preview:polygon:usdt']) {
    assert.ok(validateFundingAddress('USDC', 'polygon', invalid));
  }
});

test('Bitcoin 주소는 지원하는 bech32 모양만 확인하며 체크섬 검증을 주장하지 않는다', () => {
  for (const address of [`bc1q${'a'.repeat(38)}`, `bc1q${'a'.repeat(58)}`, `bc1p${'a'.repeat(58)}`, 'aqua-preview:bitcoin:btc']) {
    assert.equal(validateFundingAddress('BTC', 'bitcoin', address), null);
  }
  for (const address of [`bc1q${'a'.repeat(37)}`, `bc1q${'a'.repeat(39)}`, `bc1p${'a'.repeat(38)}`, `bc1q${'b'.repeat(38)}`, `bc1r${'a'.repeat(38)}`, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', `0x${'a'.repeat(40)}`, 'aqua-preview:polygon:btc']) {
    assert.ok(validateFundingAddress('BTC', 'bitcoin', address));
  }
});

function operation(overrides: Partial<FundingOperation> = {}): FundingOperation {
  return {
    id: 'funding-1', requestId: 'request-1', kind: 'withdrawal', source: 'spend',
    symbol: 'USDC', network: 'polygon', amountWon: 10_000, units: 10_000 / 1_400,
    feeWon: 50, networkFeeWon: 140, netWon: 9_810, outputUnits: 9_810 / 1_400,
    address: 'aqua-preview:polygon:usdc', recipient: '내 지갑', status: 'reviewing',
    createdAt: 1_000, updatedAt: 1_000, stageDueAt: 4_000, simulation: 'success', ...overrides,
  };
}

test('입금 대기부터 출금 전송까지 처리 중으로 표시하고 종결 상태는 제외한다', () => {
  const labels: Record<FundingOperation['status'], string> = {
    awaiting_deposit: '입금 대기', confirming: '네트워크 확인 중', converting: '원화 전환 중',
    reviewing: '출금 검토 중', broadcasting: '네트워크 전송 중',
    completed: '완료', failed: '실패', cancelled: '취소',
  };
  for (const [status, label] of Object.entries(labels) as [FundingOperation['status'], string][]) {
    assert.equal(fundingStatusLabel(status), label);
    assert.equal(isFundingPending(operation({ status })), !['completed', 'failed', 'cancelled'].includes(status));
  }
});

test('검토·전송 중인 결제 잔액과 보유 코인 출금 원금만 총 자산 보류액으로 합산한다', () => {
  const state = createInitialState(1_000);
  state.fundingOperations = [
    operation({ id: 'spend', amountWon: 10_000 }),
    operation({ id: 'holdings', source: 'holdings', status: 'broadcasting', amountWon: 20_000 }),
    operation({ id: 'deposit', kind: 'deposit', status: 'confirming', amountWon: 30_000 }),
    operation({ id: 'completed', status: 'completed', amountWon: 40_000 }),
    operation({ id: 'failed', status: 'failed', amountWon: 50_000 }),
    operation({ id: 'cancelled', status: 'cancelled', amountWon: 60_000 }),
    operation({ id: 'waiting', kind: 'deposit', status: 'awaiting_deposit', amountWon: 70_000 }),
    operation({ id: 'converting', kind: 'deposit', status: 'converting', amountWon: 80_000 }),
  ];
  assert.equal(getHeldFundingWon(state), 30_000);
  state.fundingOperations = [];
  assert.equal(getHeldFundingWon(state), 0);
});
