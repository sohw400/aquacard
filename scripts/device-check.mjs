import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, devices } from 'playwright-core';

/** Expected amounts come from the app's own membership and funding terms. */
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
const artifacts = new URL('../artifacts/devices/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const profiles = ['iPhone SE', 'iPhone SE (3rd gen)', 'iPhone 15 Pro Max', 'Pixel 7', 'Galaxy S9+'];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/aqua-chromium-config', XDG_CACHE_HOME: '/tmp/aqua-chromium-cache' },
});
const results = [];

/** The demo starts every new account with these balances (engine createInitialState). */
const START = { spend: 128_500, reserve: 1_250_000, rewards: 4_280 };
const DEPOSIT_WON = 10 * FUNDING_ASSETS.USDC.price;
const WITHDRAWAL = 10_000;
const WITHDRAWAL_FEE = Math.ceil(WITHDRAWAL * POLICY.conversionFee - 1e-9);
const POLYGON_NETWORK_FEE = 140;
const MEMBER_TRANSFER = 10_000;
const PAYMENT = 200_000;
const paybackOf = (plan, paidWithoutRewards) => Math.min(Math.floor(paidWithoutRewards * PLANS[plan].cashbackRate), PLANS[plan].cashbackCap);

async function assertFits(page, description) {
  const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  if (size.scroll > size.width) {
    const nodes = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((node) => {
      const box = node.getBoundingClientRect();
      return box.right > innerWidth + 1 && box.width > 0;
    }).slice(0, 10).map((node) => ({ tag: node.tagName, class: node.className })));
    assert.fail(`${description}: horizontal overflow ${size.scroll}/${size.width}, ${JSON.stringify(nodes)}`);
  }
}

async function assertAmount(locator, expected, description) {
  const value = await locator.innerText();
  assert.match(value, /\d/, `${description}: amount is missing`);
  const amount = Number(value.replaceAll('−', '-').replace(/[^\d.-]/g, ''));
  assert.equal(amount, expected, description);
}

// Inside a transformed sheet Chromium measures in float32, so a 44px box far down the page can read 43.99994px.
const MIN_TOUCH = 44 - 0.01;

async function assertTouchTarget(locator, description) {
  const box = await locator.boundingBox();
  assert.ok(box && box.width >= MIN_TOUCH && box.height >= MIN_TOUCH, `${description}: touch target smaller than 44px (${JSON.stringify(box)})`);
}

async function assertFontSize(locator, description) {
  assert.ok(await locator.evaluate((element) => parseFloat(getComputedStyle(element).fontSize) >= 16), `${description}: input font is smaller than 16px and zooms on iOS`);
}

async function selectFundingRoute(funding) {
  await funding.getByTestId('funding-asset-USDC').tap();
  await funding.getByTestId('funding-network-polygon').tap();
  await funding.getByTestId('funding-next').tap();
}

async function prepareDeposit(funding, failure = false) {
  await selectFundingRoute(funding);
  await funding.getByTestId('action-amount').fill('10');
  if (failure) {
    await funding.getByTestId('funding-simulation-settings').tap();
    await funding.getByTestId('funding-outcome-failure').check();
  }
  await funding.getByTestId('funding-next').tap();
  await funding.getByTestId('funding-consent').check();
}

const sixDigits = async (locator) => (await locator.innerText()).match(/\d{6}/)[0];
const fourDigits = async (locator) => (await locator.innerText()).match(/\d{4}/)[0];

