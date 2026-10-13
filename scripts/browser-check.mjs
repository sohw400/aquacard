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
const pass = (name) => { groups += 1; console.log(`PASS ${groups}: ${name}`); };
const observe = (target) => {
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
  const read = () => page.evaluate(() => JSON.parse(localStorage.getItem('aqua-card:poc:v1')));
  async function stateWhen(predicate) {
    const deadline = Date.now() + 10_000;
    let state;
    while (Date.now() < deadline) {
      state = await read();
      if (state && predicate(state)) return state;
      await page.waitForTimeout(50);
    }
    assert.fail(`State did not reach expected condition: ${JSON.stringify(state)}`);
  }
  async function nav(name) { await page.getByTestId(`nav-${name}`).click(); }
  async function submitAmount(type, amount) {
    const dialog = page.getByTestId(`dialog-${type}`);
    await dialog.getByTestId('action-amount').fill(String(amount));
    await dialog.getByTestId('confirm-action').click();
    await dialog.waitFor({ state: 'hidden' });
  }
  const flow = () => page.locator('.card-flow');
  async function finishApplication() {
    await flow().getByRole('checkbox', { name: /샘플 프로필로 본인확인/ }).check();
    await flow().getByRole('checkbox', { name: /데모 이용약관/ }).check();
    await flow().getByRole('button', { name: '본인확인 완료 · 다음' }).click();
    await flow().getByRole('radio', { name: /Aqua Basic/ }).check();
    await flow().getByRole('button', { name: '플랜 선택 완료' }).click();
    await flow().getByRole('radio', { name: /가상카드 \+ 실물카드/ }).check();
    await flow().getByRole('button', { name: '신청 내용 확인' }).click();
    await flow().getByRole('checkbox', { name: /선택한 플랜/ }).check();
    await flow().getByRole('button', { name: '카드 신청 접수' }).click();
    return stateWhen((state) => state.card.stage === 'submitted');
  }

  let state = await stateWhen((state) => state.card.stage === 'not_applied');
  assert.equal(state.spend, 128_500);
  assert.equal(state.rewards, 4_280);
  assert.match(await page.getByTestId('available-balance').innerText(), /132,780/);
  await page.getByTestId('open-payment').click();
  await flow().waitFor();
  assert.equal((await read()).payments.length, 0);
  pass('초기 잔액과 미발급 카드 결제 차단');

  await flow().getByRole('button', { name: '카드 신청하기', exact: true }).click();
  assert.equal(await flow().getByRole('button', { name: '본인확인 완료 · 다음' }).isDisabled(), true);
  const initialSubmit = await finishApplication();
  await flow().getByRole('button', { name: '데모 보완 요청' }).click();
  await stateWhen((state) => state.card.stage === 'needs_info');
  await flow().getByRole('button', { name: '샘플 정보 확인 후 재제출' }).click();
  const secondSubmit = await finishApplication();
  assert.equal(secondSubmit.card.reference, initialSubmit.card.reference);
  assert.equal(secondSubmit.spend, initialSubmit.spend);
  await flow().getByRole('button', { name: '데모 심사 거절' }).click();
  await stateWhen((state) => state.card.stage === 'rejected');
  await flow().getByRole('button', { name: '신청 다시 시작' }).click();
  await finishApplication();
  pass('필수 동의·카드 선택·심사 보완·거절·재신청');

  await flow().getByRole('button', { name: '데모 심사 통과' }).click();
  await flow().getByRole('button', { name: '가상카드 발급', exact: true }).click();
  await stateWhen((state) => state.card.stage === 'issued');
  await flow().getByRole('button', { name: '가상카드 활성화', exact: true }).click();
  await flow().getByRole('button', { name: '데모 배송 시작' }).click();
  await flow().getByRole('button', { name: '데모 배송 완료' }).click();
  await flow().getByRole('button', { name: '실물카드 활성화', exact: true }).click();
  state = await stateWhen((state) => state.card.physicalActive);
  assert.equal(state.spend, 128_500, '모의 발급비는 실제 잔액에서 청구하지 않는다');
  await page.screenshot({ path: new URL('aqua-card.png', artifacts).pathname, fullPage: true });
  pass('대행사 승인·가상 발급·활성화·실물 배송·활성화');

  await flow().getByRole('button', { name: '카드 일시 잠금', exact: true }).click();
  await stateWhen((state) => state.card.locked);
  await nav('home');
  await page.getByTestId('open-payment').click();
  await flow().waitFor();
  assert.equal(await page.getByTestId('dialog-payment').count(), 0);
  await flow().getByRole('button', { name: '카드 잠금 해제', exact: true }).click();
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
  pass('잔액 부족과 옵트인 Reserve 자동 사용·결제 확정·페이백');

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
  await page.getByRole('button', { name: 'USDC 전환', exact: true }).click();
  await submitAmount('convert', 10);
  state = await stateWhen((state) => state.holdings.USDC === 90);
  assert.equal(state.spend, 209_650, '14,000원 평가액에서 전환비 70원을 공제');
  await page.getByRole('button', { name: 'USDC 입금', exact: true }).click();
  await submitAmount('asset', 10);
  await stateWhen((state) => state.holdings.USDC === 100);
  await page.getByRole('button', { name: 'USDC 출금', exact: true }).click();
  await submitAmount('asset', 5);
  await stateWhen((state) => state.holdings.USDC === 95);
  pass('코인 전환 수수료·모의 입금·출금');

  await nav('home');
  await page.getByTestId('open-deposit').click();
  await page.getByLabel('충전할 지갑').focus();
  await page.waitForTimeout(1_200);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'fund-bucket', '실시간 적립 중에도 입력 초점을 유지');
  await submitAmount('fund', 10_000);
  state = await stateWhen((state) => state.spend === 219_650);
  pass('모의 원화 충전과 실시간 갱신 중 모달 초점 유지');

  await nav('settings');
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
  await nav('reserve');
  const rewardsBefore = state.rewards;
  const claimed = Math.floor(state.accrued);
  await page.getByTestId('claim-rewards').click();
  state = await stateWhen((state) => state.rewards === rewardsBefore + claimed);
  assert.ok(state.accrued < 1);
  await page.screenshot({ path: new URL('aqua-reserve.png', artifacts).pathname, fullPage: true });
  pass('하루 적립·보상률 변경 구간·리워드 수령');

  const beforeReload = await read();
  await page.reload({ waitUntil: 'networkidle' });
  state = await stateWhen((state) => state.card.stage === 'active');
  assert.equal(state.spend, beforeReload.spend);
  assert.equal(state.reserve, beforeReload.reserve);
  assert.equal(state.rewards, beforeReload.rewards);
  assert.equal(state.holdings.USDC, 95);
  assert.equal(state.reserveRate, 0.08);
  assert.equal(state.payments[0].status, 'refunded');
  await nav('home');
  await page.screenshot({ path: new URL('aqua-desktop.png', artifacts).pathname, fullPage: true });
  pass('새로고침 후 카드·거래·잔액 복원');

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', isMobile: true });
  const mobile = await mobileContext.newPage();
  observe(mobile);
  await mobile.goto(base, { waitUntil: 'networkidle' });
  for (const name of ['home', 'wallet', 'card', 'reserve', 'activity', 'settings']) {
    await mobile.getByTestId(`nav-${name}`).click();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `모바일 ${name} 가로 넘침`);
  }
  await mobile.getByTestId('nav-home').click();
  await mobile.screenshot({ path: new URL('aqua-mobile.png', artifacts).pathname, fullPage: true });
  await mobile.getByTestId('open-deposit').click();
  await mobile.getByTestId('action-amount').fill('10000');
  await mobile.getByTestId('confirm-action').click();
  await mobile.getByTestId('dialog-fund').waitFor({ state: 'hidden' });
  pass('390px 모바일 전체 메뉴·가로 넘침·충전');

  assert.deepEqual(errors, [], '브라우저 실행 오류');
  assert.deepEqual([...new Set(external)], [], 'PoC는 외부 금융·폰트 요청을 하지 않는다');
  pass('브라우저 실행 오류 없음·외부 요청 없음');
  await writeFile(new URL('browser-results.json', artifacts), JSON.stringify({ passed: groups, failed: 0, skipped: 0, recordedAt: new Date().toISOString(), desktop: '1440×1050', mobile: '390×844', errors, external }, null, 2));
  console.log(`${groups} browser checks passed. Screenshots written to artifacts/.`);
} catch (error) {
  if (page) await page.screenshot({ path: new URL('aqua-failure.png', artifacts).pathname, fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
