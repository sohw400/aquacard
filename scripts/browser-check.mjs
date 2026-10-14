import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

/** Expected amounts come from the app's own membership and funding terms, so a policy change does not need new magic numbers here. */
async function loadPolicy() {
  const source = new URL('../src/lib/policy.ts', import.meta.url).href;
  try {
    return await import(source);
  } catch {
    const { tsImport } = await import('tsx/esm/api');
    return tsImport(source, import.meta.url);
  }
}
const { PLANS, POLICY, FUNDING_ASSETS } = await loadPolicy();

const base = process.env.AQUA_BASE_URL ?? 'http://127.0.0.1:5173';
const artifacts = new URL('../artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/aqua-chromium-config', XDG_CACHE_HOME: '/tmp/aqua-chromium-cache' },
});
const errors = [];
const external = [];
let groups = 0;
let page;
let failurePage;
const pass = (name) => { groups += 1; console.log(`PASS ${groups}: ${name}`); };
const observe = (target) => {
  failurePage = target;
  target.on('pageerror', (error) => errors.push(error.message));
  target.on('request', (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(base).origin) external.push(request.url());
  });
};

/** The demo starts every new account with these balances (engine createInitialState). */
const START = { spend: 128_500, reserve: 1_250_000, rewards: 4_280 };
const DAY_MS = 86_400_000;
const YEAR_MS = POLICY.secondsPerYear * 1_000;
const USDC_PRICE = FUNDING_ASSETS.USDC.price;
const POLYGON_NETWORK_FEE = 140;
const wonText = (value) => `${value.toLocaleString('ko-KR')}원`;
const percentText = (rate) => `${Number((rate * 100).toFixed(2))}%`;
const manWon = (value) => `${(value / 10_000).toLocaleString('ko-KR')}만원`;
const pattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Payback on the part not paid with rewards, floored and kept under the monthly cap (engine PAY). */
const paybackOf = (plan, paidWithoutRewards, earnedThisMonth = 0) => Math.min(Math.floor(paidWithoutRewards * PLANS[plan].cashbackRate), Math.max(0, PLANS[plan].cashbackCap - earnedThisMonth));
/** Base Reserve rate plus the membership bonus while the card is active (engine reserveTerms). */
const reserveTermsOf = (state) => {
  const plan = PLANS[state.card.stage === 'active' ? state.card.plan : 'standard'];
  return { rate: state.reserveRate + plan.reserveBonus, cap: plan.reserveCap };
};
const applicationFee = (plan, physical) => PLANS[plan].annualFee + (physical ? PLANS[plan].physicalFee : 0);
const withdrawalFee = (amount) => Math.ceil(amount * POLICY.conversionFee - 1e-9);