/** Signs up by touch and checks every sign-up screen for horizontal overflow and 44px targets. */
async function signUp(page, name) {
  const tapTarget = async (testId) => {
    const target = page.getByTestId(testId);
    const box = await target.boundingBox();
    assert.ok(box && box.height >= MIN_TOUCH, `${name} ${testId}: touch target smaller than 44px (${box?.height}px)`);
    await target.tap();
  };
  await assertFits(page, `${name} welcome`);
  await tapTarget('auth-signup');
  await page.getByTestId('signup-email-sample').tap();
  await tapTarget('signup-send-code');
  await page.getByTestId('signup-code').fill(await sixDigits(page.getByTestId('signup-demo-code')));
  await page.getByTestId('signup-password').fill('aqua2026pass');
  await page.getByTestId('signup-password-confirm').fill('aqua2026pass');
  await assertFits(page, `${name} sign-up account`);
  await tapTarget('signup-next');
  await page.getByTestId('kyc-sample').tap();
  await tapTarget('kyc-send-code');
  await page.getByTestId('kyc-code').fill(await sixDigits(page.getByTestId('kyc-demo-code')));
  await assertFits(page, `${name} phone check`);
  await tapTarget('kyc-next');
  await tapTarget('kyc-id-scan');
  await page.getByTestId('kyc-id-done').waitFor();
  await tapTarget('kyc-face-scan');
  await page.getByTestId('kyc-face-done').waitFor();
  await assertFits(page, `${name} ID and face check`);
  await tapTarget('kyc-id-next');
  await tapTarget('kyc-bank-sample');
  await tapTarget('kyc-bank-send');
  await page.getByTestId('kyc-bank-code').fill(await fourDigits(page.getByTestId('kyc-bank-demo-code')));
  await page.getByTestId('kyc-bank-verified').waitFor();
  await assertFits(page, `${name} 1 won account check`);
  await tapTarget('kyc-bank-next');
  await page.getByTestId('kyc-occupation').selectOption('회사원');
  await page.getByTestId('kyc-purpose').selectOption('카드 결제');
  await page.getByTestId('kyc-source').selectOption('근로소득');
  await page.getByTestId('kyc-consent').check();
  await assertFits(page, `${name} customer questions`);
  await tapTarget('kyc-submit');
  await page.getByTestId('signup-finish').waitFor();
  await assertFits(page, `${name} sign-up done`);
  await tapTarget('signup-finish');
  await page.getByTestId('spend-balance').waitFor();
}

async function verifyEmail(funding) {
  await funding.getByTestId('email-send').tap();
  await funding.getByTestId('email-code').fill(await sixDigits(funding.getByTestId('email-demo-code')));
  await funding.getByTestId('email-verified').waitFor();
}

async function waitFundingStatus(page, id, status) {
  await page.waitForFunction(({ operationId, expected }) => {
    const state = JSON.parse(localStorage.getItem('aqua-card:poc:v1'));
    return state?.fundingOperations?.find((operation) => operation.id === operationId)?.status === expected;
  }, { operationId: id, expected: status }, { timeout: 15_000 });
}

