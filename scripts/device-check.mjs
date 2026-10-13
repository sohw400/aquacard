import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, devices } from 'playwright-core';

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

/** Signs up by touch and checks every sign-up screen for horizontal overflow and 44px targets. */
async function signUp(page, name) {
  const tapTarget = async (testId) => {
    const target = page.getByTestId(testId);
    const box = await target.boundingBox();
    assert.ok(box && box.height >= 44, `${name} ${testId}: touch target smaller than 44px`);
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
  await page.getByTestId('kyc-occupation').selectOption('회사원');
  await page.getByTestId('kyc-purpose').selectOption('카드 결제');
  await page.getByTestId('kyc-source').selectOption('근로소득');
  await page.getByTestId('kyc-consent').check();
  await assertFits(page, `${name} customer questions`);
  await tapTarget('kyc-submit');
  await page.getByTestId('signup-finish').waitFor();
  await assertFits(page, `${name} sign-up done`);
  await tapTarget('signup-finish');
  await page.getByTestId('available-balance').waitFor();
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
    assert.ok(await page.evaluate(() => navigator.maxTouchPoints > 0));
    const heroCard = page.locator('.card-center .aqua-card-visual.acv-hero');
    const cardBounds = await heroCard.boundingBox();
    assert.ok(cardBounds && cardBounds.width >= profile.viewport.width - 50, `${name}: primary card is too small`);
    await assertFits(page, `${name} primary card`);
    const captureReview = name === 'iPhone SE (3rd gen)';
    if (captureReview) await page.screenshot({ path: new URL('review-card-home-375.png', artifacts).pathname, fullPage: true });
    for (const menu of ['home', 'wallet', 'benefits', 'settings']) {
      const nav = page.getByTestId(`nav-${menu}`);
      const bounds = await nav.boundingBox();
      assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, `${name} ${menu}: touch target smaller than 44px`);
      await nav.tap();
      await assertFits(page, `${name} ${menu}`);
    }

    await page.getByTestId('nav-home').tap();
    await page.getByTestId('card-cta').tap();
    await assertFits(page, `${name} card management detail`);
    const backTarget = await page.getByTestId('go-back').boundingBox();
    assert.ok(backTarget && backTarget.width >= 44 && backTarget.height >= 44, `${name}: detail back button is smaller than 44px`);
    await page.getByTestId('go-back').tap();
    assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');

    await page.getByTestId('nav-wallet').tap();
    await page.getByTestId('open-reserve').tap();
    await assertFits(page, `${name} Reserve detail`);
    await page.getByTestId('go-back').tap();
    assert.equal(await page.getByTestId('nav-wallet').getAttribute('aria-current'), 'page');
    await page.getByTestId('nav-activity').tap();
    await assertFits(page, `${name} activity detail`);
    await page.getByTestId('go-back').tap();
    assert.equal(await page.getByTestId('nav-wallet').getAttribute('aria-current'), 'page');

    await page.getByTestId('nav-settings').tap();
    await page.getByTestId('reserve-auto').tap();
    assert.equal(await page.getByTestId('reserve-auto').getAttribute('aria-checked'), 'true');
    const toggle = await page.getByTestId('reserve-auto').boundingBox();
    assert.ok(toggle.width >= 44 && toggle.height >= 44);

    await page.getByTestId('nav-home').tap();
    await page.getByTestId('open-deposit').tap();
    const funding = page.getByTestId('dialog-funding');
    await funding.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.tagName === 'H2' && !!document.activeElement.closest('[data-testid="dialog-funding"]'));
    for (const id of ['funding-origin-domestic', 'funding-origin-wallet', 'funding-asset-KRWS', 'funding-asset-USDC', 'funding-asset-USDT', 'funding-asset-BTC', 'funding-asset-ETH', 'funding-network-polygon', 'funding-next']) {
      const target = await funding.getByTestId(id).boundingBox();
      assert.ok(target && target.width >= 44 && target.height >= 44, `${name} ${id}: touch target smaller than 44px (${JSON.stringify(target)})`);
    }
    await selectFundingRoute(funding);
    const depositAmount = page.getByTestId('action-amount');
    assert.equal(await depositAmount.inputValue(), '');
    assert.ok(await depositAmount.evaluate((element) => parseFloat(getComputedStyle(element).fontSize) >= 16));
    await depositAmount.fill('10');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'action-amount');
    await funding.getByTestId('funding-next').tap();
    assert.equal(await page.locator('.toast').count(), 0, `${name}: toast overlays the funding sheet`);
    await assertAmount(funding.getByTestId('quote-units'), 10, `${name} default coin amount`);
    await assertAmount(funding.getByTestId('quote-fee'), 0, `${name} deposits carry no fee`);
    await assertAmount(funding.getByTestId('quote-network-fee'), 0, `${name} deposit network fee`);
    await assertAmount(funding.getByTestId('quote-net'), 14_000, `${name} received won balance preview`);
    assert.equal(await funding.getByTestId('confirm-action').isDisabled(), true);
    await funding.getByTestId('funding-consent').check();
    const viewportHeight = profile.viewport.height;
    const headerBefore = await funding.locator('.funding-header').boundingBox();
    const footerBefore = await funding.locator('.funding-footer').boundingBox();
    assert.ok(headerBefore.y >= 0 && footerBefore.y + footerBefore.height <= viewportHeight + 1, `${name}: funding controls are outside the viewport`);
    await funding.locator('.funding-body').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const headerAfter = await funding.locator('.funding-header').boundingBox();
    const footerAfter = await funding.locator('.funding-footer').boundingBox();
    assert.ok(Math.abs(headerAfter.y - headerBefore.y) <= 1 && Math.abs(footerAfter.y - footerBefore.y) <= 1, `${name}: funding header/footer moved while scrolling`);
    await assertFits(page, `${name} coin funding sheet`);
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
    await page.getByTestId('nav-wallet').tap();
    await page.getByTestId(`funding-open-${pendingDeposit.id}`).tap();
    assert.equal(await funding.getByTestId('funding-status').getAttribute('data-status'), 'awaiting_deposit');
    await funding.getByTestId('funding-simulate-deposit').tap();
    assert.equal((await readState()).spend, initial.spend);
    await waitFundingStatus(page, pendingDeposit.id, 'completed');
    const funded = await readState();
    const fundedSpend = initial.spend + 14_000;
    assert.equal(funded.spend, fundedSpend);
    assert.deepEqual(funded.holdings, initial.holdings);
    assert.equal(funded.fundingOperations.length, 1);
    await funding.getByTestId('funding-done').tap();
    await funding.waitFor({ state: 'hidden' });

    await page.getByTestId('wallet-withdraw').tap();
    await selectFundingRoute(funding);
    await funding.getByTestId('funding-recipient').fill('Aqua 테스트 지갑');
    await funding.getByTestId('funding-preview-address').tap();
    await funding.getByTestId('action-amount').fill('10000');
    await funding.getByTestId('funding-next').tap();
    await assertAmount(funding.getByTestId('quote-fee'), 50, `${name} withdrawal conversion fee`);
    await assertAmount(funding.getByTestId('quote-network-fee'), 140, `${name} withdrawal network fee`);
    await assertAmount(funding.getByTestId('quote-net'), 9_810, `${name} withdrawal net quote`);
    assert.equal(await funding.getByTestId('confirm-action').isDisabled(), true);
    const withdrawalConsent = funding.getByTestId('funding-consent');
    await withdrawalConsent.scrollIntoViewIfNeeded();
    const consentTarget = await withdrawalConsent.locator('..').boundingBox();
    const withdrawalFooter = await funding.locator('.funding-footer').boundingBox();
    assert.ok(consentTarget && consentTarget.width >= 44 && consentTarget.height >= 44, `${name}: withdrawal consent is smaller than 44px`);
    assert.ok(consentTarget.y + consentTarget.height <= withdrawalFooter.y + 1, `${name}: withdrawal consent is covered by the footer`);
    assert.ok(withdrawalFooter.y + withdrawalFooter.height <= viewportHeight + 1, `${name}: withdrawal footer is outside the viewport`);
    const withdrawalAction = await funding.getByTestId('confirm-action').boundingBox();
    assert.ok(withdrawalAction && withdrawalAction.width >= 44 && withdrawalAction.height >= 44);
    await assertFits(page, `${name} withdrawal review`);
    await withdrawalConsent.check();
    assert.equal(await funding.getByTestId('confirm-action').isDisabled(), true, `${name}: withdrawal needs the email code`);
    await verifyEmail(funding);
    await assertFits(page, `${name} withdrawal email check`);
    await funding.getByTestId('confirm-action').tap();
    await funding.getByTestId('funding-status').waitFor({ state: 'visible' });
    const pendingWithdrawal = (await readState()).fundingOperations[0];
    assert.equal(pendingWithdrawal.status, 'reviewing');
    assert.equal((await readState()).spend, fundedSpend - 10_000);
    await assertAmount(page.getByTestId('funding-held'), 10_000, `${name} withdrawal principal held`);
    await funding.getByTestId('funding-cancel').tap();
    await waitFundingStatus(page, pendingWithdrawal.id, 'cancelled');
    assert.equal((await readState()).spend, fundedSpend);
    assert.equal(await page.getByTestId('funding-held').count(), 0);
    await funding.getByRole('button', { name: '창 닫기', exact: true }).tap();
    await funding.waitFor({ state: 'hidden' });

    await page.getByTestId('wallet-deposit').tap();
    await prepareDeposit(funding, true);
    await funding.getByTestId('confirm-action').tap();
    await funding.getByTestId('funding-status').waitFor({ state: 'visible' });
    const failedDeposit = (await readState()).fundingOperations[0];
    assert.equal(failedDeposit.simulation, 'failure');
    await funding.getByTestId('funding-simulate-deposit').tap();
    await waitFundingStatus(page, failedDeposit.id, 'failed');
    assert.equal((await readState()).spend, fundedSpend);
    assert.deepEqual((await readState()).holdings, initial.holdings);
    await assertFits(page, `${name} failed deposit result`);
    await funding.getByRole('button', { name: '창 닫기', exact: true }).tap();
    await funding.waitFor({ state: 'hidden' });

    await page.getByTestId('open-reserve').tap();
    const internalTransfer = page.getByTestId('dialog-transfer');
    for (const [label, spend, reserve] of [['넣기', fundedSpend - 1_000, initial.reserve + 1_000], ['빼기', fundedSpend, initial.reserve]]) {
      await page.getByRole('button', { name: label, exact: true }).tap();
      assert.equal(await internalTransfer.getByTestId('action-amount').inputValue(), '');
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
    await page.getByTestId('nav-home').tap();

    await page.getByTestId('card-cta').tap();
    const flow = page.locator('.card-flow');
    await flow.getByTestId('card-apply').tap();
    assert.equal(await flow.getByTestId('card-identity-next').isDisabled(), true);
    await flow.getByTestId('card-identity-consent').check();
    await flow.getByTestId('card-identity-next').tap();
    await assertFits(page, `${name} card plan`);
    assert.equal(await flow.getByTestId('card-physical-choice').isChecked(), false);
    await flow.getByTestId('card-selection-next').tap();
    await assertFits(page, `${name} application review`);
    assert.equal(await flow.getByTestId('card-submit').isDisabled(), true);
    await flow.getByTestId('card-review-consent').check();
    await flow.getByTestId('card-submit').tap();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('aqua-card:poc:v1'))?.card.stage === 'active');
    const issued = await readState();
    assert.equal(issued.card.plan, 'basic');
    assert.equal(issued.card.physical, false);
    assert.equal(issued.card.identityVerified, true);
    assert.equal(issued.spend, fundedSpend);
    await assertFits(page, `${name} issued card`);

    await page.getByTestId('go-back').tap();
    assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page');
    await page.getByTestId('open-payment').tap();
    assert.ok(await page.getByLabel('결제처').evaluate((element) => parseFloat(getComputedStyle(element).fontSize) >= 16));
    await page.getByTestId('action-amount').fill('200000');
    await assertFits(page, `${name} payment modal`);
    await page.getByTestId('confirm-action').tap();
    await page.getByTestId('dialog-payment').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => {
      const state = JSON.parse(localStorage.getItem('aqua-card:poc:v1'));
      return state?.payments[0]?.status === 'completed';
    });
    const state = await readState();
    assert.equal(state.card.stage, 'active');
    assert.equal(state.payments[0].fromReserve, 53_220);
    assert.equal(state.payments[0].cashback, 1_957);
    assert.equal(state.rewards, 1_957);

    const receipt = page.getByTestId('payment-receipt');
    await assertAmount(receipt.getByTestId('receipt-rewards-before'), 4_280, `${name} rewards before payment`);
    await assertAmount(receipt.getByTestId('receipt-rewards-used'), -4_280, `${name} rewards used`);
    await assertAmount(receipt.getByTestId('receipt-cashback-earned'), 1_957, `${name} earned cashback`);
    await assertAmount(receipt.getByTestId('receipt-cashback-credit'), 1_957, `${name} credited cashback`);
    await assertAmount(receipt.getByTestId('receipt-rewards-after'), 1_957, `${name} rewards after payment`);
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
    await assertAmount(benefits.getByTestId('cashback-confirmed'), 1_957, `${name} confirmed monthly cashback`);
    await assertAmount(benefits.getByTestId('cashback-pending'), 0, `${name} pending monthly cashback`);
    await assertAmount(benefits.getByTestId('cashback-remaining'), 8_043, `${name} remaining monthly cashback`);
    await assertAmount(benefits.getByTestId('reward-balance'), 1_957, `${name} spendable reward balance`);
    assert.equal(await benefits.getByTestId('reserve-today').isVisible(), true);
    assert.match(await benefits.locator('.reserve-earnings').innerText(), /1원이 될 때마다 리워드에 바로 더해집니다/);
    assert.equal(await benefits.getByTestId('claim-rewards').count(), 0, `${name}: reserve rewards need no claim step`);
    const rewardsAuto = benefits.getByTestId('rewards-auto');
    const rewardsToggle = await rewardsAuto.boundingBox();
    assert.ok(rewardsToggle && rewardsToggle.width >= 44 && rewardsToggle.height >= 44, `${name} rewards setting: touch target smaller than 44px`);
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
    const safeName = name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
    await page.screenshot({ path: new URL(`${safeName}.png`, artifacts).pathname, fullPage: true });
    assert.deepEqual(errors, []);
    const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    results.push({ profile: name, engine: 'Chromium', emulationOnly: true, viewport: profile.viewport, hasTouch: profile.hasTouch, fontFamily, passed: true, checks: 'primary hero card, 4 primary tabs and 3 details with return navigation, touch targets, funding wizard fees/consent/focus trap/Escape, awaiting deposit close/reload/reopen and delayed credit, withdrawal review and cancellation with held-principal restoration, failed deposit without credit, internal transfer round trip, 3-step card application and automatic issue/activation, Reserve payment, reward receipt, unobstructed overlays, benefits and shared settings, restored payments and funding operations' });
    console.log(`PASS ${name}: ${profile.viewport.width}px · hero card · coin funding sheet · touch · application · Reserve payment · reward receipt · cashback overview · reload (Chromium emulation)`);
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
