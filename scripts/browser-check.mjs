import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

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

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  page = await context.newPage();
  observe(page);
  page.setDefaultTimeout(10_000);
  await page.goto(base, { waitUntil: 'networkidle' });
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
  async function nav(name, target = page) {
    if (name === 'card') {
      await target.getByTestId('nav-home').click();
      await target.getByTestId('card-cta').click();
    } else if (name === 'reserve') {
      await target.getByTestId('nav-wallet').click();
      await target.getByTestId('open-reserve').click();
    } else {
      await target.getByTestId(`nav-${name}`).click();
    }
  }
  const ledgerSnapshot = (state) => ({
    spend: state.spend, reserve: state.reserve, rewards: state.rewards, rewardDebt: state.rewardDebt,
    holdings: state.holdings, card: state.card, payments: state.payments, transactions: state.transactions,
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
    await dialog.getByTestId('confirm-action').click();
    await dialog.waitFor({ state: 'hidden' });
  }
  const displayedAmount = async (locator) => Number((await locator.innerText()).replace(/[^\d]/g, ''));
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
    if (before === after && used > 0 && credit === used) assert.match(await receipt.innerText(), /사용한 리워드와 새 페이백이 같아 잔액은 동일합니다/);
    if (screenshot) await target.screenshot({ path: new URL('aqua-payment-receipt.png', artifacts).pathname, fullPage: true });
    await receipt.getByTestId('receipt-close').click();
    await receipt.waitFor({ state: 'hidden' });
  }
  const flow = () => page.locator('.card-flow');
  async function finishApplication({ plan = 'basic', physical = true } = {}, target = page) {
    const cardFlow = target.locator('.card-flow');
    assert.equal(await cardFlow.locator('.cf-steps li').count(), 3, '신청 화면은 본인확인·카드 선택·신청 확인의 세 단계');
    await cardFlow.getByTestId('card-identity-consent').check();
    await cardFlow.getByTestId('card-identity-next').click();
    await cardFlow.getByRole('radio', { name: new RegExp(`Aqua ${plan === 'plus' ? 'Plus' : 'Basic'}`) }).check();
    await cardFlow.getByTestId('card-physical-choice').setChecked(physical);
    await cardFlow.getByTestId('card-selection-next').click();
    assert.equal(await cardFlow.getByTestId('card-submit').isDisabled(), true, '최종 확인 전에는 접수할 수 없다');
    await cardFlow.getByTestId('card-review-consent').check();
    await cardFlow.getByTestId('card-submit').click();
    return stateWhen((state) => state.card.stage === 'submitted', target);
  }

  let state = await stateWhen((state) => state.card.stage === 'not_applied');
  assert.equal(state.spend, 128_500);
  assert.equal(state.rewards, 4_280);
  const primaryNav = page.getByRole('navigation', { name: '주 메뉴' });
  assert.equal(await primaryNav.getByRole('button').count(), 4);
  assert.deepEqual(await primaryNav.getByRole('button').evaluateAll((buttons) => buttons.map((button) => ({ id: button.getAttribute('data-testid'), label: button.innerText.trim() }))), [
    { id: 'nav-home', label: '카드' }, { id: 'nav-wallet', label: '자산' },
    { id: 'nav-benefits', label: '혜택' }, { id: 'nav-settings', label: '전체' },
  ]);
  assert.equal(await page.getByTestId('nav-activity').count(), 1);
  assert.equal(await page.getByTestId('nav-settings').count(), 1);
  assert.match(await page.locator('.demo-notice').innerText(), /체험 화면입니다.*실제 자금 이동과 카드 발급은 없습니다/);
  assert.match(await page.getByTestId('available-balance').innerText(), /132,780/);
  const desktopCard = await page.locator('.card-center .aqua-card-visual.acv-hero').boundingBox();
  assert.ok(desktopCard && desktopCard.width >= 400 && desktopCard.width <= 500, `데스크톱 홈 카드 폭: ${desktopCard?.width}`);
  await page.getByTestId('open-payment').click();
  await flow().waitFor();
  state = await stateWhen((state) => state.card.stage === 'identity');
  await flow().getByTestId('card-identity-consent').waitFor({ state: 'visible' });
  assert.equal(await flow().getByTestId('card-apply').count(), 0, '카드 신청을 누르면 소개 화면을 거치지 않고 본인확인을 시작한다');
  assert.equal((await read()).payments.length, 0);
  pass('네 개 주 메뉴·큰 홈 카드·초기 잔액·카드 신청에서 본인확인 바로 시작');

  const beforeNavigation = ledgerSnapshot(await read());
  assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');
  await page.getByTestId('go-back').click();
  await page.getByTestId('card-cta').waitFor({ state: 'visible' });
  await nav('reserve');
  assert.equal(await page.getByTestId('nav-wallet').getAttribute('aria-current'), 'page');
  await nav('activity');
  await page.getByTestId('go-back').click();
  await page.getByTestId('reserve-principal').waitFor({ state: 'visible' });
  await page.getByTestId('go-back').click();
  await page.getByTestId('open-reserve').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('nav-wallet').getAttribute('aria-current'), 'page');
  await nav('benefits');
  await page.getByTestId('page-benefits').getByRole('button', { name: '리저브 보기', exact: true }).click();
  assert.equal(await page.getByTestId('nav-benefits').getAttribute('aria-current'), 'page');
  await page.getByTestId('go-back').click();
  await page.getByTestId('page-benefits').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('nav-benefits').getAttribute('aria-current'), 'page');
  assert.deepEqual(ledgerSnapshot(await read()), beforeNavigation);
  await nav('card');
  pass('카드·리저브·내역의 상세 뒤로 가기가 진입 탭과 원장을 보존');

  assert.equal(await flow().getByTestId('card-identity-next').isDisabled(), true);
  const initialSubmit = await finishApplication();
  assert.equal(await page.getByTestId('card-demo-tools').evaluate((item) => item.open), false);
  await details('card-demo-tools');
  await page.waitForTimeout(1_600);
  assert.equal((await read()).card.stage, 'submitted', '체험 도구를 열면 자동 심사를 일시 정지한다');
  await flow().getByTestId('card-demo-needs-info').click();
  await stateWhen((state) => state.card.stage === 'needs_info');
  await flow().getByTestId('card-resubmit').click();
  const secondSubmit = await finishApplication();
  assert.equal(secondSubmit.card.reference, initialSubmit.card.reference);
  assert.equal(secondSubmit.spend, initialSubmit.spend);
  await details('card-demo-tools');
  await flow().getByTestId('card-demo-reject').click();
  await stateWhen((state) => state.card.stage === 'rejected');
  await flow().getByTestId('card-restart').click();
  await finishApplication();
  pass('세 화면 신청·필수 동의·접힌 체험 도구·보완·거절·재신청');

  const stages = ['submitted'];
  await stateWhen((current) => {
    if (stages.at(-1) !== current.card.stage) stages.push(current.card.stage);
    return current.card.stage === 'active';
  });
  assert.deepEqual(stages, ['submitted', 'approved', 'issued', 'active']);
  assert.equal(await flow().getByRole('button', { name: '가상카드 발급', exact: true }).count(), 0);
  assert.equal(await flow().getByRole('button', { name: '가상카드 활성화', exact: true }).count(), 0);
  await details('card-demo-tools');
  await flow().getByTestId('card-demo-shipped').click();
  await flow().getByTestId('card-demo-delivered').click();
  await flow().getByTestId('card-physical-activate').click();
  state = await stateWhen((state) => state.card.physicalActive);
  assert.equal(state.spend, 128_500, '모의 발급비는 실제 잔액에서 청구하지 않는다');
  await page.screenshot({ path: new URL('aqua-card.png', artifacts).pathname, fullPage: true });
  pass('자동 승인·가상 발급·활성화·실물 배송·수령 활성화');

  await flow().getByTestId('card-lock-toggle').click();
  await stateWhen((state) => state.card.locked);
  await nav('home');
  await page.getByTestId('open-payment').click();
  await flow().waitFor();
  assert.equal(await page.getByTestId('dialog-payment').count(), 0);
  await flow().getByTestId('card-lock-toggle').click();
  await stateWhen((state) => !state.card.locked);
  pass('카드 잠금과 결제 안내');

  await nav('home');
  await page.getByTestId('open-payment').click();
  await page.getByTestId('action-amount').fill('200000');
  assert.equal(await page.getByTestId('confirm-action').isDisabled(), true);
  assert.match(await page.getByTestId('dialog-payment').innerText(), /부족/);
  await page.keyboard.press('Escape');
  await nav('settings');
  await page.getByTestId('reserve-auto').click();
  await stateWhen((state) => state.reserveAuto);
  await nav('home');
  await page.getByTestId('open-payment').click();
  await submitAmount('payment', 200_000);
  state = await stateWhen((state) => state.payments[0]?.status === 'completed');
  const paymentId = state.payments[0].id;
  assert.deepEqual([state.payments[0].fromRewards, state.payments[0].fromSpend, state.payments[0].fromReserve], [4_280, 128_500, 67_220]);
  assert.equal(state.reserve, 1_182_780);
  assert.equal(state.rewards, 1_957);
  assert.equal(state.monthlyCashback, 1_957);
  await paymentReceipt({ before: 4_280, used: 4_280, cashback: 1_957, after: 1_957 });
  assert.equal(await displayedAmount(page.getByTestId('home-cashback-confirmed')), 1_957);
  await page.getByTestId('open-rewards').click();
  const benefits = page.getByTestId('page-benefits');
  await benefits.waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('nav-benefits').getAttribute('aria-current'), 'page');
  assert.equal(await displayedAmount(benefits.getByTestId('reward-balance')), 1_957);
  assert.equal(await displayedAmount(benefits.getByTestId('cashback-confirmed')), 1_957);
  assert.equal(await displayedAmount(benefits.getByTestId('cashback-pending')), 0);
  assert.equal(await displayedAmount(benefits.getByTestId('cashback-remaining')), 8_043);
  pass('잔액 부족·Reserve 자동 사용·결제 영수증 회계·확정 페이백·남은 혜택 한도');
  assert.match(await benefits.innerText(), /카드 결제 전용.*출금할 수 없습니다/s);
  assert.match(await benefits.locator('.reserve-pending').innerText(), /아직 받지 않은 보상/);
  assert.equal(await page.getByTestId('dialog-rewards').count(), 0, '혜택은 기본 탭의 페이지로 제공');
  await benefits.getByRole('button', { name: '리저브 보기', exact: true }).click();
  assert.equal(await page.getByTestId('nav-benefits').getAttribute('aria-current'), 'page');
  await page.getByTestId('go-back').click();
  await benefits.waitFor({ state: 'visible' });
  assert.equal(await displayedAmount(benefits.getByTestId('reward-balance')), 1_957);
  pass('혜택 페이지는 리워드·월 페이백·미수령 보상을 구분하고 상세 복귀를 유지');

  await nav('activity');
  await page.getByRole('button', { name: '한강커피 환불', exact: true }).click();
  await submitAmount('refund', 50_000);
  state = await stateWhen((state) => state.payments[0].refunded === 50_000);
  assert.equal(state.payments[0].status, 'partially_refunded');
  await page.getByRole('button', { name: '한강커피 환불', exact: true }).click();
  await submitAmount('refund', 150_000);
  state = await stateWhen((state) => state.payments[0].status === 'refunded');
  assert.equal(state.payments[0].id, paymentId);
  assert.equal(state.spend, 195_720);
  assert.equal(state.rewards, 4_280);
  assert.equal(state.monthlyCashback, 0);
  pass('부분·전액 환불과 원금·리워드 복원·페이백 조정');

  await nav('wallet');
  assert.equal(await page.getByRole('button', { name: 'USDC 전환', exact: true }).count(), 0, '자산 선택 전에는 개별 코인 작업을 노출하지 않는다');
  await page.getByTestId('asset-select-USDC').click();
  assert.equal(await page.getByTestId('asset-select-USDC').getAttribute('aria-expanded'), 'true');
  await page.getByRole('button', { name: 'USDC 전환', exact: true }).click();
  await submitAmount('convert', 10);
  state = await stateWhen((state) => state.holdings.USDC === 90);
  assert.equal(state.spend, 209_650, '14,000원 평가액에서 전환비 70원을 공제');
  assert.equal(await page.getByRole('button', { name: 'USDC 입금', exact: true }).count(), 0, '새 외부 입금은 기존 코인 보유량에 쌓지 않는다');
  const beforeFunding = await read();
  await page.getByTestId('wallet-deposit').click();
  const fundingDialog = page.getByTestId('dialog-funding');
  await fundingDialog.waitFor({ state: 'visible' });
  assert.equal(await fundingDialog.getByTestId('funding-method-coin').getAttribute('aria-selected'), 'true');
  assert.equal(await fundingDialog.getByTestId('funding-asset-USDC').getAttribute('aria-pressed'), 'true');
  assert.equal(await fundingDialog.getByTestId('action-amount').inputValue(), '10');
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-gross')), 14_000);
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-fee')), 70);
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-net')), 13_930);
  await page.screenshot({ path: new URL('aqua-funding.png', artifacts).pathname, fullPage: true });
  await submitAmount('funding', 10);
  state = await stateWhen((state) => state.spend === beforeFunding.spend + 13_930);
  assert.deepEqual(state.holdings, beforeFunding.holdings);
  assert.equal(state.reserve, beforeFunding.reserve);
  assert.equal(state.rewards, beforeFunding.rewards);
  await page.getByRole('button', { name: 'USDC 출금', exact: true }).click();
  await submitAmount('asset', 5);
  await stateWhen((state) => state.holdings.USDC === 85);
  pass('기존 코인 전환·출금 호환과 신규 코인 입금의 원화 자동 반영');

  const beforeWithdrawal = await read();
  await page.getByTestId('wallet-withdraw').click();
  await fundingDialog.waitFor({ state: 'visible' });
  assert.equal(await fundingDialog.getByTestId('action-amount').inputValue(), '10000');
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-gross')), 10_000);
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-fee')), 50);
  assert.equal(await displayedAmount(fundingDialog.getByTestId('quote-net')), 9_950);
  const estimatedUnits = Number((await fundingDialog.getByTestId('quote-units').innerText()).replace(/,/g, ''));
  assert.ok(Math.abs(estimatedUnits - 9_950 / 1_400) < 1e-8);
  await submitAmount('funding', 10_000);
  state = await stateWhen((state) => state.spend === beforeWithdrawal.spend - 10_000);
  assert.deepEqual(state.holdings, beforeWithdrawal.holdings);
  assert.equal(state.reserve, beforeWithdrawal.reserve);
  assert.equal(state.rewards, beforeWithdrawal.rewards);
  assert.equal(state.transactions[0].amount, -10_000);
  pass('원화 결제 잔액에서 코인 출금·수수료·예상 수령량·다른 자산 보존');

  await nav('home');
  await page.getByTestId('open-deposit').click();
  await page.getByTestId('funding-method-demo').click();
  await page.getByTestId('action-amount').focus();
  await page.waitForTimeout(1_200);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'action-amount', '실시간 적립 중에도 금액 입력 초점을 유지');
  await submitAmount('funding', 10_000);
  state = await stateWhen((state) => state.spend === 223_580);
  pass('모의 원화 충전과 실시간 갱신 중 모달 초점 유지');

  const beforeDesignation = await read();
  const priorConversions = beforeDesignation.transactions.filter((item) => item.kind === 'convert').length;
  await nav('reserve');
  await page.getByRole('button', { name: '넣기', exact: true }).click();
  await submitAmount('transfer', 20_000);
  state = await stateWhen((state) => state.reserve === beforeDesignation.reserve + 20_000);
  assert.equal(state.spend, beforeDesignation.spend - 20_000);
  await page.getByRole('button', { name: '빼기', exact: true }).click();
  await submitAmount('transfer', 20_000);
  state = await stateWhen((state) => state.reserve === beforeDesignation.reserve);
  assert.equal(state.spend, beforeDesignation.spend);
  assert.equal(state.rewards, beforeDesignation.rewards);
  assert.deepEqual(state.holdings, beforeDesignation.holdings);
  assert.equal(state.transactions.filter((item) => item.kind === 'convert').length, priorConversions);
  pass('원화의 Reserve 지정·해제에는 추가 매도·수수료·코인 변동 없음');

  await nav('settings');
  assert.equal(await page.getByTestId('demo-tools').evaluate((item) => item.open), false);
  await details('demo-tools');
  const accruedBefore = (await read()).accrued;
  await page.getByTestId('advance-day').click();
  state = await stateWhen((state) => state.clockOffsetMs === 86_400_000);
  const firstDay = state.accrued - accruedBefore;
  assert.ok(Math.abs(firstDay - 1_182_780 * 0.05 / 365) < 0.1);
  const oldAccrued = state.accrued;
  await page.getByTestId('rate-8').click();
  await page.getByTestId('advance-day').click();
  state = await stateWhen((state) => state.clockOffsetMs === 172_800_000);
  assert.ok(Math.abs(state.accrued - oldAccrued - 1_182_780 * 0.08 / 365) < 0.1);
  await nav('benefits');
  const rewardsBefore = state.rewards;
  const claimed = Math.floor(state.accrued);
  assert.equal(await displayedAmount(benefits.getByTestId('reserve-pending-rewards')), claimed);
  await page.getByTestId('claim-rewards').click();
  state = await stateWhen((state) => state.rewards === rewardsBefore + claimed);
  assert.ok(state.accrued < 1);
  assert.equal(await displayedAmount(benefits.getByTestId('reward-balance')), state.rewards);
  assert.equal(await displayedAmount(benefits.getByTestId('reserve-pending-rewards')), 0);
  await page.screenshot({ path: new URL('aqua-benefits.png', artifacts).pathname, fullPage: true });
  await nav('reserve');
  await page.screenshot({ path: new URL('aqua-reserve.png', artifacts).pathname, fullPage: true });
  pass('접힌 체험 설정·하루 적립·보상률 변경 구간·혜택 탭의 리워드 수령');

  const beforeReload = await read();
  await page.reload({ waitUntil: 'networkidle' });
  state = await stateWhen((state) => state.card.stage === 'active');
  assert.equal(state.spend, beforeReload.spend);
  assert.equal(state.reserve, beforeReload.reserve);
  assert.equal(state.rewards, beforeReload.rewards);
  assert.equal(state.holdings.USDC, 85);
  assert.equal(state.reserveRate, 0.08);
  assert.equal(state.payments[0].status, 'refunded');
  await nav('home');
  await page.screenshot({ path: new URL('aqua-desktop.png', artifacts).pathname, fullPage: true });
  pass('새로고침 후 카드·거래·잔액 복원');

  const primaryContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const primary = await primaryContext.newPage();
  observe(primary);
  await primary.goto(base, { waitUntil: 'networkidle' });
  await nav('card', primary);
  await primary.getByTestId('card-apply').click();
  await finishApplication({ plan: 'plus', physical: false }, primary);
  assert.equal(await primary.getByTestId('card-demo-tools').evaluate((item) => item.open), false);
  const primaryState = await stateWhen((current) => current.card.stage === 'active', primary);
  assert.equal(primaryState.card.plan, 'plus');
  assert.equal(primaryState.card.physical, false);
  assert.equal(primaryState.card.delivery, 'none');
  assert.equal(primaryState.spend, 128_500);
  assert.equal(primaryState.payments.length, 0);
  assert.equal(await primary.getByTestId('card-demo-tools').count(), 0, '가상카드 발급 후에는 배송 체험 도구가 필요하지 않는다');
  pass('별도 새 세션에서 체험 도구 없이 Plus 가상카드 자동 발급');
  await primaryContext.close();

  const rewardContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const rewardPage = await rewardContext.newPage();
  observe(rewardPage);
  await rewardPage.goto(base, { waitUntil: 'networkidle' });
  await nav('card', rewardPage);
  await rewardPage.getByTestId('card-apply').click();
  await finishApplication({ plan: 'basic', physical: false }, rewardPage);
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
  await rewardPayment(5_800, { before: 4_280, used: 4_280, cashback: 15, after: 15 });
  await rewardPayment(5_800, { before: 15, used: 15, cashback: 57, after: 57 });
  await rewardPayment(5_800, { before: 57, used: 57, cashback: 57, after: 57 }, true);
  pass('동일 잔액 57원의 반복 결제도 영수증에서 사용 −57·새 페이백 +57을 구분');

  await rewardPayment(30, { before: 57, used: 30, cashback: 0, after: 27 });
  pass('리워드만 사용한 결제는 새 페이백 없이 잔액을 차감');

  await rewardPage.getByTestId('nav-settings').click();
  assert.equal(await rewardPage.getByTestId('rewards-auto').getAttribute('aria-checked'), 'true');
  await rewardPage.getByTestId('rewards-auto').click();
  await stateWhen((current) => !current.rewardsAuto, rewardPage);
  await rewardPayment(5_800, { before: 27, used: 0, cashback: 58, after: 85 });
  await rewardPage.getByTestId('nav-settings').click();
  assert.equal(await rewardPage.getByTestId('rewards-auto').getAttribute('aria-checked'), 'false');
  await rewardPage.getByTestId('rewards-auto').click();
  await stateWhen((current) => current.rewardsAuto, rewardPage);
  await rewardPayment(5_800, { before: 85, used: 85, cashback: 57, after: 57 });
  await rewardPage.getByTestId('open-rewards').click();
  const rewardBenefits = rewardPage.getByTestId('page-benefits');
  await rewardBenefits.waitFor({ state: 'visible' });
  assert.equal(await displayedAmount(rewardBenefits.getByTestId('cashback-confirmed')), 244);
  assert.equal(await displayedAmount(rewardBenefits.getByTestId('cashback-pending')), 0);
  assert.equal(await displayedAmount(rewardBenefits.getByTestId('cashback-remaining')), 9_756);
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

  const quoteContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const quotePage = await quoteContext.newPage();
  observe(quotePage);
  const quoteTime = Date.now();
  await quotePage.clock.setFixedTime(quoteTime);
  await quotePage.goto(base, { waitUntil: 'networkidle' });
  await stateWhen((current) => current.spend === 128_500, quotePage);
  await quotePage.getByTestId('open-deposit').click();
  const quoteDialog = quotePage.getByTestId('dialog-funding');
  await quoteDialog.waitFor({ state: 'visible' });
  const beforeExpiry = await read(quotePage);
  await quotePage.clock.setFixedTime(quoteTime + 31_000);
  await quotePage.waitForFunction(() => document.querySelector('[data-testid="quote-ttl"]')?.textContent === '견적 만료');
  assert.equal(await quoteDialog.getByTestId('confirm-action').isDisabled(), true);
  await quoteDialog.locator('form').evaluate((form) => form.requestSubmit());
  await quoteDialog.getByRole('alert').waitFor({ state: 'visible' });
  assert.match(await quoteDialog.getByRole('alert').innerText(), /견적이 만료/);
  const expiredState = await read(quotePage);
  assert.equal(expiredState.spend, beforeExpiry.spend);
  assert.equal(expiredState.reserve, beforeExpiry.reserve);
  assert.equal(expiredState.rewards, beforeExpiry.rewards);
  assert.deepEqual(expiredState.holdings, beforeExpiry.holdings);
  assert.equal(expiredState.transactions.length, beforeExpiry.transactions.length);
  await quoteDialog.getByTestId('refresh-quote').click();
  assert.match(await quoteDialog.getByTestId('quote-ttl').innerText(), /30초 유효/);
  assert.equal(await quoteDialog.getByTestId('confirm-action').isDisabled(), false);
  await quoteDialog.getByTestId('confirm-action').click();
  await quoteDialog.waitFor({ state: 'hidden' });
  const renewedState = await stateWhen((current) => current.spend === 142_430, quotePage);
  assert.deepEqual(renewedState.holdings, beforeExpiry.holdings);
  pass('31초 만료 견적은 제출해도 잔액 불변·갱신 후 입금 가능');
  await quoteContext.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', isMobile: true });
  const mobile = await mobileContext.newPage();
  observe(mobile);
  await mobile.goto(base, { waitUntil: 'networkidle' });
  for (const name of ['home', 'wallet', 'benefits', 'settings']) {
    await nav(name, mobile);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `모바일 ${name} 가로 넘침`);
  }
  for (const [name, parent] of [['card', 'home'], ['reserve', 'wallet'], ['activity', 'wallet']]) {
    await nav(name, mobile);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `모바일 상세 ${name} 가로 넘침`);
    assert.equal(await mobile.getByTestId(`nav-${parent}`).getAttribute('aria-current'), 'page');
    await mobile.getByTestId('go-back').click();
    assert.equal(await mobile.getByTestId('go-back').count(), 0, `모바일 상세 ${name}에서 진입 탭으로 복귀`);
    assert.equal(await mobile.getByTestId(`nav-${parent}`).getAttribute('aria-current'), 'page');
  }
  await mobile.getByTestId('nav-home').click();
  const mobileCard = await mobile.locator('.card-center .aqua-card-visual.acv-hero').boundingBox();
  assert.ok(mobileCard && mobileCard.width >= 330 && mobileCard.width <= 365, `390px 모바일 홈 카드 폭: ${mobileCard?.width}`);
  await mobile.screenshot({ path: new URL('aqua-mobile.png', artifacts).pathname, fullPage: true });
  await mobile.getByTestId('open-deposit').click();
  await mobile.getByTestId('funding-method-demo').click();
  await mobile.getByTestId('action-amount').fill('10000');
  await mobile.getByTestId('confirm-action').click();
  await mobile.getByTestId('dialog-funding').waitFor({ state: 'hidden' });
  assert.equal((await read(mobile)).spend, 138_500);
  pass('390px 모바일 큰 홈 카드·전체 메뉴·가로 넘침·체험 충전');

  assert.deepEqual(errors, [], '브라우저 실행 오류');
  assert.deepEqual([...new Set(external)], [], 'PoC는 외부 금융·폰트 요청을 하지 않는다');
  pass('브라우저 실행 오류 없음·외부 요청 없음');
  await writeFile(new URL('browser-results.json', artifacts), JSON.stringify({ passed: groups, failed: 0, skipped: 0, recordedAt: new Date().toISOString(), desktop: '1440×1050', mobile: '390×844', errors, external }, null, 2));
  console.log(`${groups} browser checks passed. Screenshots written to artifacts/.`);
} catch (error) {
  if (failurePage ?? page) await (failurePage ?? page).screenshot({ path: new URL('aqua-failure.png', artifacts).pathname, fullPage: true }).catch(() => {});
  console.error(error);
  await writeFile(new URL('browser-results.json', artifacts), JSON.stringify({ passed: groups, failed: 1, recordedAt: new Date().toISOString(), error: String(error), errors, external }, null, 2)).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