const sixDigits = async (locator) => (await locator.innerText()).match(/\d{6}/)[0];
const PASSWORD = 'aqua2026pass';
/** Completes sign-up with sample data: email code, password, phone code, ID and face checks, customer questions. */
async function signUp(target) {
  await target.getByTestId('auth-signup').click();
  await target.getByTestId('signup-email-sample').click();
  await target.getByTestId('signup-send-code').click();
  await target.getByTestId('signup-code').fill(await sixDigits(target.getByTestId('signup-demo-code')));
  await target.getByTestId('signup-password').fill(PASSWORD);
  await target.getByTestId('signup-password-confirm').fill(PASSWORD);
  await target.getByTestId('signup-next').click();
  await target.getByTestId('kyc-sample').click();
  await target.getByTestId('kyc-send-code').click();
  await target.getByTestId('kyc-code').fill(await sixDigits(target.getByTestId('kyc-demo-code')));
  await target.getByTestId('kyc-next').click();
  await target.getByTestId('kyc-id-scan').click();
  await target.getByTestId('kyc-face-scan').click();
  await target.getByTestId('kyc-id-next').click();
  await target.getByTestId('kyc-occupation').selectOption('회사원');
  await target.getByTestId('kyc-purpose').selectOption('카드 결제');
  await target.getByTestId('kyc-source').selectOption('근로소득');
  await target.getByTestId('kyc-consent').check();
  await target.getByTestId('kyc-submit').click();
  await target.getByTestId('signup-finish').click();
  await target.getByTestId('spend-balance').waitFor();
}
/** Withdrawals need the emailed code; the demo shows it on screen. */
async function verifyWithdrawalEmail(dialog) {
  if (await dialog.getByTestId('email-verified').count()) return;
  await dialog.getByTestId('email-send').click();
  await dialog.getByTestId('email-code').fill(await sixDigits(dialog.getByTestId('email-demo-code')));
  await dialog.getByTestId('email-verified').waitFor();
}
/** Picks a sample road address in the address sheet that is already open. */
async function chooseAddress(target, zip, { query = '', detail = '' } = {}) {
  const sheet = target.getByTestId('address-sheet');
  await sheet.waitFor();
  if (query) await sheet.getByTestId('address-query').fill(query);
  await sheet.getByTestId(`address-result-${zip}`).click();
  if (detail) await sheet.getByTestId('address-detail').fill(detail);
  await sheet.getByTestId('address-save').click();
  await sheet.waitFor({ state: 'hidden' });
}
/** Adds the active card to a phone wallet: terms, phone code, done. */
async function addWallet(target, wallet) {
  await target.getByTestId(`wallet-add-${wallet}`).click();
  const sheet = target.getByTestId('dialog-wallet');
  assert.equal(await sheet.getByTestId('wallet-next').isDisabled(), true, '등록 동의 전에는 다음으로 갈 수 없다');
  await sheet.getByTestId('wallet-terms').check();
  await sheet.getByTestId('wallet-next').click();
  await sheet.getByTestId('wallet-send-code').click();
  await sheet.getByTestId('wallet-code').fill(await sixDigits(sheet.getByTestId('wallet-demo-code')));
  await sheet.getByTestId('wallet-confirm').click();
  await sheet.getByTestId('wallet-done').click();
  await sheet.waitFor({ state: 'hidden' });
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  page = await context.newPage();
  observe(page);
  page.setDefaultTimeout(10_000);
  await page.goto(base, { waitUntil: 'networkidle' });
  await signUp(page);
  const read = (target = page) => target.evaluate(() => JSON.parse(localStorage.getItem('aqua-card:poc:v1')));
  async function stateWhen(predicate, target = page) {
    const deadline = Date.now() + 10_000;
    let state;
    while (Date.now() < deadline) {
      state = await read(target);
      if (state && predicate(state)) return state;
      await target.waitForTimeout(50);
    }
    assert.fail(`State did not reach expected condition: ${JSON.stringify(state)}`);
  }
  /** Tabs are 홈·카드·혜택·전체; 리저브 opens from the home reward block and 거래 내역 from the clock icon. */
  async function nav(name, target = page) {
    if (name === 'reserve') {
      await target.getByTestId('nav-home').click();
      await target.getByTestId('open-reserve-card').click();
      await target.getByTestId('reserve-principal').waitFor();
    } else if (name === 'activity') {
      await target.getByTestId('nav-activity').click();
      await target.locator('.activity-page').waitFor();
    } else {
      await target.getByTestId(`nav-${name}`).click();
    }
  }
  const portfolioOf = (state) => state.spend + state.reserve + state.fundingOperations.reduce((sum, item) => sum + (item.kind === 'withdrawal' && ['reviewing', 'broadcasting'].includes(item.status) ? item.amountWon : 0), 0);
  const ledgerSnapshot = (state) => ({
    spend: state.spend, reserve: state.reserve, rewards: state.rewards, rewardDebt: state.rewardDebt,
    card: state.card, payments: state.payments, transactions: state.transactions,
    fundingOperations: state.fundingOperations,
    reserveAuto: state.reserveAuto, rewardsAuto: state.rewardsAuto, monthlyCashback: state.monthlyCashback,
  });
  async function details(testId, open = true, target = page) {
    const element = target.getByTestId(testId);
    await element.waitFor();
    if (await element.evaluate((item) => item.open) !== open) await element.locator('summary').click();
    assert.equal(await element.evaluate((item) => item.open), open);
  }
  async function submitAmount(type, amount) {
    const dialog = page.getByTestId(`dialog-${type}`);
    await dialog.getByTestId('action-amount').fill(String(amount));
    if (type === 'transfer') {
      const before = ledgerSnapshot(await read());
      await dialog.getByTestId('transfer-next').click();
      assert.deepEqual(ledgerSnapshot(await read()), before, '내부 이동 확인 단계에서는 원장을 변경하지 않는다');
      await dialog.getByTestId('transfer-back').click();
      assert.equal(await dialog.getByTestId('action-amount').inputValue(), amount.toLocaleString('en-US'), '내부 이동 수정 단계로 돌아가도 입력값을 유지한다');
      assert.deepEqual(ledgerSnapshot(await read()), before, '이전 단계 버튼이 최종 제출을 실행하지 않는다');
      await dialog.getByTestId('transfer-next').click();
      await dialog.getByTestId('confirm-action').click();
      await dialog.getByTestId('transfer-completed').waitFor({ state: 'visible' });
      await dialog.getByTestId('transfer-done').click();
      await dialog.waitFor({ state: 'hidden' });
      return;
    }
    await dialog.getByTestId('confirm-action').click();
    await dialog.waitFor({ state: 'hidden' });
  }
  const displayedAmount = async (locator) => Number((await locator.innerText()).replace(/[^\d]/g, ''));
  const fundingDialogAt = (target = page) => target.getByTestId('dialog-funding');
  const operationWhen = async (id, status, target = page) => {
    const state = await stateWhen((current) => current.fundingOperations.some((item) => item.id === id && item.status === status), target);
    return state.fundingOperations.find((item) => item.id === id);
  };
  async function closeFunding(target = page) {
    await fundingDialogAt(target).getByRole('button', { name: '창 닫기', exact: true }).click();
    await fundingDialogAt(target).waitFor({ state: 'hidden' });
  }
  /** Funding requests reopen from 거래 내역 through their 처리 내역 button. */
  async function reopenFunding(id, target = page) {
    await nav('activity', target);
    await target.getByTestId(`funding-open-${id}`).click();
    await fundingDialogAt(target).waitFor({ state: 'visible' });
  }
  async function advanceFundingClock(id, nextStatus, target) {
    const wallNow = await target.evaluate(() => Date.now());
    await target.clock.setFixedTime(wallNow + 3_001);
    return operationWhen(id, nextStatus, target);
  }
  /** 충전 opens the deposit sheet from home; 보내기 › 지갑 주소로 opens the withdrawal sheet. */
  async function openFunding(mode = 'deposit', target = page) {
    await target.getByTestId('nav-home').click();
    if (mode === 'deposit') {
      await target.getByTestId('open-deposit').click();
    } else {
      await target.getByTestId('open-send').click();
      const sheet = target.getByTestId('send-sheet');
      await sheet.getByTestId('send-wallet').click();
      await sheet.waitFor({ state: 'hidden' });
    }
    await fundingDialogAt(target).waitFor({ state: 'visible' });
  }
  async function fundingRoute({ mode = 'deposit', symbol = 'USDC', network = 'polygon', target = page, open = true } = {}) {
    if (open) await openFunding(mode, target);
    const dialog = fundingDialogAt(target);
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByTestId(`funding-asset-${symbol}`).click();
    await dialog.getByTestId(`funding-network-${network}`).click();
    await dialog.getByTestId('funding-next').click();
    return dialog;
  }
  async function setFundingOutcome(outcome, target) {
    const dialog = fundingDialogAt(target);
    const summary = dialog.getByTestId('funding-simulation-settings');
    if (!await summary.evaluate((item) => item.parentElement.open)) await summary.click();
    await dialog.getByTestId(`funding-outcome-${outcome}`).check();
  }
  async function requestDeposit(units, target = page, outcome = 'success') {
    const dialog = fundingDialogAt(target);
    const before = await read(target);
    await dialog.getByTestId('action-amount').fill(String(units));
    await dialog.getByTestId('funding-next').click();
    if (outcome === 'failure') await setFundingOutcome(outcome, target);
    await dialog.getByTestId('funding-consent').check();
    await dialog.getByTestId('confirm-action').click();
    const state = await stateWhen((current) => current.fundingOperations.length === before.fundingOperations.length + 1, target);
    const operation = state.fundingOperations[0];
    assert.equal(operation.status, 'awaiting_deposit');
    assert.equal(state.spend, before.spend, '입금 대기 금액은 사용 가능한 잔액이 아니다');
    return operation;
  }
  async function prepareWithdrawal(amount, target = page, outcome = 'success') {
    const dialog = fundingDialogAt(target);
    await dialog.getByTestId('action-amount').fill(String(amount));
    await dialog.getByTestId('funding-recipient').fill('내 체험 지갑');
    await dialog.getByTestId('funding-preview-address').click();
    await dialog.getByTestId('funding-next').click();
    if (outcome === 'failure') await setFundingOutcome(outcome, target);
    await dialog.getByTestId('funding-consent').check();
    assert.equal(await dialog.getByTestId('confirm-action').isDisabled(), true, '이메일 인증 전에는 출금을 요청할 수 없다');
    await verifyWithdrawalEmail(dialog);
    return dialog;
  }
  async function requestWithdrawal(amount, target = page, outcome = 'success') {
    const dialog = await prepareWithdrawal(amount, target, outcome);
    const before = await read(target);
    await dialog.getByTestId('confirm-action').click();
    const state = await stateWhen((current) => current.fundingOperations.length === before.fundingOperations.length + 1, target);
    assert.equal(state.fundingOperations[0].status, 'reviewing');
    return state.fundingOperations[0];
  }
  async function settleFunding(operation, target = page) {
    if (operation.kind === 'deposit') {
      await fundingDialogAt(target).getByTestId('funding-simulate-deposit').click();
      await operationWhen(operation.id, 'confirming', target);
      await operationWhen(operation.id, 'converting', target);
    } else {
      await operationWhen(operation.id, 'broadcasting', target);
    }
    return operationWhen(operation.id, 'completed', target);
  }
  /** Deposits won stablecoin 1:1 through a funding sheet that is already open, and waits until it is in the balance. */
  async function topUpWithKrws(units, target) {
    await fundingRoute({ symbol: 'KRWS', target, open: false });
    const before = await read(target);
    const operation = await requestDeposit(units, target);
    assert.deepEqual([operation.amountWon, operation.feeWon, operation.netWon], [units * FUNDING_ASSETS.KRWS.price, 0, units * FUNDING_ASSETS.KRWS.price]);
    await settleFunding(operation, target);
    await stateWhen((current) => current.spend === before.spend + operation.netWon, target);
    await closeFunding(target);
    return operation;
  }
  async function paymentReceipt(expected, target = page, screenshot = false) {
    const receipt = target.getByTestId('payment-receipt');
    await receipt.waitFor({ state: 'visible' });
    const amountAt = async (id) => displayedAmount(receipt.getByTestId(id));
    const { before, used, cashback, credit = cashback, offset = 0, after } = expected;
    assert.equal(await amountAt('receipt-rewards-before'), before);
    assert.equal(await amountAt('receipt-rewards-used'), used);
    assert.equal(await amountAt('receipt-cashback-earned'), cashback);
    assert.equal(await amountAt('receipt-cashback-credit'), credit);
    if (offset || await receipt.getByTestId('receipt-cashback-offset').count()) assert.equal(await amountAt('receipt-cashback-offset'), offset);
    assert.equal(await amountAt('receipt-rewards-after'), after);
    assert.equal(before - used + credit, after, '결제 전 − 리워드 사용 + 실제 페이백 반영 = 결제 후');
    if (used > 0) assert.match(await receipt.getByTestId('receipt-rewards-used').innerText(), /[−-]/, '리워드 사용분은 차감으로 표시');
    if (cashback > 0) assert.match(await receipt.getByTestId('receipt-cashback-earned').innerText(), /\+/, '새 페이백은 적립으로 표시');
    if (before === after && used > 0 && credit === used) assert.match(await receipt.innerText(), /쓴 리워드와 새 페이백이 같아서 리워드는 그대로예요/);
    if (screenshot) await target.screenshot({ path: new URL('aqua-payment-receipt.png', artifacts).pathname, fullPage: true });
    await receipt.getByTestId('receipt-close').click();
    await receipt.waitFor({ state: 'hidden' });
  }
  /** The confirm sheet shows a cost line only when the change costs something. */
  async function expectSheetCost(target, cost) {
    const row = target.getByTestId('card-sheet').getByTestId('card-sheet-cost');
    if (cost > 0) assert.equal(await displayedAmount(row), cost);
    else assert.equal(await row.count(), 0, '비용이 없으면 잔액에서 낼 금액 줄을 보이지 않는다');
  }
  const flow = () => page.locator('.card-flow');
  /** Identity, membership and review screens; Standard picks the physical card, Premium and Private always ship theirs. */
  async function finishApplication({ plan = 'standard', physical = plan !== 'standard' } = {}, target = page) {
    const cardFlow = target.locator('.card-flow');
    assert.equal(await cardFlow.locator('.cf-steps li').count(), 3, '신청 화면은 본인확인·멤버십·신청 확인의 세 단계');
    await cardFlow.getByTestId('card-identity-consent').check();
    await cardFlow.getByTestId('card-identity-next').click();
    await cardFlow.getByRole('radio', { name: PLANS[plan].short }).check();
    if (plan === 'standard') await cardFlow.getByTestId('card-physical-choice').setChecked(physical);
    else assert.equal(await cardFlow.getByTestId('card-physical-choice').count(), 0, `${PLANS[plan].short}은 ${PLANS[plan].card}가 함께 나와 실물카드 선택지가 없다`);
    if (physical && (await read(target)).card.address === null) {
      assert.equal(await cardFlow.getByTestId('card-selection-next').isDisabled(), true, '실물카드는 배송지를 넣어야 다음으로 간다');
      await cardFlow.getByTestId('card-address-open').click();
      await chooseAddress(target, '04500', { query: '아쿠아로', detail: '101호' });
    }
    await cardFlow.getByTestId('card-selection-next').click();
    const fee = applicationFee(plan, physical);
    const total = cardFlow.getByTestId('card-fee-total');
    if (fee) assert.equal(await displayedAmount(total), fee);
    else assert.equal(await total.innerText(), '없음');
    assert.equal(await cardFlow.getByTestId('card-submit').isDisabled(), true, '최종 확인 전에는 접수할 수 없다');
    await cardFlow.getByTestId('card-review-consent').check();
    await cardFlow.getByTestId('card-submit').click();
    return stateWhen((state) => state.card.stage === 'submitted', target);
  }

  let state = await stateWhen((current) => current.card.stage === 'not_applied');
  assert.deepEqual([state.spend, state.reserve, state.rewards], [START.spend, START.reserve, START.rewards]);
  const primaryNav = page.getByRole('navigation', { name: '주 메뉴' });
  assert.equal(await primaryNav.getByRole('button').count(), 4);
  assert.deepEqual(await primaryNav.getByRole('button').evaluateAll((buttons) => buttons.map((button) => ({ id: button.getAttribute('data-testid'), label: button.innerText.trim() }))), [
    { id: 'nav-home', label: '홈' }, { id: 'nav-card', label: '카드' },
    { id: 'nav-benefits', label: '혜택' }, { id: 'nav-settings', label: '전체' },
  ]);
  assert.equal(await page.getByTestId('nav-wallet').count(), 0, '자산 탭은 없다');
  assert.equal(await page.getByTestId('nav-activity').count(), 1);
  assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');
  assert.match(await page.locator('.sidebar-note').innerText(), /체험판이에요.*이\s브라우저에만 저장돼요/);
  assert.equal(await displayedAmount(page.getByTestId('spend-balance')), START.spend);
  assert.equal(await displayedAmount(page.getByTestId('available-rewards')), START.rewards);
  assert.match(await page.getByTestId('open-reserve-card').innerText(), new RegExp(`${pattern(wonText(START.reserve))}[\\s\\S]*연 ${pattern(percentText(reserveTermsOf(state).rate))}`));
  for (const id of ['available-balance', 'card-cta', 'funding-held', 'home-funding-status']) assert.equal(await page.getByTestId(id).count(), 0, `카드와 진행 중인 입출금이 없으면 ${id}를 보이지 않는다`);
  assert.equal(await page.getByTestId('open-payment').innerText(), '카드 만들기');
  assert.match(await page.locator('.home-card-offer').innerText(), new RegExp(`결제할 때마다 ${pattern(percentText(PLANS.standard.cashbackRate))}를 돌려받아요`));
  await page.getByTestId('open-guide').click();
  const guide = page.getByTestId('dialog-guide');
  assert.match(await guide.innerText(), /코인을 보내면 바로 원화 스테이블 잔액이 되고/);
  await guide.getByTestId('confirm-action').click();
  await guide.waitFor({ state: 'hidden' });
  for (const name of ['card', 'benefits', 'settings', 'activity']) {
    await nav(name);
    assert.equal(await page.getByTestId('open-guide').count(), 0, `체험 안내 버튼은 홈에만 있다 (${name})`);
  }
  await nav('home');
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      family: getComputedStyle(document.body).fontFamily,
      loaded: [...document.fonts].filter((face) => face.family.replace(/["']/g, '') === 'Pretendard Variable' && face.status === 'loaded').length,
    };
  });
  assert.match(font.family, /^["']?Pretendard Variable/, `본문 글꼴: ${font.family}`);
  assert.ok(font.loaded > 0, 'Pretendard Variable 조각을 같은 출처에서 불러온다');
  const offerArt = await page.locator('.home-card-offer img').boundingBox();
  assert.ok(offerArt && offerArt.width >= 240 && offerArt.width <= 300, `데스크톱 홈 카드 안내 이미지 폭: ${offerArt?.width}`);
  await page.getByTestId('open-payment').click();
  await flow().waitFor();
  state = await stateWhen((current) => current.card.stage === 'identity');
  await flow().getByTestId('card-identity-consent').waitFor({ state: 'visible' });
  assert.equal(await flow().getByTestId('card-apply').count(), 0, '카드 만들기를 누르면 소개 화면을 거치지 않고 본인확인을 시작한다');
  assert.equal(await page.getByTestId('nav-card').getAttribute('aria-current'), 'page');
  assert.equal(state.payments.length, 0);
  pass('네 개 주 메뉴(홈·카드·혜택·전체)·Pretendard 글꼴·홈 잔액과 카드 안내·체험 안내는 홈에만·카드 만들기에서 본인확인 바로 시작');

  const beforeNavigation = ledgerSnapshot(await read());
  assert.equal(await page.getByTestId('go-back').count(), 0, '카드는 주 메뉴라 뒤로 가기가 없다');
  await nav('home');
  assert.match(await page.getByTestId('open-payment').innerText(), /신청 이어서 하기/);
  assert.match(await page.getByTestId('card-cta').innerText(), /신청을 이어서 할 수 있어요/);
  await page.getByTestId('card-cta').click();
  await flow().getByTestId('card-identity-consent').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('nav-card').getAttribute('aria-current'), 'page');
  await nav('reserve');
  assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');
  await nav('activity');
  assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');
  await page.getByTestId('go-back').click();
  await page.getByTestId('reserve-principal').waitFor({ state: 'visible' });
  await page.getByTestId('go-back').click();
  await page.getByTestId('open-reserve-card').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('go-back').count(), 0);
  assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');
  await nav('benefits');
  await page.getByTestId('page-benefits').getByRole('button', { name: '리저브 보기', exact: true }).click();
  await page.getByTestId('reserve-principal').waitFor();
  assert.equal(await page.getByTestId('nav-benefits').getAttribute('aria-current'), 'page');
  await page.getByTestId('go-back').click();
  await page.getByTestId('page-benefits').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('nav-benefits').getAttribute('aria-current'), 'page');
  await nav('settings');
  await page.getByTestId('open-limits').click();
  await page.getByTestId('page-limits').waitFor();
  assert.equal(await page.getByTestId('nav-settings').getAttribute('aria-current'), 'page');
  await page.getByTestId('go-back').click();
  await page.getByTestId('open-limits').waitFor({ state: 'visible' });
  assert.deepEqual(ledgerSnapshot(await read()), beforeNavigation);
  await nav('card');
  pass('카드 탭과 리저브·내역·한도 상세의 뒤로 가기가 진입 탭과 원장을 보존');

  assert.equal(await flow().getByTestId('card-identity-next').isDisabled(), true);
  const physicalFee = applicationFee('standard', true);
  const initialSubmit = await finishApplication({ plan: 'standard', physical: true });
  assert.equal(initialSubmit.spend, START.spend - physicalFee, '신청 비용은 잔액에서 낸다');
  assert.equal(await page.getByTestId('card-demo-tools').evaluate((item) => item.open), false);
  await details('card-demo-tools');
  await page.waitForTimeout(1_600);
  assert.equal((await read()).card.stage, 'submitted', '체험 도구를 열면 자동 심사를 일시 정지한다');
  await flow().getByTestId('card-demo-needs-info').click();
  state = await stateWhen((current) => current.card.stage === 'needs_info');
  assert.equal(state.spend, START.spend, '보완 요청으로 돌아온 신청은 낸 비용을 돌려준다');
  await flow().getByTestId('card-resubmit').click();
  const secondSubmit = await finishApplication({ plan: 'standard', physical: true });
  assert.equal(secondSubmit.card.reference, initialSubmit.card.reference);
  assert.equal(secondSubmit.spend, initialSubmit.spend);
  await details('card-demo-tools');
  await flow().getByTestId('card-demo-reject').click();
  state = await stateWhen((current) => current.card.stage === 'rejected');
  assert.equal(state.spend, START.spend, '승인되지 않은 신청은 낸 비용을 돌려준다');
  await flow().getByTestId('card-restart').click();
  await finishApplication({ plan: 'standard', physical: true });
  await flow().getByTestId('card-preparing').waitFor({ state: 'visible' });
  await nav('home');
  assert.match(await page.getByTestId('card-cta').innerText(), /만드는 중이에요/);
  assert.equal(await page.getByTestId('open-payment').innerText(), '진행 상황 보기');
  await page.getByTestId('open-payment').click();
  await flow().getByTestId('card-preparing').waitFor({ state: 'visible' });
  pass('세 화면 신청·필수 동의·스탠다드 실물카드 배송지·접힌 체험 도구·보완·거절·재신청·홈의 진행 상황 보기');

  const stages = ['submitted'];
  await stateWhen((current) => {
    if (stages.at(-1) !== current.card.stage) stages.push(current.card.stage);
    return current.card.stage === 'active';
  });
  assert.deepEqual(stages, ['submitted', 'approved', 'issued', 'active']);
  assert.equal(await flow().getByTestId('card-status').innerText(), '사용 중');
  await details('card-demo-tools');
  assert.equal(await flow().getByTestId('card-demo-billing').count(), 0, '스탠다드는 연회비 갱신일이 없다');
  await flow().getByTestId('card-demo-shipped').click();
  await flow().getByTestId('card-demo-delivered').click();
  await flow().getByTestId('card-physical-activate').click();
  await page.getByTestId('pin-input').fill('1234');
  assert.equal(await page.getByTestId('pin-submit').isDisabled(), true, '이어지는 숫자는 카드 비밀번호로 쓸 수 없다');
  await page.getByTestId('pin-input').fill('2580');
  await page.getByTestId('pin-again').fill('2580');
  await page.getByTestId('pin-submit').click();
  state = await stateWhen((current) => current.card.physicalActive);
  assert.equal(state.spend, START.spend - physicalFee, `스탠다드 실물카드 발급비 ${wonText(physicalFee)}만 잔액에서 낸다`);
  assert.equal(state.card.billingAt, null);
  assert.ok(state.card.pinSet && !JSON.stringify(state).includes('2580'), '카드 비밀번호는 저장하지 않는다');
  assert.equal(state.card.address.road, '서울특별시 중구 아쿠아로 1');
  await flow().getByTestId('card-pin-change').waitFor();
  const desktopCard = await page.locator('.cf-hero .aqua-card-visual.acv-hero').boundingBox();
  assert.ok(desktopCard && desktopCard.width >= 400 && desktopCard.width <= 440, `데스크톱 카드 탭 큰 카드 폭: ${desktopCard?.width}`);
  await page.screenshot({ path: new URL('aqua-card.png', artifacts).pathname, fullPage: true });
  const detailsToggle = flow().getByTestId('card-details-toggle');
  await detailsToggle.click();
  assert.equal(await detailsToggle.getAttribute('aria-pressed'), 'true');
  assert.match(await flow().locator('.cf-demo-details').innerText(), new RegExp(`4242 4242 4242 ${state.card.last4}[\\s\\S]*CVC`));
  await detailsToggle.click();
  assert.equal(await flow().locator('.cf-demo-details').count(), 0, '카드 정보를 다시 숨긴다');
  await flow().getByTestId('card-pin-change').click();
  await page.getByTestId('pin-input').fill('1111');
  assert.equal(await page.getByTestId('pin-submit').isDisabled(), true, '같은 숫자는 카드 비밀번호로 쓸 수 없다');
  await page.getByTestId('pin-input').fill('3691');
  await page.getByTestId('pin-again').fill('3691');
  await page.getByTestId('pin-submit').click();
  await page.getByTestId('pin-sheet').waitFor({ state: 'hidden' });
  assert.ok((await read()).card.pinSet && !JSON.stringify(await read()).includes('3691'), '바꾼 카드 비밀번호도 저장하지 않는다');
  pass('자동 승인·가상 발급·활성화·실물 배송·수령 활성화·카드 탭의 큰 카드·카드 정보 보기·카드 비밀번호 변경');

  await flow().getByTestId('card-lock-toggle').click();
  await stateWhen((current) => current.card.locked);
  assert.match(await flow().getByTestId('card-status').innerText(), /잠금/);
  assert.equal(await flow().getByTestId('card-pay').isDisabled(), true, '잠근 카드는 결제해 보기를 막는다');
  await nav('home');
  assert.match(await page.getByTestId('card-cta').innerText(), /잠겨 있어요/);
  assert.equal(await page.getByTestId('open-payment').innerText(), '잠금 풀기');
  await page.getByTestId('open-payment').click();
  await flow().waitFor();
  assert.equal(await page.getByTestId('dialog-payment').count(), 0);
  assert.equal(await page.getByTestId('nav-card').getAttribute('aria-current'), 'page');
  await flow().getByTestId('card-lock-toggle').click();
  await stateWhen((current) => !current.card.locked);
  await flow().getByTestId('card-pay').click();
  const cardPayment = page.getByTestId('dialog-payment');
  await cardPayment.waitFor({ state: 'visible' });
  assert.match(await cardPayment.innerText(), new RegExp(`${pattern(PLANS.standard.name)}[\\s\\S]*끝번호 ${state.card.last4}`));
  await page.keyboard.press('Escape');
  await cardPayment.waitFor({ state: 'hidden' });
  assert.equal((await read()).payments.length, 0);
  pass('카드 잠금 중 결제 차단·홈의 잠금 풀기 안내·카드 탭의 결제해 보기');

  await nav('home');
  assert.equal(await page.getByTestId('open-payment').innerText(), '결제해 보기');
  const spendBeforePayment = (await read()).spend;
  const bigPayment = 200_000;
  assert.ok(bigPayment > spendBeforePayment + START.rewards, '잔액과 리워드만으로는 모자란 결제');
  assert.equal(await displayedAmount(page.getByTestId('available-balance')), spendBeforePayment + START.rewards, '리저브 결제를 켜기 전에는 잔액과 리워드만 카드로 쓸 수 있다');
  await page.getByTestId('open-payment').click();
  await page.getByTestId('action-amount').fill(String(bigPayment));
  assert.equal(await page.getByTestId('confirm-action').isDisabled(), true);
  assert.match(await page.getByTestId('dialog-payment').innerText(), new RegExp(`${pattern(wonText(bigPayment - spendBeforePayment - START.rewards))}이 모자라요`));
  await page.keyboard.press('Escape');
  await nav('settings');
  await page.getByTestId('reserve-auto').click();
  await stateWhen((current) => current.reserveAuto);
  await nav('home');
  assert.equal(await displayedAmount(page.getByTestId('available-balance')), spendBeforePayment + START.rewards + START.reserve, '리저브 결제를 켜면 리저브까지 카드로 쓸 수 있다');
  await page.getByTestId('open-payment').click();
  await submitAmount('payment', bigPayment);
  state = await stateWhen((current) => current.payments[0]?.status === 'completed');
  const paymentId = state.payments[0].id;
  const fromReserve = bigPayment - START.rewards - spendBeforePayment;
  const bigCashback = paybackOf('standard', bigPayment - START.rewards);
  assert.deepEqual([state.payments[0].fromRewards, state.payments[0].fromSpend, state.payments[0].fromReserve], [START.rewards, spendBeforePayment, fromReserve]);
  assert.equal(state.reserve, START.reserve - fromReserve);
  assert.equal(state.rewards, bigCashback);
  assert.equal(state.monthlyCashback, bigCashback);
  await paymentReceipt({ before: START.rewards, used: START.rewards, cashback: bigCashback, after: bigCashback });
  assert.equal(await displayedAmount(page.getByTestId('available-rewards')), bigCashback);
  await page.getByTestId('open-rewards').click();
  const benefits = page.getByTestId('page-benefits');
  await benefits.waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('nav-benefits').getAttribute('aria-current'), 'page');
  assert.equal(await benefits.getByTestId('cashback-rate').innerText(), percentText(PLANS.standard.cashbackRate));
  assert.equal(await displayedAmount(benefits.getByTestId('reward-balance')), bigCashback);
  assert.equal(await displayedAmount(benefits.getByTestId('cashback-confirmed')), bigCashback);
  assert.equal(await displayedAmount(benefits.getByTestId('cashback-pending')), 0);
  assert.equal(await displayedAmount(benefits.getByTestId('cashback-remaining')), PLANS.standard.cashbackCap - bigCashback);
  pass('잔액 부족·리저브 자동 사용·카드로 쓸 수 있는 돈·결제 영수증 회계·확정 페이백·남은 혜택 한도');

  assert.match(await benefits.innerText(), /받기 버튼 없이 바로 쌓여요.*카드 결제에만 쓸 수 있어요/s);
  assert.equal(await page.getByTestId('claim-rewards').count(), 0, '리저브 보상은 받기 버튼 없이 리워드에 더해진다');
  assert.equal(await page.getByTestId('dialog-rewards').count(), 0, '혜택은 기본 탭의 페이지로 제공');
  await benefits.getByRole('button', { name: '리저브 보기', exact: true }).click();
  const reservePage = page.locator('.reserve-page');
  await reservePage.waitFor();
  assert.equal(await page.getByTestId('nav-benefits').getAttribute('aria-current'), 'page');
  assert.match(await reservePage.innerText(), /보상은 1원이 될\s때마다 리워드에 들어가요/);
  assert.equal(await displayedAmount(page.getByTestId('reserve-principal')), START.reserve - fromReserve);
  assert.match(await page.getByTestId('reserve-accrual').innerText(), /^\+\d/);
  assert.equal(await page.getByTestId('reserve-auto').getAttribute('aria-checked'), 'true', '전체에서 켠 리저브 결제를 리저브 화면에서도 보여준다');
  await page.getByTestId('go-back').click();
  await benefits.waitFor({ state: 'visible' });
  assert.equal(await displayedAmount(benefits.getByTestId('reward-balance')), bigCashback);
  pass('혜택 페이지는 리워드·월 페이백·리저브 보상을 구분하고 상세 복귀를 유지');

  await nav('activity');
  await page.getByRole('button', { name: '한강커피 환불', exact: true }).click();
  await submitAmount('refund', 50_000);
  state = await stateWhen((current) => current.payments[0].refunded === 50_000);
  assert.equal(state.payments[0].status, 'partially_refunded');
  await page.getByRole('button', { name: '한강커피 환불', exact: true }).click();
  await submitAmount('refund', bigPayment - 50_000);
  state = await stateWhen((current) => current.payments[0].status === 'refunded');
  assert.equal(state.payments[0].id, paymentId);
  assert.equal(state.spend, bigPayment - START.rewards, '환불한 원금은 리저브에서 낸 몫까지 잔액으로 돌려준다');
  assert.equal(state.reserve, START.reserve - fromReserve);
  assert.equal(state.rewards, START.rewards);
  assert.equal(state.monthlyCashback, 0);
  pass('부분·전액 환불과 원금·리워드 복원·페이백 조정');

  await nav('home');
  assert.doesNotMatch(await page.locator('.home-page').innerText(), /보유 코인|코인 평가액/, '코인은 보유 자산으로 보이지 않는다');
  const beforeFunding = await read();
  await page.getByTestId('open-deposit').click();
  const fundingDialog = fundingDialogAt();
  await fundingDialog.waitFor({ state: 'visible' });
  assert.deepEqual(await fundingDialog.locator('[data-testid^="funding-asset-"]').evaluateAll((items) => items.map((item) => item.dataset.testid)),
    ['funding-asset-KRWS', 'funding-asset-USDC', 'funding-asset-USDT', 'funding-asset-BTC', 'funding-asset-ETH'], '충전 화면에서 받는 코인을 고른다');
  await fundingRoute({ open: false });
  await fundingDialog.getByTestId('action-amount').fill('10');
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-gross')), 10 * USDC_PRICE);
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-fee')), 0, '입금은 수수료가 없다');
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-net')), 10 * USDC_PRICE);
  assert.match(await fundingDialog.innerText(), /실제 송금 불가/);
  await page.screenshot({ path: new URL('aqua-funding.png', artifacts).pathname, fullPage: true });
  const depositOperation = await requestDeposit(10);
  await settleFunding(depositOperation);
  state = await stateWhen((current) => current.spend === beforeFunding.spend + 10 * USDC_PRICE);
  assert.equal(portfolioOf(state), portfolioOf(beforeFunding) + 10 * USDC_PRICE, '입금한 코인은 원화 스테이블로만 남는다');
  assert.equal(state.reserve, beforeFunding.reserve);
  assert.equal(state.rewards, beforeFunding.rewards);
  assert.equal(state.transactions.find((item) => item.fundingId === depositOperation.id).status, 'completed');
  await closeFunding();
  assert.equal(await displayedAmount(page.getByTestId('spend-balance')), state.spend);
  pass('홈 충전: 받은 코인은 보유하지 않고 확인 즉시 원화 스테이블로 바꿔 잔액에 반영');

  const beforeWithdrawal = await read();
  await page.getByTestId('open-send').click();
  const sendChoice = page.getByTestId('send-sheet');
  await sendChoice.waitFor({ state: 'visible' });
  await sendChoice.getByTestId('send-wallet').click();
  await sendChoice.waitFor({ state: 'hidden' });
  await fundingDialog.waitFor({ state: 'visible' });
  assert.equal(await fundingDialog.getByRole('heading', { level: 2 }).innerText(), '어떤 코인으로 보낼까요?');
  assert.equal(await fundingDialog.getByTestId('funding-origin-domestic').count(), 0, '보내기에는 보내는 곳 선택이 없다');
  await fundingRoute({ mode: 'withdraw', open: false });
  await prepareWithdrawal(10_000);
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-gross')), 10_000);
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-fee')), withdrawalFee(10_000));
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-network-fee')), POLYGON_NETWORK_FEE);
  const expectedNet = 10_000 - withdrawalFee(10_000) - POLYGON_NETWORK_FEE;
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-net')), expectedNet);
  const estimatedUnits = Number((await fundingDialog.getByTestId('quote-units').innerText()).replace(/,/g, ''));
  assert.ok(Math.abs(estimatedUnits - expectedNet / USDC_PRICE) < 1e-8);
  await fundingDialog.getByTestId('confirm-action').click();
  const spendWithdrawal = (await stateWhen((current) => current.fundingOperations.length === beforeWithdrawal.fundingOperations.length + 1)).fundingOperations[0];
  await settleFunding(spendWithdrawal);
  state = await stateWhen((current) => current.spend === beforeWithdrawal.spend - 10_000);
  assert.equal(state.reserve, beforeWithdrawal.reserve);
  assert.equal(state.rewards, beforeWithdrawal.rewards);
  assert.equal(state.transactions[0].amount, -10_000);
  await closeFunding();
  pass('보내기 › 지갑 주소로: 출금 주소·검토·전송·전환 및 네트워크 수수료·예상 수령량·다른 자산 보존');

  await nav('home');
  await page.getByTestId('open-deposit').click();
  await fundingRoute({ symbol: 'KRWS', open: false });
  const beforeHomeDeposit = await read();
  await page.getByTestId('action-amount').focus();
  await page.waitForTimeout(1_200);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'action-amount', '실시간 적립 중에도 금액 입력 초점을 유지');
  const krwsUnits = 20_000;
  await fundingDialog.getByTestId('action-amount').fill(String(krwsUnits));
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-net')), krwsUnits * FUNDING_ASSETS.KRWS.price, '원화 스테이블은 1:1로 잔액이 된다');
  const homeDeposit = await requestDeposit(krwsUnits);
  assert.deepEqual([homeDeposit.symbol, homeDeposit.feeWon, homeDeposit.netWon], ['KRWS', 0, krwsUnits * FUNDING_ASSETS.KRWS.price]);
  await settleFunding(homeDeposit);
  state = await stateWhen((current) => current.spend === beforeHomeDeposit.spend + homeDeposit.netWon);
  await closeFunding();
  pass('원화 스테이블 충전은 수수료 없이 1:1로 잔액에 반영·적립 중 입력 초점 유지');

  const beforeDesignation = await read();
  const priorConversions = beforeDesignation.transactions.filter((item) => item.kind === 'convert').length;
  await nav('reserve');
  await page.getByRole('button', { name: '넣기', exact: true }).click();
  await submitAmount('transfer', 20_000);
  state = await stateWhen((current) => current.reserve === beforeDesignation.reserve + 20_000);
  assert.equal(state.spend, beforeDesignation.spend - 20_000);
  await page.getByRole('button', { name: '빼기', exact: true }).click();
  await submitAmount('transfer', 20_000);
  state = await stateWhen((current) => current.reserve === beforeDesignation.reserve);
  assert.equal(state.spend, beforeDesignation.spend);
  assert.equal(state.rewards, beforeDesignation.rewards);
  assert.equal(state.transactions.filter((item) => item.kind === 'convert').length, priorConversions);
  pass('원화의 리저브 넣기·빼기에는 추가 매도·수수료·코인 변동 없음');

  await nav('settings');
  assert.equal(await page.getByTestId('demo-tools').evaluate((item) => item.open), false);
  await details('demo-tools');
  const earnedSince = (from, to) => to.rewards - from.rewards + to.accrued - from.accrued;
  const dailyReward = (current, baseRate = current.reserveRate) => {
    const { rate, cap } = reserveTermsOf({ ...current, reserveRate: baseRate });
    return Math.min(current.reserve, cap) * rate / 365;
  };
  const beforeDays = await read();
  await page.getByTestId('advance-day').click();
  state = await stateWhen((current) => current.clockOffsetMs === DAY_MS);
  assert.ok(Math.abs(earnedSince(beforeDays, state) - dailyReward(beforeDays)) < 0.1);
  assert.ok(state.rewards >= beforeDays.rewards + Math.floor(dailyReward(beforeDays)), '하루치 보상은 받기 없이 리워드에 더해진다');
  assert.ok(state.accrued < 1);
  const afterFirstDay = state;
  await page.getByTestId('rate-8').click();
  await stateWhen((current) => current.reserveRate === 0.08);
  await page.getByTestId('advance-day').click();
  state = await stateWhen((current) => current.clockOffsetMs === 2 * DAY_MS);
  assert.ok(Math.abs(earnedSince(afterFirstDay, state) - dailyReward(afterFirstDay, 0.08)) < 0.1);
  await nav('benefits');
  assert.equal(await displayedAmount(benefits.getByTestId('reward-balance')), (await read()).rewards);
  const liveNumber = async (testId) => Number((await benefits.getByTestId(testId).locator('..').innerText()).replace(/[^\d.]/g, ''));
  const reserveCredits = (await read()).transactions.filter((item) => item.title === '리저브 보상').reduce((sum, item) => sum + item.amount, 0);
  assert.ok(Math.abs(await liveNumber('reserve-total') - reserveCredits) < 1, '지금까지 쌓인 보상은 리워드에 더한 리저브 보상과 같다');
  assert.match(await page.locator('[aria-labelledby="reward-history-title"]').innerText(), /리저브 보상/, '리저브 보상은 리워드 내역에 날짜별로 남는다');
  await page.screenshot({ path: new URL('aqua-benefits.png', artifacts).pathname, fullPage: true });
  // Nothing is claimed, so the accrual is not a transaction; demo-setting notes are not either.
  const notListed = /리저브 보상|하루 지나기 체험|보상률 변경/;
  await nav('home');
  assert.doesNotMatch(await page.locator('.home-activity').innerText(), notListed, '저절로 쌓이는 보상과 체험 설정 기록은 최근 거래에 없다');
  await nav('activity');
  assert.doesNotMatch(await page.locator('.activity-page').innerText(), notListed, '거래 내역에도 없다');
  await nav('reserve');
  assert.equal(await page.locator('.reserve-live .live-rate').innerText(), `연 ${percentText(reserveTermsOf(await read()).rate)}`);
  await page.screenshot({ path: new URL('aqua-reserve.png', artifacts).pathname, fullPage: true });
  pass('접힌 체험 설정·하루 적립·보상률 변경 구간·받기 없이 리워드에 더해지고 리워드 내역에만 남는 리저브 보상');

  const beforeReload = await read();
  await page.reload({ waitUntil: 'networkidle' });
  state = await stateWhen((current) => current.card.stage === 'active');
  assert.equal(state.spend, beforeReload.spend);
  assert.equal(state.reserve, beforeReload.reserve);
  assert.ok(Math.abs(state.rewards + state.accrued - beforeReload.rewards - beforeReload.accrued) < 0.5, '새로고침 사이에 쌓인 보상만큼만 리워드가 늘어난다');
  assert.equal(state.reserveRate, 0.08);
  assert.equal(state.payments[0].status, 'refunded');
  await nav('home');
  assert.equal(await displayedAmount(page.getByTestId('spend-balance')), state.spend);
  await page.screenshot({ path: new URL('aqua-desktop.png', artifacts).pathname, fullPage: true });
  pass('새로고침 후 카드·거래·잔액 복원');

  const primaryContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const primary = await primaryContext.newPage();
  observe(primary);
  primary.setDefaultTimeout(10_000);
  await primary.goto(base, { waitUntil: 'networkidle' });
  await signUp(primary);
  await nav('card', primary);
  const primaryFlow = primary.locator('.card-flow');
  const tiers = await primaryFlow.locator('.cf-tiers').innerText();
  for (const key of ['standard', 'premium', 'private']) {
    const terms = PLANS[key];
    assert.match(tiers, new RegExp(`${terms.short}[\\s\\S]*?페이백 ${pattern(percentText(terms.cashbackRate))}[\\s\\S]*?${pattern(terms.annualFee ? `연 ${manWon(terms.annualFee)}` : '무료')}`), `${terms.short} 소개`);
  }
  await primary.getByTestId('card-apply').click();
  await primaryFlow.getByTestId('card-identity-consent').check();
  await primaryFlow.getByTestId('card-identity-next').click();
  assert.equal(await primaryFlow.getByRole('radio').count(), 3);
  assert.equal(await primaryFlow.getByRole('radio', { name: PLANS.standard.short }).isChecked(), true, '처음 고른 멤버십은 스탠다드');
  assert.equal(await primaryFlow.getByTestId('card-physical-choice').isChecked(), false, '스탠다드는 가상카드만 받을 수 있다');
  await primaryFlow.getByRole('radio', { name: PLANS.premium.short }).check();
  assert.equal(await primaryFlow.getByTestId('card-physical-choice').count(), 0, '프리미엄은 실물카드 선택지가 없다');
  assert.match(await primaryFlow.locator('.cf-included').innerText(), new RegExp(`${PLANS.premium.card}가 함께 나와요`));
  assert.equal(await primaryFlow.getByTestId('card-selection-next').isDisabled(), true, '프리미엄은 카드를 받을 주소가 있어야 다음으로 간다');
  await primaryFlow.getByTestId('card-address-open').click();
  await chooseAddress(primary, '06100', { detail: '202호' });
  await primaryFlow.getByTestId('card-selection-next').click();
  const startSpend = (await read(primary)).spend;
  const premiumApplicationFee = applicationFee('premium', true);
  assert.equal(await displayedAmount(primaryFlow.getByTestId('card-fee-total')), premiumApplicationFee);
  assert.match(await primaryFlow.locator('.cf-summary').innerText(), new RegExp(`가상카드와 ${PLANS.premium.card}`));
  if (premiumApplicationFee <= startSpend) assert.equal(await primaryFlow.getByTestId('card-fee-shortfall').count(), 0, '잔액으로 낼 수 있으면 부족 안내가 없다');
  await primaryFlow.getByRole('button', { name: '이전', exact: true }).click();
  await primaryFlow.getByRole('radio', { name: PLANS.private.short }).check();
  assert.equal(await primaryFlow.getByTestId('card-physical-choice').count(), 0, '프라이빗은 실물카드 선택지가 없다');
  assert.match(await primaryFlow.locator('.cf-included').innerText(), new RegExp(`${PLANS.private.card}가 함께 나와요`));
  await primaryFlow.getByTestId('card-selection-next').click();
  const privateApplicationFee = applicationFee('private', true);
  const applicationShortfall = privateApplicationFee - startSpend;
  assert.ok(applicationShortfall > 0, '프라이빗 연회비는 시작 잔액보다 커서 부족 안내를 볼 수 있다');
  assert.equal(await displayedAmount(primaryFlow.getByTestId('card-fee-total')), privateApplicationFee);
  assert.match(await primaryFlow.getByTestId('card-fee-shortfall').innerText(), new RegExp(`잔액이 ${pattern(wonText(applicationShortfall))} 모자라요`));
  await primaryFlow.getByTestId('card-review-consent').check();
  assert.equal(await primaryFlow.getByTestId('card-submit').isDisabled(), true, '잔액이 모자라면 신청할 수 없다');
  assert.equal((await read(primary)).card.stage, 'review');
  pass('별도 새 세션: 스탠다드만 실물카드를 고르고 프리미엄·프라이빗은 배송지가 필요하며 신청 확인에 연회비와 부족액을 표시');

  await primaryFlow.getByTestId('card-fee-deposit').click();
  await fundingDialogAt(primary).waitFor({ state: 'visible' });
  const applicationTopUp = Math.ceil(applicationShortfall / 100_000) * 100_000;
  await topUpWithKrws(applicationTopUp, primary);
  assert.equal(await primaryFlow.getByTestId('card-fee-shortfall').count(), 0, '충전하면 부족 안내가 사라진다');
  await primaryFlow.getByTestId('card-review-consent').check();
  await primaryFlow.getByTestId('card-submit').click();
  let primaryState = await stateWhen((current) => current.card.stage === 'active', primary);
  const primarySpend = startSpend + applicationTopUp - privateApplicationFee;
  assert.equal(primaryState.card.plan, 'private');
  assert.equal(primaryState.card.physical, true, `${PLANS.private.card}를 함께 받는다`);
  assert.equal(primaryState.card.delivery, 'preparing');
  assert.equal(primaryState.spend, primarySpend, '첫해 연회비를 잔액에서 낸다');
  assert.equal(primaryState.payments.length, 0);
  assert.equal(primaryState.transactions.find((item) => item.title === '카드 신청 비용').amount, -privateApplicationFee);
  assert.ok(primaryState.card.billingAt > Date.now() + 364 * DAY_MS && primaryState.card.billingAt < Date.now() + 367 * DAY_MS, '1년 뒤 같은 날 갱신한다');
  assert.match(await primary.getByTestId('card-billing-date').innerText(), /^\d{4}년 \d{1,2}월 \d{1,2}일$/);
  assert.match(await primary.getByTestId('card-plan').innerText(), new RegExp(`${PLANS.private.short}\\s+페이백 ${pattern(percentText(PLANS.private.cashbackRate))}\\s+월 ${pattern(wonText(PLANS.private.cashbackCap))}까지\\s+리저브 \\+${pattern(percentText(PLANS.private.reserveBonus))}p`));
  assert.equal(await primary.getByTestId('card-demo-tools').evaluate((item) => item.open), false);
  await details('card-demo-tools', true, primary);
  assert.equal(await primary.getByTestId('card-demo-shipped').count(), 1, `${PLANS.private.card} 배송을 체험할 수 있다`);
  assert.equal(await primary.getByTestId('card-demo-billing').count(), 1, '유료 멤버십은 갱신일 이동을 체험할 수 있다');
  await details('card-demo-tools', false, primary);
  await primary.getByTestId('nav-home').click();
  assert.match(await primary.getByTestId('open-reserve-card').innerText(), new RegExp(`연 ${pattern(percentText(reserveTermsOf(primaryState).rate))}`), '리저브 보상률에 멤버십 추가 보상이 붙는다');
  assert.equal(reserveTermsOf(primaryState).rate, primaryState.reserveRate + PLANS.private.reserveBonus);
  await primary.getByTestId('nav-benefits').click();
  assert.equal(await primary.getByTestId('cashback-rate').innerText(), percentText(PLANS.private.cashbackRate));
  assert.equal(await displayedAmount(primary.getByTestId('cashback-remaining')), PLANS.private.cashbackCap);
  await nav('card', primary);
  pass('신청 화면에서 부족한 연회비를 충전한 뒤 프라이빗 발급·골드 카드 배송·다음 갱신일·리저브와 페이백 혜택 반영');

  await addWallet(primary, 'samsung');
  assert.deepEqual((await read(primary)).card.wallets, ['samsung']);
  await primary.getByTestId('wallet-added-samsung').waitFor();
  await primary.getByTestId('card-lock-toggle').click();
  assert.equal(await primary.getByTestId('wallet-add-apple').isDisabled(), true, '잠긴 카드는 휴대폰에 추가할 수 없다');
  await primary.getByTestId('card-lock-toggle').click();
  assert.equal((await stateWhen((current) => !current.card.locked, primary)).card.locked, false);
  pass('삼성페이 추가는 등록 동의·휴대폰 인증 뒤 저장하고 잠긴 카드는 추가할 수 없음');

  await primary.getByTestId('nav-settings').click();
  assert.match(await primary.locator('[aria-labelledby="settings-account"]').innerText(), /de\*\*@aqua\.example.*010-\*\*\*\*-5678/s, '계정 정보는 가려서 보여준다');
  await primary.getByTestId('sign-out').click();
  await primary.getByTestId('login-submit').waitFor();
  assert.equal(await primary.getByTestId('login-email').inputValue(), 'demo@aqua.example');
  await primary.getByTestId('login-password').fill('wrongpass1');
  await primary.getByTestId('login-submit').click();
  assert.match(await primary.getByRole('alert').innerText(), /비밀번호가 맞지 않아요/);
  await primary.getByTestId('login-forgot').click();
  await primary.getByTestId('reset-send-code').click();
  await primary.getByTestId('reset-code').fill(await sixDigits(primary.getByTestId('reset-demo-code')));
  await primary.getByTestId('reset-password').fill('newpass2026');
  await primary.getByTestId('reset-password-confirm').fill('newpass2026');
  await primary.getByTestId('reset-submit').click();
  await primary.getByTestId('login-password').fill(PASSWORD);
  await primary.getByTestId('login-submit').click();
  assert.match(await primary.getByRole('alert').innerText(), /비밀번호가 맞지 않아요/, '바꾸기 전 비밀번호로는 로그인할 수 없다');
  await primary.getByTestId('login-password').fill('newpass2026');
  await primary.getByTestId('login-submit').click();
  await primary.getByTestId('spend-balance').waitFor();
  const afterLogin = await read(primary);
  assert.equal(afterLogin.signedIn, true);
  assert.equal(afterLogin.card.plan, 'private');
  assert.equal(afterLogin.spend, primarySpend);
  assert.equal(await displayedAmount(primary.getByTestId('spend-balance')), primarySpend);
  assert.ok(!JSON.stringify(afterLogin).includes('newpass2026'), '비밀번호 원문은 저장하지 않는다');
  pass('로그아웃·틀린 비밀번호 거절·이메일 코드로 재설정·새 비밀번호 로그인과 자산 유지');
  await primaryContext.close();

  const rewardContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const rewardPage = await rewardContext.newPage();
  observe(rewardPage);
  rewardPage.setDefaultTimeout(10_000);
  await rewardPage.goto(base, { waitUntil: 'networkidle' });
  await signUp(rewardPage);
  await nav('card', rewardPage);
  await rewardPage.getByTestId('card-apply').click();
  await finishApplication({ plan: 'standard', physical: false }, rewardPage);
  await stateWhen((current) => current.card.stage === 'active', rewardPage);

  async function rewardPayment(amount, expected, screenshot = false) {
    await rewardPage.getByTestId('nav-home').click();
    const before = await read(rewardPage);
    await rewardPage.getByTestId('open-payment').click();
    const dialog = rewardPage.getByTestId('dialog-payment');
    await dialog.getByTestId('action-amount').fill(String(amount));
    await dialog.getByTestId('confirm-action').click();
    await dialog.waitFor({ state: 'hidden' });
    const completed = await stateWhen((current) => current.payments.length === before.payments.length + 1 && current.payments[0].status === 'completed', rewardPage);
    assert.equal(completed.payments[0].fromRewards, expected.used);
    assert.equal(completed.payments[0].cashback, expected.cashback);
    assert.equal(completed.rewards, expected.after);
    await paymentReceipt(expected, rewardPage, screenshot);
    assert.equal(await displayedAmount(rewardPage.getByTestId('available-rewards')), expected.after);
    return completed;
  }
  const repeatedAmount = 5_800;
  let monthCashback = 0;
  const expectPayment = (before, amount, useRewards = true) => {
    const used = useRewards ? Math.min(before, amount) : 0;
    const cashback = paybackOf('standard', amount - used, monthCashback);
    monthCashback += cashback;
    return { before, used, cashback, after: before - used + cashback };
  };
  const repeated = [];
  let rewardsNow = START.rewards;
  do {
    repeated.push(expectPayment(rewardsNow, repeatedAmount));
    rewardsNow = repeated.at(-1).after;
  } while (repeated.at(-1).before !== repeated.at(-1).after && repeated.length < 8);
  const steady = repeated.at(-1);
  assert.equal(steady.before, steady.after, `${wonText(repeatedAmount)}을 반복 결제하면 리워드가 그대로인 지점이 있다`);
  for (const [index, expected] of repeated.entries()) await rewardPayment(repeatedAmount, expected, index === repeated.length - 1);
  pass(`동일 잔액 ${wonText(steady.after)}의 반복 결제도 영수증에서 리워드 사용 −${steady.used}·새 페이백 +${steady.cashback}을 구분`);

  assert.ok(rewardsNow > 30, '리워드만으로 낼 수 있는 결제');
  const rewardsOnly = expectPayment(rewardsNow, 30);
  assert.equal(rewardsOnly.cashback, 0);
  await rewardPayment(30, rewardsOnly);
  rewardsNow = rewardsOnly.after;
  pass('리워드만 사용한 결제는 새 페이백 없이 잔액을 차감');

  await rewardPage.getByTestId('nav-settings').click();
  assert.equal(await rewardPage.getByTestId('rewards-auto').getAttribute('aria-checked'), 'true');
  await rewardPage.getByTestId('rewards-auto').click();
  await stateWhen((current) => !current.rewardsAuto, rewardPage);
  const withoutRewards = expectPayment(rewardsNow, repeatedAmount, false);
  assert.equal(withoutRewards.cashback, paybackOf('standard', repeatedAmount, monthCashback - withoutRewards.cashback), '리워드를 쓰지 않으면 결제액 전체에 페이백이 붙는다');
  await rewardPayment(repeatedAmount, withoutRewards);
  await rewardPage.getByTestId('nav-settings').click();
  assert.equal(await rewardPage.getByTestId('rewards-auto').getAttribute('aria-checked'), 'false');
  await rewardPage.getByTestId('rewards-auto').click();
  await stateWhen((current) => current.rewardsAuto, rewardPage);
  await rewardPayment(repeatedAmount, expectPayment(withoutRewards.after, repeatedAmount));
  await rewardPage.getByTestId('open-rewards').click();
  const rewardBenefits = rewardPage.getByTestId('page-benefits');
  await rewardBenefits.waitFor({ state: 'visible' });
  assert.equal(await displayedAmount(rewardBenefits.getByTestId('cashback-confirmed')), monthCashback);
  assert.equal(await displayedAmount(rewardBenefits.getByTestId('cashback-pending')), 0);
  assert.equal(await displayedAmount(rewardBenefits.getByTestId('cashback-remaining')), PLANS.standard.cashbackCap - monthCashback);
  assert.equal(await rewardBenefits.getByTestId('rewards-auto').getAttribute('aria-checked'), 'true');
  await rewardBenefits.getByTestId('rewards-auto').click();
  await stateWhen((current) => !current.rewardsAuto, rewardPage);
  await rewardPage.getByTestId('nav-settings').click();
  assert.equal(await rewardPage.getByTestId('rewards-auto').getAttribute('aria-checked'), 'false', '혜택 화면의 설정을 전체 설정에서도 공유');
  await rewardPage.getByTestId('rewards-auto').click();
  await stateWhen((current) => current.rewardsAuto, rewardPage);
  await rewardPage.getByTestId('nav-home').click();
  await rewardPage.getByTestId('open-rewards').click();
  await rewardBenefits.waitFor({ state: 'visible' });
  assert.equal(await rewardBenefits.getByTestId('rewards-auto').getAttribute('aria-checked'), 'true', '전체 설정의 변경을 혜택 화면에서도 공유');
  await nav('home', rewardPage);
  pass('리워드 우선 사용 OFF·ON 설정을 결제와 혜택 현황에서 공유');
  await rewardContext.close();

  const sendContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const sendPage = await sendContext.newPage();
  observe(sendPage);
  sendPage.setDefaultTimeout(10_000);
  await sendPage.goto(base, { waitUntil: 'networkidle' });
  await signUp(sendPage);
  const beforeSend = ledgerSnapshot(await read(sendPage));
  await sendPage.getByTestId('open-send').click();
  const sendSheet = sendPage.getByTestId('send-sheet');
  await sendSheet.waitFor({ state: 'visible' });
  assert.match(await sendSheet.innerText(), /Aqua 회원에게[\s\S]*수수료가 없어요[\s\S]*지갑 주소로[\s\S]*네트워크 비용이 들어요/);
  await sendSheet.getByTestId('send-member').click();
  const focusedIn = (check) => sendPage.waitForFunction(check, null, { timeout: 2_000 });
  await focusedIn(() => document.activeElement?.getAttribute('data-testid') === 'send-tag');
  const memberPicks = sendSheet.locator('[data-testid^="send-pick-"]');
  assert.equal(await memberPicks.count(), 5, '체험용 회원 다섯 명');
  assert.match(await sendSheet.getByTestId('send-pick-minji.k').innerText(), /김\*지[\s\S]*@minji\.k/, '받는 사람 이름은 가운데를 가린다');
  const tagInput = sendSheet.getByTestId('send-tag');
  await tagInput.fill('nobody.here');
  assert.equal(await memberPicks.count(), 0);
  await sendSheet.getByRole('button', { name: '@nobody.here 찾기', exact: true }).click();
  assert.match(await sendSheet.getByRole('alert').innerText(), /@nobody\.here 회원을 찾지 못했어요/);
  await tagInput.fill('No!');
  await sendSheet.getByRole('button', { name: /찾기$/ }).click();
  assert.match(await sendSheet.getByRole('alert').innerText(), /태그는 영문 소문자, 숫자, 점\(\.\), 밑줄\(_\)로 3~20자예요/);
  await tagInput.fill('민지');
  assert.deepEqual(await memberPicks.evaluateAll((items) => items.map((item) => item.dataset.testid)), ['send-pick-minji.k'], '이름으로도 찾는다');
  await tagInput.fill('@MINJI.K');
  await tagInput.press('Enter');
  const sendAmount = sendSheet.getByTestId('send-amount');
  await sendAmount.waitFor({ state: 'visible' });
  await focusedIn(() => document.activeElement?.getAttribute('data-testid') === 'send-amount');
  assert.match(await sendSheet.innerText(), /김\*지[\s\S]*@minji\.k[\s\S]*보낼 수 있는 금액[\s\S]*128,500원/);
  await sendAmount.fill(String(START.spend + 1));
  assert.match(await sendSheet.getByRole('alert').innerText(), /잔액보다 많이 보낼 수 없어요/);
  assert.equal(await sendSheet.getByTestId('send-next').isDisabled(), true);
  await sendAmount.fill(String(POLICY.minimumTopup - 1));
  assert.match(await sendSheet.getByRole('alert').innerText(), /1,000원 이상 원 단위로 넣어 주세요/);
  assert.equal(await sendSheet.getByTestId('send-next').isDisabled(), true);
  await sendAmount.fill('30000');
  await sendSheet.getByTestId('send-next').click();
  // Each later step moves focus to its heading inside the sheet, never back to the page behind it.
  await focusedIn(() => document.activeElement?.tagName === 'H2' && Boolean(document.activeElement.closest('[data-testid="send-sheet"]')));
  assert.equal(await displayedAmount(sendSheet.getByTestId('send-review-amount')), 30_000);
  assert.match(await sendSheet.innerText(), new RegExp(`수수료\\s*0원[\\s\\S]*보낸 뒤 잔액\\s*${pattern(wonText(START.spend - 30_000))}`));
  assert.deepEqual(ledgerSnapshot(await read(sendPage)), beforeSend, '검토 단계에서는 보내지 않는다');
  await sendSheet.getByRole('button', { name: '이전', exact: true }).click();
  assert.equal(await sendAmount.inputValue(), '30,000', '금액 단계로 돌아가도 입력값을 유지한다');
  await sendSheet.getByRole('button', { name: '창 닫기', exact: true }).click();
  await sendSheet.waitFor({ state: 'hidden' });
  assert.deepEqual(ledgerSnapshot(await read(sendPage)), beforeSend, '닫으면 아무것도 보내지 않는다');
  pass('회원 보내기는 없는 태그·형식 오류를 알리고 잔액 초과·최소 금액을 막으며 검토 단계까지 원장을 바꾸지 않는다');

  await sendPage.getByTestId('open-send').click();
  await sendSheet.getByTestId('send-member').click();
  await sendSheet.getByTestId('send-pick-minji.k').click();
  await sendAmount.fill('30000');
  await sendSheet.getByTestId('send-next').click();
  await sendSheet.getByTestId('send-confirm').click();
  const sendDone = sendSheet.getByTestId('send-done');
  await sendDone.waitFor({ state: 'visible' });
  await focusedIn(() => document.activeElement?.tagName === 'H2' && document.activeElement.textContent === '보냈어요');
  let sendState = await stateWhen((current) => current.spend === START.spend - 30_000, sendPage);
  assert.deepEqual([sendState.reserve, sendState.rewards, sendState.fundingOperations.length], [START.reserve, START.rewards, 0], '회원 보내기는 수수료·입출금 요청 없이 바로 끝난다');
  const sent = sendState.transactions[0];
  assert.deepEqual([sent.kind, sent.title, sent.amount, sent.status], ['transfer', '김*지님에게 보냄', -30_000, 'completed']);
  assert.match(await sendDone.innerText(), new RegExp(`김\\*지님에게 보냈어요[\\s\\S]*30,000원[\\s\\S]*@minji\\.k[\\s\\S]*${pattern(wonText(sendState.spend))}`));
  await sendSheet.getByTestId('send-close').click();
  await sendSheet.waitFor({ state: 'hidden' });
  assert.equal(await displayedAmount(sendPage.getByTestId('spend-balance')), START.spend - 30_000);
  assert.match(await sendPage.locator('.home-activity').innerText(), /김\*지님에게 보냄[\s\S]*−30,000원/);
  await nav('activity', sendPage);
  const filters = sendPage.locator('.activity-page .segmented');
  await filters.getByRole('button', { name: '카드', exact: true }).click();
  assert.match(await sendPage.locator('.activity-page').innerText(), /카드로 결제한 내역이 없어요/);
  await filters.getByRole('button', { name: '입출금', exact: true }).click();
  assert.match(await sendPage.locator('.activity-page').innerText(), /김\*지님에게 보냄/);
  await sendPage.getByTestId(`tx-detail-${sent.id}`).click();
  const sentSheet = sendPage.getByTestId('transaction-sheet');
  await sentSheet.waitFor({ state: 'visible' });
  assert.match(await sentSheet.innerText(), /보내기 ·[\s\S]*완료[\s\S]*@minji\.k에게 수수료 없이 바로 보냈어요/);
  assert.equal(await sentSheet.getByTestId('transaction-amount').innerText(), '−30,000원');
  await sendPage.keyboard.press('Escape');
  await sentSheet.waitFor({ state: 'hidden' });
  await filters.getByRole('button', { name: '전체', exact: true }).click();
  pass('회원에게 수수료 없이 바로 보내고 잔액·최근 거래·거래 내역 필터·상세에 반영');

  await nav('home', sendPage);
  const beforeLookups = ledgerSnapshot(await read(sendPage));
  let tagState = await read(sendPage);
  await sendPage.getByTestId('open-send').click();
  await sendSheet.waitFor({ state: 'visible' });
  assert.match(await sendSheet.getByTestId('send-own-tag').innerText(), new RegExp(`내 태그 @${pattern(tagState.account.tag)}`));
  await sendSheet.getByTestId('send-own-qr').click();
  const receiveSheet = sendPage.getByTestId('receive-sheet');
  await receiveSheet.waitFor({ state: 'visible' });
  await sendSheet.waitFor({ state: 'hidden' });
  assert.equal(await receiveSheet.getByTestId('receive-tag').innerText(), `@${tagState.account.tag}`);
  assert.equal(await receiveSheet.locator('svg.qr-code path').count(), 1, '내 태그 QR을 그린다');
  assert.equal(await receiveSheet.getByTestId('find-by-phone').getAttribute('aria-checked'), 'false', '휴대폰 번호로 찾기는 꺼진 채 시작한다');
  await receiveSheet.getByTestId('receive-edit').click();
  await focusedIn(() => document.activeElement?.getAttribute('data-testid') === 'tag-input');
  const newTag = receiveSheet.getByTestId('tag-input');
  await newTag.fill('junho');
  assert.match(await receiveSheet.getByTestId('tag-issue').innerText(), /이미 누가 쓰고 있는 태그예요/);
  assert.equal(await receiveSheet.getByTestId('tag-save').isDisabled(), true);
  await newTag.fill('.aqua');
  assert.match(await receiveSheet.getByTestId('tag-issue').innerText(), /맨 앞과 맨 끝/);
  await newTag.fill('aqua.tester');
  await receiveSheet.getByTestId('tag-available').waitFor();
  await receiveSheet.getByTestId('tag-save').click();
  await receiveSheet.getByTestId('receive-tag').waitFor();
  assert.equal(await receiveSheet.getByTestId('receive-tag').innerText(), '@aqua.tester');
  assert.equal(await receiveSheet.getByTestId('find-by-email').getAttribute('aria-checked'), 'false', '이메일로 찾기도 꺼진 채 시작한다');
  await receiveSheet.getByTestId('find-by-phone').click();
  await receiveSheet.getByTestId('find-by-email').click();
  tagState = await stateWhen((current) => current.account.tag === 'aqua.tester' && current.account.findByPhone && current.account.findByEmail, sendPage);
  assert.deepEqual(ledgerSnapshot(tagState), beforeLookups, '태그와 찾기 설정은 잔액과 내역을 바꾸지 않는다');
  await receiveSheet.getByRole('button', { name: '창 닫기', exact: true }).click();
  await receiveSheet.waitFor({ state: 'hidden' });

  await sendPage.getByTestId('open-send').click();
  assert.match(await sendSheet.getByTestId('send-own-tag').innerText(), /@aqua\.tester/);
  await sendSheet.getByTestId('send-member').click();
  await tagInput.fill('010-0000-01');
  assert.equal(await memberPicks.count(), 0, '번호 일부로는 회원 목록을 보여 주지 않는다');
  assert.match(await sendSheet.getByTestId('send-phone-hint').innerText(), /끝까지 넣어야/);
  await sendSheet.getByTestId('send-find').click();
  assert.match(await sendSheet.getByRole('alert').innerText(), /휴대폰 번호를 끝까지 넣어 주세요/);
  await tagInput.fill('010-0000-0103');
  await sendSheet.getByTestId('send-find').click();
  assert.match(await sendSheet.getByRole('alert').innerText(), /이 번호로 찾을\s수 있는 회원이 없어요/, '번호로 찾기를 끈 회원은 나오지 않는다');
  await tagInput.fill(tagState.account.phone);
  await sendSheet.getByTestId('send-find').click();
  assert.match(await sendSheet.getByRole('alert').innerText(), /내 번호예요/);
  await tagInput.fill('aqua.tester');
  await sendSheet.getByTestId('send-find').click();
  assert.match(await sendSheet.getByRole('alert').innerText(), /내 태그예요/);
  await tagInput.fill('minji.kim@aqua');
  assert.equal(await memberPicks.count(), 0, '이메일 일부로는 회원 목록을 보여 주지 않는다');
  assert.match(await sendSheet.getByTestId('send-email-hint').innerText(), /이메일 주소는 끝까지 넣어야/);
  await sendSheet.getByTestId('send-find').click();
  assert.match(await sendSheet.getByRole('alert').innerText(), /이메일 주소를 끝까지 넣어 주세요/);
  await tagInput.fill('junho@aqua.example');
  await sendSheet.getByTestId('send-find').click();
  assert.match(await sendSheet.getByRole('alert').innerText(), /이 이메일로 찾을\s수 있는 회원이 없어요/, '이메일로 찾기를 끈 회원은 나오지 않는다');
  await tagInput.fill(tagState.account.email);
  await sendSheet.getByTestId('send-find').click();
  assert.match(await sendSheet.getByRole('alert').innerText(), /내 이메일이에요/);
  await tagInput.fill('Minji.Kim@aqua.example');
  await sendSheet.getByTestId('send-find').click();
  await sendAmount.waitFor({ state: 'visible' });
  assert.match(await sendSheet.locator('.send-to').innerText(), /김\*지[\s\S]*@minji\.k · 이메일로 찾음/);
  await sendSheet.getByRole('button', { name: '이전', exact: true }).click();
  await tagInput.fill('010-0000-0101');
  await sendSheet.getByTestId('send-find').click();
  await sendAmount.waitFor({ state: 'visible' });
  assert.match(await sendSheet.locator('.send-to').innerText(), /김\*지[\s\S]*@minji\.k · 휴대폰 번호로 찾음/);
  await sendSheet.getByRole('button', { name: '이전', exact: true }).click();
  await focusedIn(() => document.activeElement?.getAttribute('data-testid') === 'send-tag');
  await sendSheet.getByRole('button', { name: '이전', exact: true }).click();
  await sendSheet.getByTestId('send-scan').click();
  const scanStep = sendSheet.getByTestId('send-scan-step');
  await scanStep.waitFor({ state: 'visible' });
  assert.match(await scanStep.innerText(), /체험판은 카메라를 켜지 않으니/);
  assert.equal(await scanStep.locator('svg.qr-code').count(), 4, '체험용 QR 네 개');
  await sendSheet.getByTestId('send-scan-junho').click();
  await sendAmount.waitFor({ state: 'visible' });
  assert.match(await sendSheet.locator('.send-to').innerText(), /박\*호[\s\S]*@junho · QR로 찾음/);
  await sendSheet.getByRole('button', { name: '이전', exact: true }).click();
  await scanStep.waitFor({ state: 'visible' });
  await sendSheet.getByRole('button', { name: '창 닫기', exact: true }).click();
  await sendSheet.waitFor({ state: 'hidden' });
  assert.deepEqual(ledgerSnapshot(await read(sendPage)), beforeLookups, '찾기만 하고 닫으면 아무것도 보내지 않는다');
  await nav('settings', sendPage);
  assert.match(await sendPage.getByTestId('open-receive').innerText(), /내 태그와 QR[\s\S]*태그·QR·휴대폰 번호·이메일로 받아요[\s\S]*@aqua\.tester/);
  assert.match(await sendPage.getByTestId('own-tag').innerText(), /^@aqua\.tester · /);
  pass('내 태그와 QR·태그 바꾸기(중복·규칙 안내)·휴대폰 번호와 이메일로 찾기 허용·번호와 이메일 전체로만 찾는 회원 찾기·체험용 QR 찍기');

  const RECEIVED = 10_000;
  await sendPage.getByTestId('open-receive').click();
  await receiveSheet.waitFor({ state: 'visible' });
  assert.match(await receiveSheet.getByTestId('receive-demo').locator('..').innerText(), /김\*지님이 내 태그로 10,000원을 보낸 것처럼 받아요/);
  await receiveSheet.getByTestId('receive-demo').click();
  await receiveSheet.waitFor({ state: 'hidden' });
  assert.match(await sendPage.locator('.toast').innerText(), /김\*지님이 10,000원을 보냈어요/, '받은 돈은 알림으로 알려 준다');
  const receivedState = await stateWhen((current) => current.spend === beforeLookups.spend + RECEIVED, sendPage);
  const receivedEntry = receivedState.transactions[0];
  assert.deepEqual([receivedEntry.kind, receivedEntry.title, receivedEntry.amount, receivedEntry.member], ['transfer', '김*지님이 보냄', RECEIVED, 'minji.k']);
  assert.deepEqual([receivedState.reserve, receivedState.rewards, receivedState.fundingOperations.length], [beforeLookups.reserve, beforeLookups.rewards, 0]);
  await nav('activity', sendPage);
  assert.match(await sendPage.locator('.activity-page').innerText(), /김\*지님이 보냄[\s\S]*\+10,000원/);
  await sendPage.getByTestId(`tx-detail-${receivedEntry.id}`).click();
  await sentSheet.waitFor({ state: 'visible' });
  assert.match(await sentSheet.innerText(), /받기 ·[\s\S]*@minji\.k님이 내 태그 @aqua\.tester로 보냈어요/);
  await sendPage.keyboard.press('Escape');
  await sentSheet.waitFor({ state: 'hidden' });
  pass('회원에게 받기 체험: 잔액에 바로 더하고 받은 돈 알림·거래 내역의 받기·상세에 반영');

  await sendContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
  await sendPage.getByTestId('open-statement').click();
  const statementPage = sendPage.getByTestId('page-statement');
  await statementPage.waitFor({ state: 'visible' });
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(Date.now());
  assert.match(await statementPage.innerText(), new RegExp(`${year}년에 들어온 돈`));
  assert.equal(await statementPage.getByTestId('statement-deposits').innerText(), '없음');
  assert.equal(await statementPage.getByTestId('statement-received').innerText(), '1건 · 10,000원');
  assert.equal(await statementPage.getByTestId('statement-sent').innerText(), '1건 · 30,000원');
  assert.equal(await statementPage.getByTestId('statement-card').innerText(), '없음');
  assert.match(await statementPage.innerText(), /코인을 원화 스테이블로 바꾼 충전은 가상자산을 판 것으로 볼\s수 있어요/);
  await statementPage.getByTestId('statement-copy').click();
  await statementPage.getByText('2건을 복사했어요.').waitFor();
  const copiedRows = (await sendPage.evaluate(() => navigator.clipboard.readText())).split('\n').map((line) => line.split('\t'));
  assert.deepEqual(copiedRows[0], ['일시', '구분', '내용', '금액(원)', '상태', '코인', '수량', '상대', '메모']);
  assert.deepEqual(copiedRows.slice(1).map((row) => [row[1], row[2], row[3], row[7]]),
    [['회원에게 보내기', '김*지님에게 보냄', '-30000', '@minji.k'], ['회원에게 받기', '김*지님이 보냄', '10000', '@minji.k']], '오래된 거래부터 탭으로 나눠 복사한다');
  await sendPage.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('blocked')); });
  await statementPage.getByTestId('statement-copy').click();
  const statementTextArea = statementPage.getByTestId('statement-text');
  await statementTextArea.waitFor({ state: 'visible' });
  assert.match(await statementPage.getByRole('alert').innerText(), /복사하지 못했어요/);
  assert.equal((await statementTextArea.inputValue()).split('\n').length, 3, '복사가 막히면 직접 고를 수 있게 같은 내용을 보여 준다');
  await sendPage.getByTestId('go-back').click();
  await sendPage.locator('.activity-page').waitFor();
  await nav('settings', sendPage);
  await sendPage.getByTestId('settings-statement').click();
  await statementPage.waitFor({ state: 'visible' });
  pass('연간 거래 내역: 보내기·받기 요약, 세금 신고 안내, 탭으로 나눈 내역 복사와 복사가 막혔을 때 직접 고르기');

  await nav('settings', sendPage);
  await details('demo-tools', true, sendPage);
  await sendPage.getByTestId('rate-3').click();
  await stateWhen((current) => current.reserveRate === 0.03, sendPage);
  assert.equal(await sendPage.getByTestId('rate-3').getAttribute('aria-pressed'), 'true');
  assert.equal(await sendPage.getByTestId('rate-5').getAttribute('aria-pressed'), 'false');
  await sendPage.getByTestId('nav-home').click();
  assert.match(await sendPage.getByTestId('open-reserve-card').innerText(), new RegExp(`연 ${pattern(percentText(0.03 + PLANS.standard.reserveBonus))}`));
  await nav('settings', sendPage);
  await details('demo-tools', true, sendPage);
  await sendPage.getByTestId('rate-5').click();
  await stateWhen((current) => current.reserveRate === 0.05, sendPage);
  await sendPage.getByTestId('reset-demo').click();
  const resetDialog = sendPage.getByTestId('dialog-reset');
  await resetDialog.waitFor({ state: 'visible' });
  assert.match(await resetDialog.innerText(), /잔액, 카드 신청, 거래 내역을 처음 상태로 돌려요/);
  await resetDialog.getByRole('button', { name: '취소', exact: true }).click();
  await resetDialog.waitFor({ state: 'hidden' });
  assert.equal((await read(sendPage)).spend, START.spend - 30_000 + RECEIVED, '취소하면 되돌리지 않는다');
  await sendPage.getByTestId('reset-demo').click();
  await resetDialog.getByTestId('confirm-action').click();
  await sendPage.getByTestId('auth-signup').waitFor({ state: 'visible' });
  const resetState = await stateWhen((current) => current.account === null, sendPage);
  assert.deepEqual([resetState.signedIn, resetState.spend, resetState.reserve, resetState.rewards, resetState.transactions.length, resetState.card.stage, resetState.reserveRate],
    [false, START.spend, START.reserve, START.rewards, 0, 'not_applied', POLICY.reserveAnnualRate]);
  pass('체험 설정의 기본 보상률 3·5% 전환과 처음으로 되돌리기(취소 가능)는 잔액·내역·계정을 지우고 가입 화면으로 돌아간다');
  await sendContext.close();

  const movementContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const movementPage = await movementContext.newPage();
  observe(movementPage);
  movementPage.setDefaultTimeout(10_000);
  await movementPage.clock.setFixedTime(Date.now());
  await movementPage.goto(base, { waitUntil: 'networkidle' });
  await signUp(movementPage);
  await openFunding('withdraw', movementPage);
  const movementDialog = fundingDialogAt(movementPage);
  await movementDialog.getByTestId('funding-asset-USDC').click();
  await movementDialog.getByTestId('funding-network-ethereum').click();
  await movementDialog.getByTestId('funding-asset-USDT').click();
  assert.equal(await movementDialog.getByTestId('funding-network-polygon').count(), 0, 'USDT에는 Polygon을 제공하지 않는다');
  assert.equal(await movementDialog.getByTestId('funding-network-ethereum').getAttribute('aria-pressed'), 'true');
  await movementDialog.getByTestId('funding-asset-BTC').click();
  assert.equal(await movementDialog.getByTestId('funding-network-ethereum').count(), 0, 'BTC로 바꾸면 EVM 네트워크 선택을 유지하지 않는다');
  assert.equal(await movementDialog.getByTestId('funding-network-bitcoin').getAttribute('aria-pressed'), 'true');
  await movementDialog.getByTestId('funding-asset-USDC').click();
  await movementDialog.getByTestId('funding-network-polygon').click();
  await movementDialog.getByTestId('funding-next').click();
  const beforeInvalidRequest = ledgerSnapshot(await read(movementPage));
  await movementDialog.getByTestId('action-amount').fill('10000');
  await movementDialog.getByTestId('funding-recipient').fill('내 체험 지갑');
  for (const address of ['', 'wrong-address', `0x${'0'.repeat(40)}`, 'aqua-preview:ethereum:usdc']) {
    await movementDialog.getByTestId('funding-address').fill(address);
    await movementDialog.getByTestId('funding-next').click();
    await movementDialog.getByTestId('funding-address').waitFor({ state: 'visible' });
    assert.match((await movementDialog.getByRole('alert').allTextContents()).join(' '), /주소/, `유효하지 않은 주소: ${address || '빈 값'}`);
    assert.deepEqual(ledgerSnapshot(await read(movementPage)), beforeInvalidRequest);
  }
  await movementDialog.locator('form').evaluate((form) => form.requestSubmit());
  assert.deepEqual(ledgerSnapshot(await read(movementPage)), beforeInvalidRequest);
  await movementDialog.getByTestId('funding-preview-address').click();
  assert.equal(await movementDialog.getByTestId('funding-address').inputValue(), 'aqua-preview:polygon:usdc');
  await movementDialog.getByTestId('funding-next').click();
  await movementDialog.getByTestId('funding-consent').waitFor({ state: 'visible' });
  assert.equal(await movementDialog.getByTestId('confirm-action').isDisabled(), true, '출금 최종 확인에 동의하기 전에는 접수하지 않는다');
  await movementDialog.getByTestId('funding-consent').check();
  await movementDialog.locator('form').evaluate((form) => form.requestSubmit());
  assert.match((await movementDialog.getByRole('alert').allTextContents()).join(' '), /이메일 인증/, '이메일 인증 없이 강제로 제출해도 출금을 접수하지 않는다');
  assert.deepEqual(ledgerSnapshot(await read(movementPage)), beforeInvalidRequest);
  await closeFunding(movementPage);
  pass('지원 코인별 네트워크 선택 재설정·빈/잘못된/다른 네트워크 주소 차단');

  await fundingRoute({ target: movementPage });
  assert.equal(await movementDialog.getByTestId('confirm-action').count(), 0, '입금 수량의 견적을 확인한 뒤 접수할 수 있다');
  await movementDialog.getByTestId('action-amount').fill('0.1');
  await movementDialog.getByTestId('funding-consent').check();
  await movementDialog.getByTestId('funding-next').click();
  assert.equal(await movementDialog.getByTestId('confirm-action').count(), 0, '1,000원 미만의 입금 평가액은 접수하지 않는다');
  assert.match((await movementDialog.getByRole('alert').allTextContents()).join(' '), /최소 1,000원/);
  assert.deepEqual(ledgerSnapshot(await read(movementPage)), beforeInvalidRequest);
  await movementDialog.getByTestId('action-amount').fill('10');
  const pendingDeposit = await requestDeposit(10, movementPage);
  const beforePendingReload = await read(movementPage);
  await closeFunding(movementPage);
  const homeStatus = movementPage.getByTestId('home-funding-status');
  assert.match(await homeStatus.innerText(), /USDC 입금 · 입금 대기/);
  await movementPage.reload({ waitUntil: 'networkidle' });
  await homeStatus.click();
  await movementDialog.waitFor({ state: 'visible' });
  assert.equal(await movementDialog.getByTestId('funding-status').getAttribute('data-status'), 'awaiting_deposit');
  const restoredPending = await read(movementPage);
  assert.equal(restoredPending.fundingOperations.length, 1);
  assert.equal(restoredPending.fundingOperations[0].id, pendingDeposit.id);
  assert.equal(restoredPending.fundingOperations[0].requestId, pendingDeposit.requestId);
  assert.equal(restoredPending.fundingOperations[0].address, pendingDeposit.address);
  assert.equal(restoredPending.spend, beforePendingReload.spend);
  assert.equal(restoredPending.fundingOperations[0].status, 'awaiting_deposit');
  assert.equal(await movementDialog.getByTestId('funding-simulate-deposit').count(), 1);
  pass('입금 최소 금액·필수 동의와 대기 요청의 닫기·새로고침·홈 상태 줄로 다시 열기');

  await movementDialog.getByTestId('funding-simulate-deposit').click();
  await operationWhen(pendingDeposit.id, 'confirming', movementPage);
  assert.equal((await read(movementPage)).spend, beforePendingReload.spend);
  await closeFunding(movementPage);
  await movementPage.reload({ waitUntil: 'networkidle' });
  await reopenFunding(pendingDeposit.id, movementPage);
  await advanceFundingClock(pendingDeposit.id, 'converting', movementPage);
  assert.equal((await read(movementPage)).spend, beforePendingReload.spend, '원화 전환 중인 입금은 미확정 잔액이다');
  const completedDeposit = await advanceFundingClock(pendingDeposit.id, 'completed', movementPage);
  assert.equal(completedDeposit.netWon, 10 * USDC_PRICE);
  assert.equal((await read(movementPage)).spend, beforePendingReload.spend + 10 * USDC_PRICE);
  await closeFunding(movementPage);
  await movementPage.reload({ waitUntil: 'networkidle' });
  const restoredCompleted = await read(movementPage);
  assert.equal(restoredCompleted.spend, beforePendingReload.spend + 10 * USDC_PRICE);
  assert.equal(restoredCompleted.fundingOperations.length, 1);
  assert.equal(restoredCompleted.transactions.filter((item) => item.fundingId === pendingDeposit.id).length, 1);
  assert.equal(await movementPage.getByTestId('home-funding-status').count(), 0, '끝난 요청은 홈 상태 줄에서 사라진다');
  pass('확인 중 입금을 거래 내역에서 재개·전환 완료에만 원화 한 번 반영·완료 후 재로딩 멱등성');

  const beforeHeldWithdrawal = await read(movementPage);
  const heldAmount = beforeHeldWithdrawal.spend - 5_000;
  await fundingRoute({ mode: 'withdraw', target: movementPage });
  const heldWithdrawal = await requestWithdrawal(heldAmount, movementPage);
  assert.equal((await read(movementPage)).spend, 5_000);
  await closeFunding(movementPage);
  assert.equal(await displayedAmount(movementPage.getByTestId('spend-balance')), 5_000);
  assert.equal(await displayedAmount(movementPage.getByTestId('funding-held')), heldAmount);
  assert.match(await homeStatus.innerText(), /USDC 출금 · 출금 검토 중/);
  await movementPage.reload({ waitUntil: 'networkidle' });
  assert.equal(await displayedAmount(movementPage.getByTestId('spend-balance')), 5_000);
  assert.equal(await displayedAmount(movementPage.getByTestId('funding-held')), heldAmount);
  await fundingRoute({ mode: 'withdraw', target: movementPage });
  await movementDialog.getByTestId('action-amount').fill('10000');
  await movementDialog.getByTestId('funding-recipient').fill('내 체험 지갑');
  await movementDialog.getByTestId('funding-preview-address').click();
  await movementDialog.getByTestId('funding-next').click();
  await movementDialog.getByTestId('action-amount').waitFor({ state: 'visible' });
  assert.match((await movementDialog.getByRole('alert').allTextContents()).join(' '), /잔액이 부족해요/);
  await movementDialog.locator('form').evaluate((form) => form.requestSubmit());
  assert.equal((await read(movementPage)).fundingOperations.length, 2, '보류 중인 원금을 다른 출금에서 다시 사용할 수 없다');
  assert.equal((await read(movementPage)).spend, 5_000);
  await closeFunding(movementPage);
  pass('출금 원금 보류액과 사용 가능 잔액을 구분·재로딩 유지·중복 사용 차단');

  await fundingRoute({ target: movementPage });
  const extraDeposit = await requestDeposit(10, movementPage);
  await closeFunding(movementPage);
  assert.match(await homeStatus.innerText(), /처리 중인 입출금 2건/);
  await homeStatus.click();
  await movementPage.locator('.activity-page').waitFor();
  assert.equal(await movementPage.locator('.page-heading h1').innerText(), '거래 내역');
  assert.equal(await movementPage.getByTestId('nav-home').getAttribute('aria-current'), 'page');
  assert.equal(await movementPage.getByTestId(`funding-open-${heldWithdrawal.id}`).count(), 1);
  await movementPage.getByTestId(`funding-open-${extraDeposit.id}`).click();
  await movementDialog.getByTestId('funding-cancel').click();
  await operationWhen(extraDeposit.id, 'cancelled', movementPage);
  await closeFunding(movementPage);
  await movementPage.getByTestId('go-back').click();
  assert.match(await homeStatus.innerText(), /USDC 출금 · 출금 검토 중/);
  await homeStatus.click();
  await movementDialog.waitFor({ state: 'visible' });
  assert.equal(await movementDialog.getByTestId('funding-status').getAttribute('data-status'), 'reviewing');
  assert.match(await movementDialog.innerText(), new RegExp(`보내는 동안 ${pattern(wonText(heldAmount))}은 쓸 수 없어요`));
  await closeFunding(movementPage);
  assert.equal((await read(movementPage)).spend, 5_000);
  pass('처리 중인 요청이 두 건이면 홈 상태 줄이 거래 내역으로, 한 건이면 그 요청으로 바로 연다');

  await reopenFunding(heldWithdrawal.id, movementPage);
  await movementDialog.getByTestId('funding-cancel').click();
  await operationWhen(heldWithdrawal.id, 'cancelled', movementPage);
  const cancelledState = await read(movementPage);
  assert.equal(cancelledState.spend, beforeHeldWithdrawal.spend, '출금 취소는 수수료를 포함한 전체 원금을 돌려준다');
  assert.equal(cancelledState.reserve, beforeHeldWithdrawal.reserve);
  assert.equal(cancelledState.rewards, beforeHeldWithdrawal.rewards);
  await closeFunding(movementPage);
  await movementPage.getByTestId('nav-home').click();
  assert.equal(await movementPage.getByTestId('funding-held').count(), 0);
  assert.equal(await homeStatus.count(), 0);
  await reopenFunding(heldWithdrawal.id, movementPage);
  const operationsBeforeRetry = cancelledState.fundingOperations.length;
  await movementDialog.getByTestId('funding-retry').click();
  assert.equal((await read(movementPage)).fundingOperations.length, operationsBeforeRetry, '재시도 버튼만 누른 시점에는 새 출금을 접수하지 않는다');
  await fundingRoute({ mode: 'withdraw', target: movementPage, open: false });
  const retryWithdrawal = await requestWithdrawal(10_000, movementPage);
  assert.equal(retryWithdrawal.retryOf, heldWithdrawal.id);
  assert.notEqual(retryWithdrawal.requestId, heldWithdrawal.requestId);
  assert.equal((await read(movementPage)).fundingOperations.find((item) => item.id === heldWithdrawal.id).status, 'cancelled');
  await advanceFundingClock(retryWithdrawal.id, 'broadcasting', movementPage);
  assert.equal(await movementDialog.getByTestId('funding-cancel').count(), 0, '전송 시작 후에는 취소를 제공하지 않는다');
  await advanceFundingClock(retryWithdrawal.id, 'completed', movementPage);
  assert.equal((await read(movementPage)).spend, beforeHeldWithdrawal.spend - 10_000);
  await closeFunding(movementPage);
  pass('검토 중 취소는 원금 전액 복구·새 요청으로 재시도·전송 후 취소 제한');

  const beforeFailedWithdrawal = await read(movementPage);
  await fundingRoute({ mode: 'withdraw', target: movementPage });
  const failedWithdrawal = await requestWithdrawal(20_000, movementPage, 'failure');
  assert.equal((await read(movementPage)).spend, beforeFailedWithdrawal.spend - 20_000);
  await advanceFundingClock(failedWithdrawal.id, 'failed', movementPage);
  const afterFailedWithdrawal = await read(movementPage);
  assert.equal(afterFailedWithdrawal.spend, beforeFailedWithdrawal.spend, '실패한 출금은 전환·네트워크 수수료를 공제하지 않는다');
  assert.equal(afterFailedWithdrawal.reserve, beforeFailedWithdrawal.reserve);
  assert.equal(afterFailedWithdrawal.rewards, beforeFailedWithdrawal.rewards);
  assert.equal(afterFailedWithdrawal.transactions.find((item) => item.fundingId === failedWithdrawal.id).status, 'failed');
  assert.match(await movementDialog.innerText(), new RegExp(`보류했던 ${pattern(wonText(20_000))}을 모두 돌려드렸어요\\. 수수료는 빼지 않았어요\\.`));
  await movementDialog.getByTestId('funding-retry').click();
  await fundingRoute({ mode: 'withdraw', target: movementPage, open: false });
  const recoveredWithdrawal = await requestWithdrawal(20_000, movementPage);
  assert.equal(recoveredWithdrawal.retryOf, failedWithdrawal.id);
  assert.notEqual(recoveredWithdrawal.requestId, failedWithdrawal.requestId);
  assert.equal(recoveredWithdrawal.simulation, 'success');
  await advanceFundingClock(recoveredWithdrawal.id, 'broadcasting', movementPage);
  await advanceFundingClock(recoveredWithdrawal.id, 'completed', movementPage);
  assert.equal((await read(movementPage)).spend, beforeFailedWithdrawal.spend - 20_000);
  assert.equal((await read(movementPage)).fundingOperations.find((item) => item.id === failedWithdrawal.id).status, 'failed');
  await closeFunding(movementPage);
  assert.equal(await movementPage.getByTestId('funding-held').count(), 0);
  pass('출금 실패는 수수료 포함 원금 전액 복구·실패 기록 보존·재입력 후 정상 완료');

  const beforeFailedDeposit = await read(movementPage);
  await fundingRoute({ target: movementPage });
  const failedDeposit = await requestDeposit(10, movementPage, 'failure');
  await movementDialog.getByTestId('funding-simulate-deposit').click();
  await operationWhen(failedDeposit.id, 'confirming', movementPage);
  await advanceFundingClock(failedDeposit.id, 'failed', movementPage);
  const afterFailedDeposit = await read(movementPage);
  assert.equal(afterFailedDeposit.spend, beforeFailedDeposit.spend, '실패한 입금은 원화 잔액을 늘리지 않는다');
  assert.equal(afterFailedDeposit.reserve, beforeFailedDeposit.reserve);
  assert.equal(afterFailedDeposit.rewards, beforeFailedDeposit.rewards);
  assert.match(await movementDialog.innerText(), /잔액은 바뀌지 않았어요/);
  await movementDialog.getByTestId('funding-retry').click();
  await fundingRoute({ target: movementPage, open: false });
  const recoveredDeposit = await requestDeposit(10, movementPage);
  assert.equal(recoveredDeposit.retryOf, failedDeposit.id);
  assert.notEqual(recoveredDeposit.requestId, failedDeposit.requestId);
  await movementDialog.getByTestId('funding-simulate-deposit').click();
  await operationWhen(recoveredDeposit.id, 'confirming', movementPage);
  await advanceFundingClock(recoveredDeposit.id, 'converting', movementPage);
  await advanceFundingClock(recoveredDeposit.id, 'completed', movementPage);
  assert.equal((await read(movementPage)).spend, beforeFailedDeposit.spend + 10 * USDC_PRICE);
  assert.equal((await read(movementPage)).fundingOperations.find((item) => item.id === failedDeposit.id).status, 'failed');
  await closeFunding(movementPage);
  pass('입금 확인 실패는 잔액 미반영·실패 내역 보존·새 요청의 정상 완료에만 반영');

  const beforeCancelledDeposit = await read(movementPage);
  await fundingRoute({ target: movementPage });
  const cancelledDeposit = await requestDeposit(20, movementPage);
  await movementDialog.getByTestId('funding-cancel').click();
  await operationWhen(cancelledDeposit.id, 'cancelled', movementPage);
  assert.equal((await read(movementPage)).spend, beforeCancelledDeposit.spend);
  await closeFunding(movementPage);
  await movementPage.reload({ waitUntil: 'networkidle' });
  assert.equal((await read(movementPage)).fundingOperations.find((item) => item.id === cancelledDeposit.id).status, 'cancelled');
  assert.equal((await read(movementPage)).spend, beforeCancelledDeposit.spend);
  pass('확인 전 입금 요청 취소는 잔액을 바꾸지 않고 취소 이력을 보존');

  await movementContext.close();

  const quoteContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const quotePage = await quoteContext.newPage();
  observe(quotePage);
  quotePage.setDefaultTimeout(10_000);
  const quoteTime = Date.now();
  await quotePage.clock.setFixedTime(quoteTime);
  await quotePage.goto(base, { waitUntil: 'networkidle' });
  await signUp(quotePage);
  await stateWhen((current) => current.spend === START.spend, quotePage);
  const quoteDialog = await fundingRoute({ target: quotePage });
  await quoteDialog.getByTestId('action-amount').fill('10');
  await quoteDialog.getByTestId('funding-next').click();
  await quoteDialog.getByTestId('funding-consent').check();
  const beforeExpiry = await read(quotePage);
  await quotePage.clock.setFixedTime(quoteTime + (POLICY.quoteTtlSeconds + 1) * 1_000);
  await quotePage.waitForFunction(() => document.querySelector('[data-testid="quote-ttl"]')?.textContent === '견적 만료');
  assert.equal(await quoteDialog.getByTestId('confirm-action').isDisabled(), true);
  await quoteDialog.locator('form').evaluate((form) => form.requestSubmit());
  await quoteDialog.getByRole('alert').first().waitFor({ state: 'visible' });
  assert.match((await quoteDialog.getByRole('alert').allTextContents()).join(' '), /입출금 견적.*만료/, '강제 제출도 최종 견적 유효성 검사에서 거절한다');
  const expiredState = await read(quotePage);
  assert.equal(expiredState.spend, beforeExpiry.spend);
  assert.equal(expiredState.reserve, beforeExpiry.reserve);
  assert.equal(expiredState.rewards, beforeExpiry.rewards);
  assert.equal(expiredState.transactions.length, beforeExpiry.transactions.length);
  assert.equal(expiredState.fundingOperations.length, beforeExpiry.fundingOperations.length);
  await quoteDialog.getByTestId('refresh-quote').click();
  assert.match(await quoteDialog.getByTestId('quote-ttl').innerText(), new RegExp(`${POLICY.quoteTtlSeconds}초 유효`));
  assert.equal(await quoteDialog.getByTestId('confirm-action').isDisabled(), false);
  await quoteDialog.getByTestId('confirm-action').click();
  const renewedDeposit = (await stateWhen((current) => current.fundingOperations.length === beforeExpiry.fundingOperations.length + 1, quotePage)).fundingOperations[0];
  assert.equal(renewedDeposit.status, 'awaiting_deposit');
  assert.equal((await read(quotePage)).spend, beforeExpiry.spend);
  await quoteDialog.getByTestId('funding-simulate-deposit').click();
  await operationWhen(renewedDeposit.id, 'confirming', quotePage);
  await advanceFundingClock(renewedDeposit.id, 'converting', quotePage);
  await advanceFundingClock(renewedDeposit.id, 'completed', quotePage);
  await stateWhen((current) => current.spend === START.spend + 10 * USDC_PRICE, quotePage);
  await closeFunding(quotePage);
  pass('입금 견적 31초 만료 강제 제출도 원장 불변·갱신 후 확인·전환 완료에만 반영');

  await fundingRoute({ mode: 'withdraw', target: quotePage });
  await quoteDialog.getByTestId('action-amount').fill('10000');
  await quoteDialog.getByTestId('funding-recipient').fill('내 체험 지갑');
  await quoteDialog.getByTestId('funding-preview-address').click();
  await quoteDialog.getByTestId('funding-next').click();
  await quoteDialog.getByTestId('funding-consent').check();
  await verifyWithdrawalEmail(quoteDialog);
  const beforeWithdrawalExpiry = await read(quotePage);
  const withdrawalQuoteTime = await quotePage.evaluate(() => Date.now());
  await quotePage.clock.setFixedTime(withdrawalQuoteTime + (POLICY.quoteTtlSeconds + 1) * 1_000);
  await quotePage.waitForFunction(() => document.querySelector('[data-testid="quote-ttl"]')?.textContent === '견적 만료');
  assert.equal(await quoteDialog.getByTestId('confirm-action').isDisabled(), true);
  await quoteDialog.locator('form').evaluate((form) => form.requestSubmit());
  await quoteDialog.getByRole('alert').first().waitFor({ state: 'visible' });
  assert.match((await quoteDialog.getByRole('alert').allTextContents()).join(' '), /입출금 견적.*만료/, '출금 강제 제출도 실제 접수 경로의 견적 검사에서 거절한다');
  assert.deepEqual(ledgerSnapshot(await read(quotePage)), ledgerSnapshot(beforeWithdrawalExpiry), '만료된 출금 견적은 원금 보류도 만들지 않는다');
  await quoteDialog.getByTestId('refresh-quote').click();
  await quoteDialog.getByTestId('confirm-action').click();
  const renewedWithdrawal = (await stateWhen((current) => current.fundingOperations.length === beforeWithdrawalExpiry.fundingOperations.length + 1, quotePage)).fundingOperations[0];
  assert.equal(renewedWithdrawal.status, 'reviewing');
  assert.equal((await read(quotePage)).spend, beforeWithdrawalExpiry.spend - 10_000);
  await advanceFundingClock(renewedWithdrawal.id, 'broadcasting', quotePage);
  await advanceFundingClock(renewedWithdrawal.id, 'completed', quotePage);
  await closeFunding(quotePage);
  pass('출금 최종 확인 중 견적 만료는 보류 없이 거절·갱신 후 한 번만 출금');

  await quoteContext.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', isMobile: true });
  const mobile = await mobileContext.newPage();
  observe(mobile);
  mobile.setDefaultTimeout(10_000);
  await mobile.goto(base, { waitUntil: 'networkidle' });
  await signUp(mobile);
  const overflows = () => mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  for (const name of ['home', 'card', 'benefits', 'settings']) {
    await nav(name, mobile);
    assert.equal(await overflows(), false, `모바일 ${name} 가로 넘침`);
  }
  for (const [name, parent, opener] of [['reserve', 'home', 'open-reserve-card'], ['activity', 'home', 'nav-activity'], ['limits', 'settings', 'open-limits']]) {
    await mobile.getByTestId(`nav-${parent}`).click();
    await mobile.getByTestId(opener).click();
    await mobile.getByTestId('go-back').waitFor();
    assert.equal(await overflows(), false, `모바일 상세 ${name} 가로 넘침`);
    assert.equal(await mobile.getByTestId(`nav-${parent}`).getAttribute('aria-current'), 'page');
    await mobile.getByTestId('go-back').click();
    assert.equal(await mobile.getByTestId('go-back').count(), 0, `모바일 상세 ${name}에서 진입 탭으로 복귀`);
    assert.equal(await mobile.getByTestId(`nav-${parent}`).getAttribute('aria-current'), 'page');
  }
  await mobile.getByTestId('nav-home').click();
  const mobileArt = await mobile.locator('.home-card-offer img').boundingBox();
  assert.ok(mobileArt && mobileArt.width >= 240 && mobileArt.width <= 350, `390px 모바일 카드 안내 이미지 폭: ${mobileArt?.width}`);
  const mobileCardButton = await mobile.getByTestId('open-payment').boundingBox();
  assert.ok(mobileCardButton && mobileCardButton.width >= 330 && mobileCardButton.height >= 44, `390px 모바일 카드 만들기 버튼: ${JSON.stringify(mobileCardButton)}`);
  await mobile.screenshot({ path: new URL('aqua-mobile.png', artifacts).pathname, fullPage: true });
  await mobile.getByTestId('open-deposit').click();
  assert.equal(await overflows(), false, '모바일 코인·네트워크 선택');
  await fundingRoute({ target: mobile, open: false });
  const mobileDeposit = await requestDeposit(10, mobile);
  assert.equal(await overflows(), false, '모바일 입금 대기 화면');
  await settleFunding(mobileDeposit, mobile);
  assert.equal((await read(mobile)).spend, START.spend + 10 * USDC_PRICE);
  assert.equal(await overflows(), false, '모바일 입금 완료 화면');
  await closeFunding(mobile);
  await mobile.getByTestId('open-send').click();
  const mobileSend = mobile.getByTestId('send-sheet');
  await mobileSend.waitFor({ state: 'visible' });
  assert.equal(await overflows(), false, '모바일 보내기 선택');
  await mobileSend.getByTestId('send-member').click();
  assert.equal(await overflows(), false, '모바일 회원 찾기');
  await mobileSend.getByTestId('send-pick-seoyeon_lee').click();
  await mobileSend.getByTestId('send-amount').fill('10000');
  assert.equal(await overflows(), false, '모바일 보낼 금액');
  await mobileSend.getByRole('button', { name: '창 닫기', exact: true }).click();
  await mobileSend.waitFor({ state: 'hidden' });
  assert.equal((await read(mobile)).spend, START.spend + 10 * USDC_PRICE);
  pass('390px 모바일 네 탭·상세 복귀·카드 안내·충전 전 단계·보내기 시트·가로 넘침');
  await mobileContext.close();

  const lifeContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const life = await lifeContext.newPage();
  observe(life);
  life.setDefaultTimeout(10_000);
  await life.goto(base, { waitUntil: 'networkidle' });
  await signUp(life);
  await nav('settings', life);
  await life.getByTestId('open-limits').click();
  await life.getByTestId('page-limits').waitFor();
  assert.equal(await life.getByTestId('limits-save').isDisabled(), true, '바꾸기 전에는 저장할 수 없다');
  await life.getByTestId('limit-perPayment').fill('100000');
  await life.getByTestId('limit-daily').fill('200000');
  await life.getByTestId('limits-save').click();
  let lifeState = await stateWhen((current) => current.controls.perPayment === 100_000, life);
  assert.deepEqual([lifeState.controls.daily, lifeState.controls.monthly], [200_000, POLICY.monthlyPaymentLimit]);
  await life.getByTestId('go-back').click();
  await life.getByTestId('open-channels').click();
  await life.getByTestId('channel-online').click();
  await stateWhen((current) => current.controls.online === false, life);
  await life.getByTestId('go-back').click();
  assert.match(await life.getByTestId('open-channels').innerText(), /온라인 막음/);
  pass('결제 한도 화면에서 1회·하루 한도를 낮추고 온라인 결제를 막는다');

  await nav('card', life);
  await life.getByTestId('card-apply').click();
  await finishApplication({ plan: 'standard', physical: false }, life);
  await details('card-demo-tools', true, life);
  await life.getByTestId('card-demo-approve').click();
  await stateWhen((current) => current.card.stage !== 'submitted', life);
  await stateWhen((current) => current.card.stage === 'active', life);
  assert.match(await life.getByTestId('card-open-limits').innerText(), /1회 10만원/);
  assert.match(await life.getByTestId('card-open-channels').innerText(), /온라인 막음/);
  await life.getByTestId('card-open-channels').click();
  await life.getByTestId('page-channels').waitFor();
  assert.equal(await life.getByTestId('nav-card').getAttribute('aria-current'), 'page');
  assert.equal(await life.getByTestId('channel-online').getAttribute('aria-checked'), 'false');
  await life.getByTestId('go-back').click();
  await life.getByTestId('card-open-limits').click();
  await life.getByTestId('page-limits').waitFor();
  assert.equal(await life.getByTestId('nav-card').getAttribute('aria-current'), 'page');
  assert.equal(await displayedAmount(life.getByTestId('limit-value-perPayment')), 100_000);
  await life.getByTestId('go-back').click();
  await life.getByTestId('card-pay').click();
  const lifePayment = life.getByTestId('dialog-payment');
  await lifePayment.waitFor({ state: 'visible' });
  pass('체험 도구로 바로 승인한 카드의 카드 탭에서 결제 한도·온라인·해외 결제로 갔다가 돌아오고 결제해 보기를 연다');

  await lifePayment.getByTestId('pay-channel-online').click();
  assert.match(await lifePayment.innerText(), /온라인 결제를 막아 두었어요/);
  await lifePayment.getByTestId('action-amount').fill('5000');
  await lifePayment.getByTestId('confirm-action').click();
  assert.match(await lifePayment.getByRole('alert').innerText(), /온라인 결제를 막아/);
  await lifePayment.getByTestId('pay-channel-store').click();
  await lifePayment.getByTestId('action-amount').fill('110000');
  await lifePayment.getByTestId('confirm-action').click();
  assert.match(await lifePayment.getByRole('alert').innerText(), /1회 결제 한도는 10만원/);
  await lifePayment.getByTestId('action-amount').fill('5800');
  await lifePayment.getByTestId('confirm-action').click();
  lifeState = await stateWhen((current) => current.payments[0]?.status === 'completed', life);
  assert.equal(lifeState.payments[0].channel, 'store');
  await life.getByTestId('payment-receipt').waitFor({ state: 'visible' });
  await life.keyboard.press('Escape');
  await life.getByTestId('payment-receipt').waitFor({ state: 'hidden' });
  await nav('activity', life);
  const paymentEntry = lifeState.transactions.find((item) => item.kind === 'payment');
  await life.getByTestId(`tx-detail-${paymentEntry.id}`).click();
  const txSheet = life.getByTestId('transaction-sheet');
  assert.match(await txSheet.getByTestId('transaction-approval').innerText(), /^AQ\d{8}$/);
  assert.match(await txSheet.innerText(), /매장[\s\S]*리워드에서[\s\S]*잔액에서/);
  await life.keyboard.press('Escape');
  pass('막아 둔 결제 방식과 낮춘 한도로 결제를 거절하고 거래 상세에 승인번호·결제 구성을 보여준다');

  await nav('card', life);
  const spendBeforeCardChanges = (await read(life)).spend;
  const standardPhysicalFee = PLANS.standard.physicalFee;
  await life.getByTestId('card-physical-add').click();
  await chooseAddress(life, '06100');
  await life.getByTestId('card-sheet').waitFor({ state: 'visible' });
  await expectSheetCost(life, standardPhysicalFee);
  await life.getByTestId('card-sheet-confirm').click();
  lifeState = await stateWhen((current) => current.card.physical, life);
  assert.deepEqual([lifeState.spend, lifeState.card.address.zip, lifeState.card.delivery], [spendBeforeCardChanges - standardPhysicalFee, '06100', 'preparing']);
  await life.getByTestId('card-address-change').click();
  await chooseAddress(life, '03900');
  lifeState = await stateWhen((current) => current.card.address.zip === '03900', life);
  assert.equal(lifeState.card.delivery, 'preparing', '배송 전에는 주소를 바꿀 수 있다');
  await addWallet(life, 'samsung');
  await life.getByTestId('wallet-added-samsung').waitFor();
  const oldLast4 = (await read(life)).card.last4;
  await life.getByTestId('card-reissue').click();
  assert.match(await life.getByTestId('card-sheet').innerText(), /휴대폰 결제에 넣은 카드는 지워져요/);
  await expectSheetCost(life, standardPhysicalFee);
  await life.getByTestId('card-sheet-confirm').click();
  lifeState = await stateWhen((current) => current.card.last4 !== oldLast4, life);
  assert.equal(lifeState.spend, spendBeforeCardChanges - 2 * standardPhysicalFee, '실물카드 재발급비는 멤버십 조건대로 낸다');
  assert.deepEqual(lifeState.card.wallets, [], '재발급하면 휴대폰 결제에 넣은 카드는 지워진다');
  assert.equal(lifeState.card.delivery, 'preparing');
  await life.getByTestId('wallet-add-samsung').waitFor();
  pass('스탠다드 실물카드 추가·배송 전 주소 변경·분실 재발급(휴대폰 결제 해제)을 멤버십 비용대로 처리');

  await details('card-demo-tools', true, life);
  await life.getByTestId('card-demo-shipped').click();
  await life.getByTestId('card-demo-delivered').click();
  await life.getByTestId('card-physical-activate').click();
  await life.getByTestId('pin-input').fill('2580');
  await life.getByTestId('pin-again').fill('2580');
  await life.getByTestId('pin-submit').click();
  lifeState = await stateWhen((current) => current.card.physicalActive, life);
  const premiumFee = PLANS.premium.annualFee;
  const spendBeforeUpgrade = lifeState.spend;
  assert.ok(premiumFee <= spendBeforeUpgrade, '프리미엄 연회비는 지금 잔액으로 낼 수 있다');
  await life.getByTestId('card-plan-premium').click();
  const planSheet = life.getByTestId('card-sheet');
  await planSheet.waitFor({ state: 'visible' });
  assert.match(await planSheet.innerText(), new RegExp(`연회비 ${pattern(wonText(premiumFee))}을 지금 잔액에서 내고, 1년 뒤 같은 날 다시 내요`));
  assert.match(await planSheet.innerText(), new RegExp(`${PLANS.premium.card}를 서울특별시 마포구 물결로 8로 새로 보내 드려요\\. 받을 때까지 지금 카드를 그대로 쓰면 돼요`));
  await expectSheetCost(life, premiumFee);
  assert.equal(await life.getByTestId('card-sheet-deposit').count(), 0);
  await life.getByTestId('card-sheet-confirm').click();
  lifeState = await stateWhen((current) => current.card.plan === 'premium', life);
  assert.equal(lifeState.spend, spendBeforeUpgrade - premiumFee, '올리면 연회비를 바로 낸다');
  assert.ok(lifeState.card.billingAt > Date.now() + 364 * DAY_MS, '다음 갱신일은 1년 뒤');
  assert.equal(lifeState.transactions.find((item) => item.title === `${PLANS.premium.short} 연회비`).amount, -premiumFee);
  assert.match(await life.getByTestId('card-plan').innerText(), new RegExp(`${PLANS.premium.short}\\s+페이백 ${pattern(percentText(PLANS.premium.cashbackRate))}\\s+월 ${pattern(wonText(PLANS.premium.cashbackCap))}까지\\s+리저브 \\+${pattern(percentText(PLANS.premium.reserveBonus))}p`));
  assert.deepEqual([lifeState.card.physicalPlan, lifeState.card.replacement], ['standard', { plan: 'premium', delivery: 'preparing' }], '쓰던 실물카드는 그대로 두고 메탈 카드를 새로 보낸다');
  const replacementBlock = life.getByTestId('card-replacement');
  assert.match(await replacementBlock.innerText(), new RegExp(`새 ${PLANS.premium.card}[\\s\\S]*만드는 중[\\s\\S]*받을 때까지 지금 카드를 그대로 써요`));
  await details('card-demo-tools', true, life);
  await life.getByTestId('card-demo-replacement').click();
  await stateWhen((current) => current.card.replacement?.delivery === 'shipped', life);
  assert.equal(await life.getByTestId('card-replacement-activate').count(), 0, '도착 전에는 새 카드를 쓸 수 없다');
  await life.getByTestId('card-demo-replacement').click();
  await stateWhen((current) => current.card.replacement?.delivery === 'delivered', life);
  await life.getByTestId('card-replacement-activate').click();
  await planSheet.waitFor({ state: 'visible' });
  assert.match(await planSheet.innerText(), /카드 번호와 카드 비밀번호는 그대로예요[\s\S]*지금 쓰던 실물카드는 바로 결제가 막혀요/);
  await life.getByTestId('card-sheet-confirm').click();
  lifeState = await stateWhen((current) => current.card.physicalPlan === 'premium' && current.card.replacement === null, life);
  assert.equal(lifeState.spend, spendBeforeUpgrade - premiumFee, '메탈 카드는 따로 돈을 받지 않는다');
  assert.equal(await life.getByTestId('card-physical-name').innerText(), PLANS.premium.card);
  assert.equal(await replacementBlock.count(), 0);
  const premiumRenewal = await life.getByTestId('card-billing-date').innerText();
  await life.getByTestId('nav-home').click();
  assert.match(await life.getByTestId('open-reserve-card').innerText(), new RegExp(`연 ${pattern(percentText(lifeState.reserveRate + PLANS.premium.reserveBonus))}`));
  await nav('card', life);
  await life.getByTestId('card-plan-standard').click();
  await planSheet.waitFor({ state: 'visible' });
  assert.match(await planSheet.innerText(), new RegExp(`${pattern(premiumRenewal)}까지는 ${PLANS.premium.short} 혜택을 그대로 써요[\\s\\S]*그날부터 스탠다드로 바뀌어요`));
  await expectSheetCost(life, 0);
  assert.equal(await life.getByTestId('card-sheet-confirm').innerText(), `${premiumRenewal}에 바꾸기`);
  await life.getByTestId('card-sheet-confirm').click();
  lifeState = await stateWhen((current) => current.card.nextPlan === 'standard', life);
  assert.equal(lifeState.spend, spendBeforeUpgrade - premiumFee, '내리는 변경은 바로 돈이 나가지 않는다');
  assert.equal(lifeState.card.plan, 'premium');
  assert.match(await life.getByTestId('card-plan').innerText(), new RegExp(`${pattern(premiumRenewal)}부터 스탠다드로 바뀌어요`));
  assert.equal(await life.getByTestId('card-plan-standard').count(), 0, '예약한 멤버십은 예약됨으로 보인다');
  await life.getByTestId('card-plan-keep').click();
  lifeState = await stateWhen((current) => current.card.nextPlan === null, life);
  assert.equal(await life.getByTestId('card-billing-date').innerText(), premiumRenewal);
  pass('프리미엄으로 올리면 연회비를 바로 내고 리저브 추가 보상을 적용·메탈 카드를 새로 보내 받으면 쓰기 시작·스탠다드 변경은 갱신일로 예약하고 취소');

  const privateFee = PLANS.private.annualFee;
  const spendBeforePrivate = lifeState.spend;
  assert.ok(privateFee > spendBeforePrivate, '프라이빗 연회비는 지금 잔액보다 크다');
  await life.getByTestId('card-plan-private').click();
  await planSheet.waitFor({ state: 'visible' });
  await expectSheetCost(life, privateFee);
  assert.match(await planSheet.innerText(), /지금 멤버십의 남은 기간 연회비는 돌려드리지 않아요/);
  assert.match(await planSheet.getByRole('alert').innerText(), new RegExp(`잔액이 ${pattern(wonText(privateFee - spendBeforePrivate))} 부족해요`));
  assert.equal(await life.getByTestId('card-sheet-confirm').isDisabled(), true, '잔액이 모자라면 바꿀 수 없다');
  await life.getByTestId('card-sheet-deposit').click();
  await planSheet.waitFor({ state: 'hidden' });
  await fundingDialogAt(life).waitFor({ state: 'visible' });
  const upgradeTopUp = Math.ceil((privateFee - spendBeforePrivate + premiumFee) / 100_000) * 100_000;
  await topUpWithKrws(upgradeTopUp, life);
  const premiumBillingAt = lifeState.card.billingAt;
  await life.getByTestId('card-plan-private').click();
  await planSheet.waitFor({ state: 'visible' });
  assert.equal(await life.getByTestId('card-sheet-confirm').isDisabled(), false);
  await life.getByTestId('card-sheet-confirm').click();
  lifeState = await stateWhen((current) => current.card.plan === 'private', life);
  assert.equal(lifeState.spend, spendBeforePrivate + upgradeTopUp - privateFee);
  assert.ok(lifeState.card.billingAt > premiumBillingAt, '올린 날부터 새 1년을 센다');
  const privateEntry = lifeState.transactions.find((item) => item.title === `${PLANS.private.short} 연회비`);
  assert.equal(privateEntry.amount, -privateFee);
  assert.match(privateEntry.note, /이전 멤버십의 남은 기간 연회비는 돌려드리지 않아요/);
  assert.match(privateEntry.note, new RegExp(`${PLANS.private.card}를 서울특별시 마포구 물결로 8로 새로 보내 드려요`));
  assert.deepEqual(lifeState.card.replacement, { plan: 'private', delivery: 'preparing' }, '메탈 카드를 쓰는 중이면 골드 카드를 새로 보낸다');
  await life.getByTestId('card-plan-premium').click();
  await planSheet.waitFor({ state: 'visible' });
  assert.match(await planSheet.innerText(), new RegExp(`그날부터 ${PLANS.premium.short}으로 바뀌어요\\. ${PLANS.premium.short} 연회비 ${pattern(wonText(premiumFee))}은 그날 나가요`));
  await expectSheetCost(life, 0);
  await life.getByTestId('card-sheet-confirm').click();
  lifeState = await stateWhen((current) => current.card.nextPlan === 'premium', life);
  assert.equal(lifeState.spend, spendBeforePrivate + upgradeTopUp - privateFee);
  pass('잔액이 모자란 프라이빗 변경은 충전으로 안내하고 충전 뒤 연회비를 내며 프리미엄 변경을 갱신일로 예약');

  await details('card-demo-tools', true, life);
  const beforeRenewal = await read(life);
  await life.getByTestId('card-demo-billing').click();
  lifeState = await stateWhen((current) => current.card.plan === 'premium' && current.card.nextPlan === null, life);
  assert.equal(lifeState.spend, beforeRenewal.spend - premiumFee, '예약한 멤버십의 연회비를 갱신일에 낸다');
  assert.ok(lifeState.card.billingAt > beforeRenewal.card.billingAt + 364 * DAY_MS, '다음 갱신일은 다시 1년 뒤');
  const renewalEntry = lifeState.transactions.find((item) => item.title === `${PLANS.premium.short} 연회비` && item.note.includes('예약한 대로'));
  assert.ok(renewalEntry, '갱신 연회비 내역');
  assert.equal(renewalEntry.amount, -premiumFee);
  const privateTerms = reserveTermsOf(beforeRenewal);
  const expectedYearReward = Math.min(beforeRenewal.reserve, privateTerms.cap) * privateTerms.rate * (beforeRenewal.card.billingAt - beforeRenewal.lastAccruedAt) / YEAR_MS;
  const earnedYearReward = lifeState.rewards + lifeState.accrued - beforeRenewal.rewards - beforeRenewal.accrued;
  assert.ok(Math.abs(earnedYearReward - expectedYearReward) < 1, `갱신일까지 프라이빗 조건으로 쌓인 리저브 보상: ${earnedYearReward} / ${expectedYearReward}`);
  assert.ok(lifeState.spend < premiumFee, '다음 갱신일에는 잔액이 모자라다');
  const beforeLapse = lifeState;
  await life.getByTestId('card-demo-billing').click();
  lifeState = await stateWhen((current) => current.card.plan === 'standard', life);
  assert.equal(lifeState.card.billingAt, null);
  assert.equal(lifeState.spend, beforeLapse.spend, '내지 못한 연회비는 빼지 않는다');
  assert.match(lifeState.transactions.find((item) => item.title === '스탠다드로 변경').note, new RegExp(`잔액이 부족해 ${PLANS.premium.short} 연회비를 내지 못했어요`));
  assert.equal(await life.getByTestId('card-demo-billing').count(), 0);
  assert.equal(await life.getByTestId('card-billing-date').count(), 0);
  pass('갱신일 체험: 예약한 프리미엄 연회비를 잔액에서 내고, 다음 갱신일에 잔액이 모자라면 스탠다드로 바뀐다');

  const spendBeforeClose = lifeState.spend;
  await life.getByTestId('card-close').click();
  assert.equal(await life.getByTestId('card-sheet-confirm').isDisabled(), true, '해지는 내용을 확인해야 한다');
  await life.getByTestId('card-sheet-consent').check();
  await life.getByTestId('card-sheet-confirm').click();
  lifeState = await stateWhen((current) => current.card.stage === 'not_applied', life);
  assert.equal(lifeState.spend, spendBeforeClose, '해지해도 잔액은 남는다');
  assert.equal(lifeState.reserve, START.reserve);
  await life.getByTestId('card-apply').waitFor();
  pass('카드 해지는 확인 동의 뒤 처리하고 잔액·리저브는 그대로 둔다');

  await nav('settings', life);
  assert.match(await life.locator('.settings-page').innerText(), /카드와 멤버십\s*카드 없음/);
  const hashBefore = (await read(life)).account.passwordHash;
  await life.getByTestId('open-password').click();
  await life.getByTestId('password-current').fill(PASSWORD);
  await life.getByTestId('password-next').fill('aqua2027pass');
  await life.getByTestId('password-confirm').fill('aqua2027pass');
  await life.getByTestId('password-submit').click();
  await stateWhen((current) => current.account.passwordHash !== hashBefore, life);
  await life.getByTestId('open-notifications').click();
  await life.getByTestId('notify-marketing').click();
  lifeState = await stateWhen((current) => current.notifications.marketing, life);
  assert.ok(lifeState.notifications.marketingChangedAt > 0);
  assert.match(await life.getByTestId('marketing-status').innerText(), /\d{4}년 \d{1,2}월 \d{1,2}일에 동의했어요/);
  await life.getByTestId('go-back').click();
  for (const [opener, pageId] of [['open-faq', 'page-faq'], ['open-terms', 'page-terms']]) {
    await life.getByTestId(opener).click();
    await life.getByTestId(pageId).waitFor();
    await life.getByTestId('go-back').click();
  }
  await life.getByTestId('open-closure').click();
  assert.match(await life.getByTestId('closure-blockers').innerText(), /잔액을 모두 출금/);
  await life.keyboard.press('Escape');
  pass('비밀번호 변경·광고성 정보 수신 동의 날짜·자주 묻는 질문·약관·탈퇴 전 정리 안내');
  await lifeContext.close();

  assert.deepEqual(errors, [], '브라우저 실행 오류');
  assert.deepEqual([...new Set(external)], [], 'PoC는 외부 금융·폰트 요청을 하지 않는다');
  pass('브라우저 실행 오류 없음·외부 요청 없음');
  await writeFile(new URL('browser-results.json', artifacts), JSON.stringify({ passed: groups, failed: 0, skipped: 0, recordedAt: new Date().toISOString(), baseUrl: base, desktop: '1440×1050', mobile: '390×844', errors, external }, null, 2));
  console.log(`${groups} browser checks passed. Screenshots written to artifacts/.`);
} catch (error) {
  if (failurePage ?? page) await (failurePage ?? page).screenshot({ path: new URL('aqua-failure.png', artifacts).pathname, fullPage: true }).catch(() => {});
  console.error(error);
  await writeFile(new URL('browser-results.json', artifacts), JSON.stringify({ passed: groups, failed: 1, recordedAt: new Date().toISOString(), baseUrl: base, error: String(error), errors, external }, null, 2)).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