try {
  for (const name of profiles) {
    const { defaultBrowserType, ...profile } = devices[name];
    const context = await browser.newContext({ ...profile, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);
    await page.goto(base, { waitUntil: 'networkidle' });
    await signUp(page, name);
    const readState = () => page.evaluate(() => JSON.parse(localStorage.getItem('aqua-card:poc:v1')));
    const initial = await readState();
    assert.deepEqual([initial.spend, initial.reserve, initial.rewards], [START.spend, START.reserve, START.rewards]);
    assert.ok(await page.evaluate(() => navigator.maxTouchPoints > 0));
    const viewportWidth = profile.viewport.width;
    const viewportHeight = profile.viewport.height;

    // Home leads with the balance, 충전·보내기 and the card offer.
    await assertAmount(page.getByTestId('spend-balance'), START.spend, `${name} home balance`);
    for (const id of ['open-deposit', 'open-send', 'open-payment', 'open-reserve-card', 'open-rewards', 'nav-activity']) await assertTouchTarget(page.getByTestId(id), `${name} ${id}`);
    const cardOffer = await page.getByTestId('open-payment').boundingBox();
    assert.ok(cardOffer && cardOffer.width >= viewportWidth - 50, `${name}: card offer button does not span the screen`);
    await assertFits(page, `${name} home`);
    const captureReview = name === 'iPhone SE (3rd gen)';
    if (captureReview) await page.screenshot({ path: new URL('review-card-home-375.png', artifacts).pathname, fullPage: true });
    for (const menu of ['home', 'card', 'benefits', 'settings']) {
      const nav = page.getByTestId(`nav-${menu}`);
      await assertTouchTarget(nav, `${name} ${menu}`);
      await nav.tap();
      assert.equal(await nav.getAttribute('aria-current'), 'page');
      await assertFits(page, `${name} ${menu}`);
    }

    await page.getByTestId('nav-home').tap();
    await page.getByTestId('open-reserve-card').tap();
    await assertFits(page, `${name} Reserve detail`);
    await assertTouchTarget(page.getByTestId('go-back'), `${name} detail back button`);
    await page.getByTestId('go-back').tap();
    assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');
    await page.getByTestId('nav-activity').tap();
    await assertFits(page, `${name} activity detail`);
    await page.getByTestId('go-back').tap();
    assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');
    await page.getByTestId('nav-settings').tap();
    await page.getByTestId('open-limits').tap();
    await assertFits(page, `${name} limits detail`);
    await page.getByTestId('go-back').tap();
    assert.equal(await page.getByTestId('nav-settings').getAttribute('aria-current'), 'page');

    await page.getByTestId('reserve-auto').tap();
    assert.equal(await page.getByTestId('reserve-auto').getAttribute('aria-checked'), 'true');
    await assertTouchTarget(page.getByTestId('reserve-auto'), `${name} Reserve payment setting`);

    // 충전 from home: coin and network, quote, consent, focus trap, Escape.
    await page.getByTestId('nav-home').tap();
    await page.getByTestId('open-deposit').tap();
    const funding = page.getByTestId('dialog-funding');
    await funding.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.tagName === 'H2' && !!document.activeElement.closest('[data-testid="dialog-funding"]'));
    for (const id of ['funding-origin-domestic', 'funding-origin-wallet', 'funding-asset-KRWS', 'funding-asset-USDC', 'funding-asset-USDT', 'funding-asset-BTC', 'funding-asset-ETH', 'funding-network-polygon', 'funding-next']) {
      await assertTouchTarget(funding.getByTestId(id), `${name} ${id}`);
    }
    await selectFundingRoute(funding);
    const depositAmount = page.getByTestId('action-amount');
    assert.equal(await depositAmount.inputValue(), '');
    await assertFontSize(depositAmount, `${name} deposit amount`);
    await depositAmount.fill('10');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'action-amount');
    await funding.getByTestId('funding-next').tap();
    assert.equal(await page.locator('.toast').count(), 0, `${name}: toast overlays the funding sheet`);
    await assertAmount(funding.getByTestId('quote-units'), 10, `${name} default coin amount`);
    await assertAmount(funding.getByTestId('quote-fee'), 0, `${name} deposits carry no fee`);
    assert.equal(await funding.getByTestId('quote-network-fee').count(), 0, `${name} deposits show no network fee row`);
    await assertAmount(funding.getByTestId('quote-net'), DEPOSIT_WON, `${name} received won balance preview`);
    assert.equal(await funding.getByTestId('confirm-action').isDisabled(), true);
    await funding.getByTestId('funding-consent').check();
    const headerBefore = await funding.locator('.funding-header').boundingBox();
    const footerBefore = await funding.locator('.funding-footer').boundingBox();
    assert.ok(headerBefore.y >= 0 && footerBefore.y + footerBefore.height <= viewportHeight + 1, `${name}: funding controls are outside the viewport`);
    await funding.locator('.funding-body').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const headerAfter = await funding.locator('.funding-header').boundingBox();
    const footerAfter = await funding.locator('.funding-footer').boundingBox();
    assert.ok(Math.abs(headerAfter.y - headerBefore.y) <= 1 && Math.abs(footerAfter.y - footerBefore.y) <= 1, `${name}: funding header/footer moved while scrolling`);
    await assertFits(page, `${name} deposit sheet`);
    if (captureReview) await page.screenshot({ path: new URL('review-coin-funding-375.png', artifacts).pathname });
    await funding.getByTestId('funding-back').focus();
    await page.keyboard.press('Shift+Tab');
    assert.ok(await funding.getByTestId('confirm-action').evaluate((element) => element === document.activeElement), `${name}: focus did not wrap to funding confirmation`);
    await page.keyboard.press('Tab');
    assert.ok(await funding.getByTestId('funding-back').evaluate((element) => element === document.activeElement), `${name}: focus escaped funding dialog`);
    await page.keyboard.press('Escape');
    await funding.waitFor({ state: 'hidden' });
    assert.equal((await readState()).spend, initial.spend);
    assert.equal((await readState()).fundingOperations.length, 0);
    await page.getByTestId('open-deposit').tap();
    await prepareDeposit(funding);
    await funding.getByTestId('confirm-action').tap();
    await funding.getByTestId('funding-status').waitFor({ state: 'visible' });
    const pendingDeposit = (await readState()).fundingOperations[0];
    assert.equal(pendingDeposit.status, 'awaiting_deposit');
    assert.equal((await readState()).spend, initial.spend);
    await funding.getByRole('button', { name: '창 닫기', exact: true }).tap();
    await funding.waitFor({ state: 'hidden' });
    await page.reload({ waitUntil: 'networkidle' });
    const resumedState = await readState();
    assert.equal(resumedState.fundingOperations[0].id, pendingDeposit.id);
    assert.equal(resumedState.fundingOperations[0].status, 'awaiting_deposit');
    assert.equal(resumedState.spend, initial.spend);
    const homeStatus = page.getByTestId('home-funding-status');
    await assertTouchTarget(homeStatus, `${name} pending funding status`);
    await homeStatus.tap();
    assert.equal(await funding.getByTestId('funding-status').getAttribute('data-status'), 'awaiting_deposit');
    await funding.getByTestId('funding-simulate-deposit').tap();
    assert.equal((await readState()).spend, initial.spend);
    await waitFundingStatus(page, pendingDeposit.id, 'completed');
    const funded = await readState();
    const fundedSpend = initial.spend + DEPOSIT_WON;
    assert.equal(funded.spend, fundedSpend);
    assert.equal(funded.fundingOperations.length, 1);
    await funding.getByTestId('funding-done').tap();
    await funding.waitFor({ state: 'hidden' });

    // 보내기 › 지갑 주소로: review, consent above the footer, email code, held principal and cancellation.
    await page.getByTestId('open-send').tap();
    const send = page.getByTestId('send-sheet');
    await send.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.tagName === 'H2' && !!document.activeElement.closest('[data-testid="send-sheet"]'));
    for (const id of ['send-member', 'send-scan', 'send-wallet', 'send-own-qr']) await assertTouchTarget(send.getByTestId(id), `${name} ${id}`);
    await assertFits(page, `${name} send choice`);
    await send.getByTestId('send-wallet').tap();
    await send.waitFor({ state: 'hidden' });
    await funding.waitFor({ state: 'visible' });
    await selectFundingRoute(funding);
    await assertTouchTarget(funding.getByTestId('funding-venue-upbit'), `${name} exchange choice`);
    await funding.getByTestId('funding-venue-upbit').tap();
    await assertTouchTarget(funding.getByTestId('funding-relation-other'), `${name} recipient choice`);
    await funding.getByTestId('funding-preview-address').tap();
    await funding.getByTestId('action-amount').fill(String(WITHDRAWAL));
    await funding.getByTestId('funding-next').tap();
    await assertAmount(funding.getByTestId('quote-fee'), WITHDRAWAL_FEE, `${name} withdrawal conversion fee`);
    await assertAmount(funding.getByTestId('quote-network-fee'), POLYGON_NETWORK_FEE, `${name} withdrawal network fee`);
    await assertAmount(funding.getByTestId('quote-net'), WITHDRAWAL - WITHDRAWAL_FEE - POLYGON_NETWORK_FEE, `${name} withdrawal net quote`);
    assert.equal(await funding.getByTestId('confirm-action').isDisabled(), true);
    const withdrawalConsent = funding.getByTestId('funding-consent');
    await withdrawalConsent.scrollIntoViewIfNeeded();
    const consentTarget = await withdrawalConsent.locator('..').boundingBox();
    const withdrawalFooter = await funding.locator('.funding-footer').boundingBox();
    assert.ok(consentTarget && consentTarget.width >= 44 && consentTarget.height >= 44, `${name}: withdrawal consent is smaller than 44px`);
    assert.ok(consentTarget.y + consentTarget.height <= withdrawalFooter.y + 1, `${name}: withdrawal consent is covered by the footer`);
    assert.ok(withdrawalFooter.y + withdrawalFooter.height <= viewportHeight + 1, `${name}: withdrawal footer is outside the viewport`);
    await assertTouchTarget(funding.getByTestId('confirm-action'), `${name} withdrawal confirmation`);
    await assertFits(page, `${name} withdrawal review`);
    await withdrawalConsent.check();
    assert.equal(await funding.getByTestId('confirm-action').isDisabled(), true, `${name}: withdrawal needs the email code`);
    await verifyEmail(funding);
    await assertFits(page, `${name} withdrawal email check`);
    await funding.getByTestId('confirm-action').tap();
    await funding.getByTestId('funding-status').waitFor({ state: 'visible' });
    const pendingWithdrawal = (await readState()).fundingOperations[0];
    assert.equal(pendingWithdrawal.status, 'reviewing');
    assert.equal((await readState()).spend, fundedSpend - WITHDRAWAL);
    await assertAmount(page.getByTestId('funding-held'), WITHDRAWAL, `${name} withdrawal principal held`);
    await funding.getByTestId('funding-cancel').tap();
    await waitFundingStatus(page, pendingWithdrawal.id, 'cancelled');
    assert.equal((await readState()).spend, fundedSpend);
    assert.equal(await page.getByTestId('funding-held').count(), 0);
    await funding.getByRole('button', { name: '창 닫기', exact: true }).tap();
    await funding.waitFor({ state: 'hidden' });

    await page.getByTestId('open-deposit').tap();
    await prepareDeposit(funding, true);
    await funding.getByTestId('confirm-action').tap();
    await funding.getByTestId('funding-status').waitFor({ state: 'visible' });
    const failedDeposit = (await readState()).fundingOperations[0];
    assert.equal(failedDeposit.simulation, 'failure');
    await funding.getByTestId('funding-simulate-deposit').tap();
    await waitFundingStatus(page, failedDeposit.id, 'failed');
    assert.equal((await readState()).spend, fundedSpend);
    await assertFits(page, `${name} failed deposit result`);
    await funding.getByRole('button', { name: '창 닫기', exact: true }).tap();
    await funding.waitFor({ state: 'hidden' });

    await page.getByTestId('open-reserve-card').tap();
    const internalTransfer = page.getByTestId('dialog-transfer');
    for (const [label, spend, reserve] of [['넣기', fundedSpend - 1_000, initial.reserve + 1_000], ['빼기', fundedSpend, initial.reserve]]) {
      await page.getByRole('button', { name: label, exact: true }).tap();
      assert.equal(await internalTransfer.getByTestId('action-amount').inputValue(), '');
      await assertFontSize(internalTransfer.getByTestId('action-amount'), `${name} Reserve amount`);
      await internalTransfer.getByTestId('action-amount').fill('1000');
      await internalTransfer.getByTestId('transfer-next').tap();
      await assertFits(page, `${name} internal transfer review`);
      await internalTransfer.getByTestId('confirm-action').tap();
      await internalTransfer.getByTestId('transfer-completed').waitFor({ state: 'visible' });
      assert.equal((await readState()).spend, spend);
      assert.equal((await readState()).reserve, reserve);
      await internalTransfer.getByTestId('transfer-done').tap();
      await internalTransfer.waitFor({ state: 'hidden' });
    }
    await page.getByTestId('go-back').tap();
    assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');

    // 보내기 › Aqua 회원에게: search, pick, amount, review, done.
    await page.getByTestId('open-send').tap();
    await send.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await send.waitFor({ state: 'hidden' });
    await page.getByTestId('open-send').tap();
    await send.getByTestId('send-member').tap();
    const tagInput = send.getByTestId('send-tag');
    await assertFontSize(tagInput, `${name} member tag`);
    await assertTouchTarget(tagInput.locator('..'), `${name} member tag field`);
    await assertTouchTarget(send.getByTestId('send-pick-minji.k'), `${name} member pick`);
    await assertTouchTarget(send.getByRole('button', { name: '이전', exact: true }), `${name} send back button`);
    await assertFits(page, `${name} member search`);
    await send.getByTestId('send-pick-minji.k').tap();
    const transferAmount = send.getByTestId('send-amount');
    await assertFontSize(transferAmount, `${name} transfer amount`);
    await transferAmount.fill(String(MEMBER_TRANSFER));
    await assertTouchTarget(send.getByTestId('send-next'), `${name} transfer next`);
    await assertFits(page, `${name} transfer amount`);
    await send.getByTestId('send-next').tap();
    await assertAmount(send.getByTestId('send-review-amount'), MEMBER_TRANSFER, `${name} transfer review amount`);
    await page.keyboard.press('Tab');
    assert.ok(await send.evaluate((element) => element.contains(document.activeElement)), `${name}: focus escaped the send sheet`);
    await assertFits(page, `${name} transfer review`);
    if (captureReview) await page.screenshot({ path: new URL('review-member-transfer-375.png', artifacts).pathname });
    assert.equal((await readState()).spend, fundedSpend, `${name}: review step must not send`);
    await send.getByTestId('send-confirm').tap();
    await send.getByTestId('send-done').waitFor({ state: 'visible' });
    const sentSpend = fundedSpend - MEMBER_TRANSFER;
    const afterTransfer = await readState();
    assert.equal(afterTransfer.spend, sentSpend);
    assert.deepEqual([afterTransfer.transactions[0].title, afterTransfer.transactions[0].amount], ['김*지님에게 보냄', -MEMBER_TRANSFER]);
    await assertFits(page, `${name} transfer done`);
    await send.getByTestId('send-close').tap();
    await send.waitFor({ state: 'hidden' });
    await assertAmount(page.getByTestId('spend-balance'), sentSpend, `${name} balance after member transfer`);

    // 내 태그와 QR, 태그 바꾸기, 체험용 QR 찍기
    await page.getByTestId('open-send').tap();
    await send.getByTestId('send-own-qr').tap();
    const receive = page.getByTestId('receive-sheet');
    await receive.waitFor({ state: 'visible' });
    for (const id of ['receive-copy', 'receive-edit', 'find-by-phone', 'find-by-email', 'receive-demo']) await assertTouchTarget(receive.getByTestId(id), `${name} ${id}`);
    const qrBox = await receive.locator('svg.qr-code').boundingBox();
    assert.ok(qrBox && qrBox.width >= 150, `${name}: my QR code is too small to scan (${qrBox?.width}px)`);
    await assertFits(page, `${name} my tag and QR`);
    await receive.getByTestId('receive-edit').tap();
    await assertFontSize(receive.getByTestId('tag-input'), `${name} tag input`);
    await assertTouchTarget(receive.getByTestId('tag-save'), `${name} tag save`);
    await assertFits(page, `${name} tag edit`);
    await page.keyboard.press('Escape');
    await receive.waitFor({ state: 'hidden' });
    await page.getByTestId('open-send').tap();
    await send.getByTestId('send-scan').tap();
    await assertTouchTarget(send.getByTestId('send-scan-minji.k'), `${name} QR pick`);
    await assertFits(page, `${name} QR scan`);
    await send.getByTestId('send-scan-minji.k').tap();
    await send.getByTestId('send-amount').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await send.waitFor({ state: 'hidden' });

    // 연간 거래 내역
    await page.getByTestId('nav-activity').tap();
    await assertTouchTarget(page.getByTestId('open-statement'), `${name} open statement`);
    await page.getByTestId('open-statement').tap();
    await page.getByTestId('page-statement').waitFor({ state: 'visible' });
    await assertTouchTarget(page.getByTestId('statement-copy'), `${name} statement copy`);
    await assertFits(page, `${name} annual statement`);
    await page.getByTestId('nav-home').tap();
    await page.getByTestId('spend-balance').waitFor({ state: 'visible' });

    // Card tab: three-step application, automatic issue and the full-width card.
    await page.getByTestId('nav-card').tap();
    const flow = page.locator('.card-flow');
    await assertTouchTarget(flow.getByTestId('card-apply'), `${name} card apply`);
    await flow.getByTestId('card-apply').tap();
    assert.equal(await flow.getByTestId('card-identity-next').isDisabled(), true);
    await assertTouchTarget(flow.getByTestId('card-identity-consent').locator('..'), `${name} identity consent`);
    await flow.getByTestId('card-identity-consent').check();
    await flow.getByTestId('card-identity-next').tap();
    await assertFits(page, `${name} membership choice`);
    for (const key of ['standard', 'premium', 'private']) await assertTouchTarget(flow.getByRole('radio', { name: PLANS[key].short }).locator('..'), `${name} ${PLANS[key].short} option`);
    assert.equal(await flow.getByRole('radio', { name: PLANS.standard.short }).isChecked(), true);
    assert.equal(await flow.getByTestId('card-physical-choice').isChecked(), false);
    await flow.getByTestId('card-selection-next').tap();
    await assertFits(page, `${name} application review`);
    assert.equal(await flow.getByTestId('card-fee-total').innerText(), '없음', `${name}: Standard virtual card costs nothing`);
    assert.equal(await flow.getByTestId('card-submit').isDisabled(), true);
    await flow.getByTestId('card-review-consent').check();
    await flow.getByTestId('card-submit').tap();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('aqua-card:poc:v1'))?.card.stage === 'active');
    const issued = await readState();
    assert.equal(issued.card.plan, 'standard');
    assert.equal(issued.card.physical, false);
    assert.equal(issued.card.identityVerified, true);
    assert.equal(issued.spend, sentSpend);
    await flow.locator('.cf-hero .aqua-card-visual.acv-hero').waitFor();
    const heroCard = await flow.locator('.cf-hero .aqua-card-visual.acv-hero').boundingBox();
    assert.ok(heroCard && heroCard.width >= viewportWidth - 50, `${name}: card is too small (${heroCard?.width})`);
    for (const id of ['card-details-toggle', 'card-lock-toggle', 'card-pay', 'wallet-add-samsung', 'wallet-add-apple', 'card-plan-premium', 'card-plan-private']) await assertTouchTarget(flow.getByTestId(id), `${name} ${id}`);
    await assertFits(page, `${name} issued card`);

    await page.getByTestId('nav-home').tap();
    assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');
    await page.getByTestId('open-payment').tap();
    await assertFontSize(page.getByLabel('결제할 곳'), `${name} merchant`);
    await page.getByTestId('action-amount').fill(String(PAYMENT));
    await assertFits(page, `${name} payment modal`);
    await page.getByTestId('confirm-action').tap();
    await page.getByTestId('dialog-payment').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => {
      const state = JSON.parse(localStorage.getItem('aqua-card:poc:v1'));
      return state?.payments[0]?.status === 'completed';
    });
    const state = await readState();
    const cashback = paybackOf('standard', PAYMENT - initial.rewards);
    assert.equal(state.card.stage, 'active');
    assert.deepEqual([state.payments[0].fromRewards, state.payments[0].fromSpend, state.payments[0].fromReserve], [initial.rewards, sentSpend, PAYMENT - initial.rewards - sentSpend]);
    assert.equal(state.payments[0].cashback, cashback);
    assert.equal(state.rewards, cashback);

    const receipt = page.getByTestId('payment-receipt');
    await assertAmount(receipt.getByTestId('receipt-rewards-before'), initial.rewards, `${name} rewards before payment`);
    await assertAmount(receipt.getByTestId('receipt-rewards-used'), -initial.rewards, `${name} rewards used`);
    await assertAmount(receipt.getByTestId('receipt-cashback-earned'), cashback, `${name} earned cashback`);
    await assertAmount(receipt.getByTestId('receipt-cashback-credit'), cashback, `${name} credited cashback`);
    await assertAmount(receipt.getByTestId('receipt-rewards-after'), cashback, `${name} rewards after payment`);
    assert.equal(await page.locator('.toast').count(), 0, `${name}: toast overlays the payment receipt`);
    await assertFits(page, `${name} payment receipt`);
    if (captureReview) {
      await receipt.getByTestId('receipt-rewards-after').scrollIntoViewIfNeeded();
      await page.screenshot({ path: new URL('review-payment-receipt-375.png', artifacts).pathname });
    }
    await receipt.getByTestId('receipt-close').tap();
    await receipt.waitFor({ state: 'hidden' });

    await page.getByTestId('open-rewards').tap();
    const benefits = page.getByTestId('page-benefits');
    await assertAmount(benefits.getByTestId('cashback-confirmed'), cashback, `${name} confirmed monthly cashback`);
    await assertAmount(benefits.getByTestId('cashback-pending'), 0, `${name} pending monthly cashback`);
    await assertAmount(benefits.getByTestId('cashback-remaining'), PLANS.standard.cashbackCap - cashback, `${name} remaining monthly cashback`);
    await assertAmount(benefits.getByTestId('reward-balance'), cashback, `${name} spendable reward balance`);
    assert.equal(await benefits.getByTestId('reserve-today').isVisible(), true);
    assert.match(await benefits.innerText(), /받기 버튼 없이 바로 쌓여요/);
    assert.equal(await benefits.getByTestId('claim-rewards').count(), 0, `${name}: reserve rewards need no claim step`);
    const rewardsAuto = benefits.getByTestId('rewards-auto');
    await assertTouchTarget(rewardsAuto, `${name} rewards setting`);
    assert.equal(await rewardsAuto.getAttribute('aria-checked'), 'true');
    await rewardsAuto.tap();
    assert.equal(await rewardsAuto.getAttribute('aria-checked'), 'false');
    assert.equal((await readState()).rewardsAuto, false);
    await rewardsAuto.tap();
    assert.equal(await rewardsAuto.getAttribute('aria-checked'), 'true');
    assert.equal((await readState()).rewardsAuto, true);
    await assertFits(page, `${name} rewards and cashback overview`);
    await page.getByTestId('nav-settings').tap();
    assert.equal(await page.getByTestId('rewards-auto').getAttribute('aria-checked'), 'true');
    await page.getByTestId('nav-home').tap();
    await benefits.waitFor({ state: 'hidden' });

    await page.reload({ waitUntil: 'networkidle' });
    await assertFits(page, `${name} restored home`);
    const restored = await readState();
    assert.equal(restored.card.stage, 'active');
    assert.equal(restored.reserveAuto, true);
    assert.equal(restored.rewardsAuto, true);
    assert.equal(restored.spend, state.spend);
    assert.equal(restored.reserve, state.reserve);
    assert.equal(restored.rewards, state.rewards);
    assert.deepEqual(restored.payments, state.payments);
    assert.deepEqual(restored.fundingOperations, state.fundingOperations);
    await assertAmount(page.getByTestId('spend-balance'), restored.spend, `${name} restored balance`);
    const safeName = name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
    await page.screenshot({ path: new URL(`${safeName}.png`, artifacts).pathname, fullPage: true });
    assert.deepEqual(errors, []);
    const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    results.push({ profile: name, engine: 'Chromium', emulationOnly: true, viewport: profile.viewport, hasTouch: profile.hasTouch, fontFamily, passed: true, checks: 'home balance with 충전·보내기 and card offer, 4 primary tabs and 3 details with return navigation, touch targets, deposit sheet fees/consent/focus trap/Escape, awaiting deposit close/reload/reopen from the home status line and delayed credit, 보내기 › 지갑 주소로 review and cancellation with held-principal restoration, failed deposit without credit, Reserve round trip, member transfer by tag with focus kept in the sheet, 3-step card application with automatic issue and full-width card, Reserve payment, reward receipt, unobstructed overlays, benefits and shared settings, restored payments and funding operations' });
    console.log(`PASS ${name}: ${profile.viewport.width}px · home balance · deposit and send sheets · member transfer · my tag and QR · annual statement · touch · application · card · Reserve payment · reward receipt · cashback overview · reload (Chromium emulation)`);
    await context.close();
  }
  await writeFile(new URL('results.json', artifacts), JSON.stringify({ passedProfiles: results.length, failedProfiles: 0, recordedAt: new Date().toISOString(), realDeviceTested: false, safariWebKitTested: false, results }, null, 2));
  console.log(`${results.length} device profiles passed. This does not validate iOS Safari or Android hardware.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
