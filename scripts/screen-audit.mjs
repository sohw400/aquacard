/**
 * Walks every screen, sheet and step of the demo, takes screenshots and runs the layout checks on each.
 *
 *   node scripts/screen-audit.mjs [phone] [small] [dark] [desktop]
 *
 * Screenshots and report.json go to artifacts/screens/<profile>/. Needs the dev server (AQUA_BASE_URL).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { lintInteraction, lintLayout, recordShifts } from './layout-lint.mjs';

const base = process.env.AQUA_BASE_URL ?? 'http://127.0.0.1:5173';
const PROFILES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  small: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  dark: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
};
const chosen = process.argv.slice(2).filter((name) => PROFILES[name]);
const PASSWORD = 'aqua2026pass';
const NEW_PASSWORD = 'aqua2027pass';
const sixDigits = async (locator) => (await locator.innerText()).match(/\d{6}/)[0];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/aqua-chromium-config', XDG_CACHE_HOME: '/tmp/aqua-chromium-cache' },
});

let failures = 0;
try {
  for (const name of chosen.length ? chosen : ['phone']) await audit(name, PROFILES[name]);
} finally {
  await browser.close();
}
if (failures) process.exitCode = 1;

async function audit(profileName, profile) {
  const out = new URL(`../artifacts/screens/${profileName}/`, import.meta.url);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const report = [];
  const snapshots = new URL('_state/', out);
  await mkdir(snapshots, { recursive: true });
  let counter = 0;
  const options = { ...profile, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' };

  async function open(snapshot) {
    const context = await browser.newContext({ ...options, ...(snapshot ? { storageState: new URL(`${snapshot}.json`, snapshots).pathname } : {}) });
    await context.grantPermissions([], { origin: base });
    await context.addInitScript(recordShifts);
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    page.on('pageerror', (error) => { failures += 1; console.log(`  page error: ${error.message}`); });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    return page;
  }
  async function save(page, snapshot) {
    await page.context().storageState({ path: new URL(`${snapshot}.json`, snapshots).pathname });
  }
  async function settle(page) {
    await page.waitForTimeout(120);
    await page.evaluate(async () => {
      await document.fonts.ready;
      const deadline = Date.now() + 800;
      while (Date.now() < deadline && document.getAnimations().some((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity)) await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }
  async function dismissToast(page) {
    const close = page.locator('.toast-close');
    if (await close.count()) await close.first().click().catch(() => {});
  }
  /** Screenshot the screen (and the rest of a long page or sheet, a viewport at a time) and run the layout checks. */
  async function shot(page, label, { keepToast = false, quick = false } = {}) {
    counter += 1;
    const id = `${String(counter).padStart(3, '0')}-${label}`;
    if (!quick) await settle(page);
    if (!keepToast) await dismissToast(page);
    const scroller = await page.evaluateHandle(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter((element) => element.getClientRects().length);
      const dialog = dialogs.at(-1);
      if (!dialog) return document.scrollingElement;
      const candidates = [dialog, ...dialog.querySelectorAll('*')].filter((element) => { const style = getComputedStyle(element); return /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 4; });
      return candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? null;
    });
    const positions = await page.evaluate((element) => {
      if (!element) return [0];
      const max = element.scrollHeight - element.clientHeight;
      if (max <= 4) return [0];
      const step = Math.max(200, element.clientHeight - (element === document.scrollingElement ? 170 : 72));
      const list = [];
      for (let top = 0; top < max; top += step) list.push(top);
      list.push(max);
      return list.slice(0, 7);
    }, scroller);
    const files = [];
    const issues = new Map();
    for (const [index, top] of positions.entries()) {
      await page.evaluate(([element, value]) => { if (element) element.scrollTop = value; }, [scroller, top]);
      if (positions.length > 1) await page.waitForTimeout(60);
      const file = `${id}${positions.length > 1 ? `-${index + 1}` : ''}.png`;
      await page.screenshot({ path: new URL(file, out).pathname });
      files.push(file);
      const lint = await lintLayout(page, { gutter: profileName === 'desktop' ? 0 : 16 });
      for (const issue of lint.issues) issues.set(`${issue.type}|${issue.where}|${issue.text}`, issue);
    }
    await page.evaluate((element) => { if (element) element.scrollTop = 0; }, scroller);
    await scroller.dispose();
    for (const issue of await lintInteraction(page, { hover: profileName === 'desktop' })) issues.set(`${issue.type}|${issue.where}|${issue.text}`, { ...issue, severity: 'info', detail: '' });
    // Let the last click's shift check finish so it is filed under this screen, not the next one.
    await page.waitForFunction(() => !window.__aquaShiftsPending, null, { timeout: 2_000 }).catch(() => {});
    const shifts = await page.evaluate(() => (window.__aquaShifts ?? []).splice(0));
    report.push({ id, label, files, issues: [...issues.values()], shifts });
    console.log(`  ${id} ${files.length} shot(s), ${issues.size} issue(s)${shifts.length ? `, ${shifts.length} shift(s)` : ''}`);
  }
  async function section(label, run) {
    console.log(`[${profileName}] ${label}`);
    let page;
    try {
      page = await run((value) => { page = value; return value; });
    } catch (error) {
      failures += 1;
      console.log(`  FAILED ${label}: ${error.message.split('\n')[0]}`);
      if (page) await page.screenshot({ path: new URL(`failed-${label}.png`, out).pathname }).catch(() => {});
    } finally {
      if (page) await page.context().close().catch(() => {});
    }
  }
  const tid = (page, id) => page.getByTestId(id);
  const openDetails = async (details) => { if (!await details.evaluate((element) => element.open)) await details.locator('summary').click(); };
  const sheet = (page) => page.locator('[role="dialog"][aria-modal="true"]').last();
  const closeSheet = async (page) => { await sheet(page).getByRole('button', { name: '창 닫기', exact: true }).first().click(); await page.waitForTimeout(150); };
  async function nav(page, name) {
    if (name === 'reserve') { await tid(page, 'nav-home').click(); await tid(page, 'open-reserve-card').click(); return; }
    if (name === 'activity') { await tid(page, 'nav-activity').click(); return; }
    await tid(page, `nav-${name}`).click();
  }
  async function stateWhen(page, predicate, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => JSON.parse(localStorage.getItem('aqua-card:poc:v1')));
      if (state && predicate(state)) return state;
      await page.waitForTimeout(120);
    }
    throw new Error('state did not change in time');
  }

  // Sign-up, sign-in screens and the first account.
  await section('onboarding', async (use) => {
    const page = use(await open());
    await shot(page, 'welcome');
    await tid(page, 'auth-login').click();
    await shot(page, 'login-no-account');
    await tid(page, 'login-signup').click();
    await shot(page, 'signup-account');
    await tid(page, 'signup-email-sample').click();
    await tid(page, 'signup-send-code').click();
    await shot(page, 'signup-email-code');
    await tid(page, 'signup-code').fill(await sixDigits(tid(page, 'signup-demo-code')));
    await tid(page, 'signup-password').fill('abc');
    await shot(page, 'signup-password-weak');
    await tid(page, 'signup-password').fill(PASSWORD);
    await tid(page, 'signup-password-confirm').fill('aqua2026pas');
    await shot(page, 'signup-password-mismatch');
    await tid(page, 'signup-password-confirm').fill(PASSWORD);
    await tid(page, 'signup-next').click();
    await shot(page, 'signup-phone');
    await tid(page, 'kyc-send-code').click();
    await shot(page, 'signup-phone-error');
    await tid(page, 'kyc-sample').click();
    await tid(page, 'kyc-send-code').click();
    await shot(page, 'signup-phone-code');
    await tid(page, 'kyc-code').fill(await sixDigits(tid(page, 'kyc-demo-code')));
    await shot(page, 'signup-phone-verified');
    await tid(page, 'kyc-next').click();
    await shot(page, 'signup-identity');
    await tid(page, 'kyc-id-scan').click();
    await shot(page, 'signup-identity-checking', { quick: true });
    await tid(page, 'kyc-id-done').waitFor();
    await shot(page, 'signup-identity-id-done');
    await tid(page, 'kyc-face-scan').click();
    await tid(page, 'kyc-face-done').waitFor();
    await shot(page, 'signup-identity-done');
    await tid(page, 'kyc-id-next').click();
    await shot(page, 'signup-questions');
    await tid(page, 'kyc-occupation').selectOption('회사원');
    await tid(page, 'kyc-purpose').selectOption('카드 결제');
    await tid(page, 'kyc-source').selectOption('근로소득');
    await tid(page, 'kyc-consent').check();
    await shot(page, 'signup-questions-filled');
    await tid(page, 'kyc-submit').click();
    await shot(page, 'signup-review-checking', { quick: true });
    await page.locator('[data-testid="kyc-review"][data-status="done"]').waitFor();
    await shot(page, 'signup-review-done');
    await tid(page, 'signup-finish').click();
    await tid(page, 'spend-balance').waitFor();
    await save(page, 'new');
    return page;
  });

  // Every tab and detail page of a new account.
  await section('pages', async (use) => {
    const page = use(await open('new'));
    await shot(page, 'home');
    await tid(page, 'open-guide').click();
    await shot(page, 'dialog-guide');
    await closeSheet(page);
    await nav(page, 'card');
    await shot(page, 'card-intro');
    await nav(page, 'benefits');
    await shot(page, 'benefits');
    await page.locator('.cashback-summary .rule-details summary').click();
    await shot(page, 'benefits-rules');
    await nav(page, 'settings');
    await shot(page, 'settings');
    await tid(page, 'demo-tools').locator('summary').click();
    await shot(page, 'settings-demo-tools');
    await nav(page, 'activity');
    await shot(page, 'activity-empty');
    await page.locator('.activity-page .rule-details summary').click();
    await shot(page, 'activity-month');
    await tid(page, 'open-statement').click();
    await shot(page, 'statement-empty');
    await nav(page, 'reserve');
    await shot(page, 'reserve');
    await page.locator('.reserve-page .rule-details summary').click();
    await shot(page, 'reserve-rules');
    for (const [button, label] of [['open-limits', 'limits'], ['open-channels', 'channels'], ['open-notifications', 'notifications'], ['open-faq', 'faq'], ['open-terms', 'terms']]) {
      await nav(page, 'settings');
      await tid(page, button).click();
      await shot(page, label);
    }
    const faqItems = page.locator('.page details summary');
    if (await faqItems.count()) { await faqItems.first().click(); await shot(page, 'terms-open'); }
    await nav(page, 'settings');
    await tid(page, 'open-faq').click();
    const firstQuestion = page.locator('.page details summary').first();
    if (await firstQuestion.count()) { await firstQuestion.click(); await shot(page, 'faq-open'); }
    return page;
  });

  // My tag and QR, and sending to a member.
  await section('receive-send', async (use) => {
    const page = use(await open('new'));
    await nav(page, 'settings');
    await tid(page, 'open-receive').click();
    await shot(page, 'receive');
    await tid(page, 'find-by-phone').click();
    await tid(page, 'find-by-email').click();
    await shot(page, 'receive-findable');
    await tid(page, 'receive-edit').click();
    await shot(page, 'receive-edit');
    await tid(page, 'tag-input').fill('minji.k');
    await shot(page, 'receive-edit-taken');
    await tid(page, 'tag-input').fill('aqua.tester');
    await shot(page, 'receive-edit-available');
    await tid(page, 'tag-save').click();
    await tid(page, 'receive-copy').click();
    await shot(page, 'receive-copied');
    await tid(page, 'receive-demo').click();
    await shot(page, 'toast-received', { keepToast: true });
    await nav(page, 'home');
    await tid(page, 'open-send').click();
    await shot(page, 'send-choose');
    await tid(page, 'send-member').click();
    await shot(page, 'send-search');
    await tid(page, 'send-tag').fill('ha');
    await shot(page, 'send-search-typed');
    await tid(page, 'send-tag').fill('0100000010');
    await shot(page, 'send-phone-partial');
    await tid(page, 'send-tag').fill('01000000101');
    await shot(page, 'send-phone-full');
    await tid(page, 'send-tag').fill('minji.kim@');
    await shot(page, 'send-email-partial');
    await tid(page, 'send-tag').fill('nobody.here');
    await tid(page, 'send-find').click();
    await shot(page, 'send-not-found');
    await tid(page, 'send-tag').fill('01099999999');
    await tid(page, 'send-find').click();
    await shot(page, 'send-phone-not-found');
    await tid(page, 'send-tag').fill('minji.k');
    await tid(page, 'send-find').click();
    await shot(page, 'send-amount');
    await tid(page, 'send-amount').fill('500');
    await shot(page, 'send-amount-error');
    await tid(page, 'send-amount').fill('10000');
    await tid(page, 'send-next').click();
    await shot(page, 'send-review');
    await tid(page, 'send-confirm').click();
    await shot(page, 'send-done');
    await tid(page, 'send-close').click();
    await tid(page, 'open-send').click();
    await tid(page, 'send-scan').click();
    await shot(page, 'send-scan');
    await tid(page, 'send-scan-haneul').click();
    await shot(page, 'send-amount-scanned');
    await closeSheet(page);
    await save(page, 'sent');
    return page;
  });

  // Top-up with a coin, through to the balance; and a failed one.
  await section('deposit', async (use) => {
    const page = use(await open('new'));
    await tid(page, 'open-deposit').click();
    await shot(page, 'deposit-start');
    await tid(page, 'funding-asset-USDC').click();
    await shot(page, 'deposit-usdc');
    await tid(page, 'funding-origin-wallet').click();
    await tid(page, 'funding-next').click();
    await shot(page, 'deposit-address');
    await tid(page, 'action-amount').fill('0.1');
    await tid(page, 'funding-next').click();
    await shot(page, 'deposit-amount-error');
    await tid(page, 'action-amount').fill('100');
    await tid(page, 'funding-next').click();
    await shot(page, 'deposit-quote');
    await tid(page, 'funding-consent').check();
    await tid(page, 'confirm-action').click();
    await tid(page, 'funding-status').waitFor();
    await shot(page, 'deposit-awaiting');
    await closeSheet(page);
    await shot(page, 'home-funding-pending');
    await tid(page, 'home-funding-status').click();
    await tid(page, 'funding-simulate-deposit').click();
    await page.locator('[data-testid="funding-status"][data-status="confirming"], [data-testid="funding-status"][data-status="converting"]').first().waitFor();
    await shot(page, 'deposit-confirming');
    await page.locator('[data-testid="funding-status"][data-status="completed"]').waitFor({ timeout: 20_000 });
    await shot(page, 'deposit-completed');
    await closeSheet(page);
    await tid(page, 'open-deposit').click();
    await tid(page, 'funding-next').click();
    await tid(page, 'action-amount').fill('20000');
    await tid(page, 'funding-next').click();
    await tid(page, 'funding-simulation-settings').click();
    await tid(page, 'funding-outcome-failure').check();
    await shot(page, 'deposit-krws-quote-failure-set');
    await tid(page, 'funding-consent').check();
    await tid(page, 'confirm-action').click();
    await tid(page, 'funding-simulate-deposit').click();
    await page.locator('[data-testid="funding-status"][data-status="failed"]').waitFor({ timeout: 20_000 });
    await shot(page, 'deposit-failed');
    await closeSheet(page);
    await nav(page, 'activity');
    await shot(page, 'activity-funding');
    return page;
  });

  // Sending to a wallet address: route, details, review with email check, progress, cancel.
  await section('withdraw', async (use) => {
    const page = use(await open('new'));
    await tid(page, 'open-send').click();
    await tid(page, 'send-wallet').click();
    await shot(page, 'withdraw-start');
    await tid(page, 'funding-asset-USDC').click();
    await shot(page, 'withdraw-usdc');
    await tid(page, 'funding-next').click();
    await shot(page, 'withdraw-details');
    await tid(page, 'funding-next').click();
    await shot(page, 'withdraw-details-errors');
    await tid(page, 'funding-recipient').fill('내 체험 지갑');
    await tid(page, 'funding-preview-address').click();
    await tid(page, 'action-amount').fill('20000');
    await shot(page, 'withdraw-details-filled');
    await tid(page, 'funding-next').click();
    await shot(page, 'withdraw-review');
    await tid(page, 'email-send').click();
    await shot(page, 'withdraw-review-code');
    await tid(page, 'email-code').fill(await sixDigits(tid(page, 'email-demo-code')));
    await tid(page, 'funding-consent').check();
    await shot(page, 'withdraw-review-ready');
    await tid(page, 'confirm-action').click();
    await tid(page, 'funding-status').waitFor();
    await shot(page, 'withdraw-reviewing');
    await page.locator('[data-testid="funding-status"][data-status="completed"]').waitFor({ timeout: 25_000 });
    await shot(page, 'withdraw-completed');
    await closeSheet(page);
    await tid(page, 'open-send').click();
    await tid(page, 'send-wallet').click();
    await tid(page, 'funding-next').click();
    await tid(page, 'funding-recipient').fill('취소 체험');
    await tid(page, 'funding-preview-address').click();
    await tid(page, 'action-amount').fill('5000');
    await tid(page, 'funding-next').click();
    await tid(page, 'email-send').click();
    await tid(page, 'email-code').fill(await sixDigits(tid(page, 'email-demo-code')));
    await tid(page, 'funding-consent').check();
    await tid(page, 'confirm-action').click();
    await tid(page, 'funding-cancel').click();
    await page.locator('[data-testid="funding-status"][data-status="cancelled"]').waitFor();
    await shot(page, 'withdraw-cancelled');
    await closeSheet(page);
    await shot(page, 'home-after-funding');
    return page;
  });

  // Reserve in and out.
  await section('reserve-move', async (use) => {
    const page = use(await open('new'));
    await nav(page, 'reserve');
    await page.getByRole('button', { name: '넣기', exact: true }).click();
    await shot(page, 'reserve-in');
    await tid(page, 'action-amount').fill('50000');
    await shot(page, 'reserve-in-filled');
    await tid(page, 'transfer-next').click();
    await shot(page, 'reserve-in-review');
    await tid(page, 'confirm-action').click();
    await tid(page, 'transfer-completed').waitFor();
    await shot(page, 'reserve-in-done');
    await tid(page, 'transfer-done').click();
    await page.getByRole('button', { name: '빼기', exact: true }).click();
    await tid(page, 'action-amount').fill('99999999');
    await shot(page, 'reserve-out-error');
    await closeSheet(page);
    return page;
  });

  // Card application: every step, both review outcomes that send you back, and approval.
  await section('card-apply', async (use) => {
    const page = use(await open('new'));
    await nav(page, 'card');
    await tid(page, 'card-apply').click();
    await shot(page, 'card-identity');
    await tid(page, 'card-identity-consent').check();
    await tid(page, 'card-identity-next').click();
    await shot(page, 'card-plan-standard');
    await tid(page, 'card-physical-choice').check();
    await shot(page, 'card-plan-physical');
    await tid(page, 'card-address-open').click();
    await shot(page, 'address-sheet');
    await tid(page, 'address-query').fill('물결');
    await shot(page, 'address-search');
    await tid(page, 'address-query').fill('없는길');
    await shot(page, 'address-empty');
    await tid(page, 'address-query').fill('');
    await tid(page, 'address-result-03900').click();
    await tid(page, 'address-detail').fill('101동 1001호');
    await shot(page, 'address-picked');
    await tid(page, 'address-save').click();
    await shot(page, 'card-plan-address');
    await page.getByRole('radio', { name: /프리미엄/ }).check();
    await shot(page, 'card-plan-premium');
    await tid(page, 'card-selection-next').click();
    await shot(page, 'card-review-premium');
    await page.getByRole('button', { name: '이전', exact: true }).click();
    await page.getByRole('radio', { name: /프라이빗/ }).check();
    await tid(page, 'card-selection-next').click();
    await shot(page, 'card-review-private-short');
    await page.getByRole('button', { name: '이전', exact: true }).click();
    await page.getByRole('radio', { name: /스탠다드/ }).check();
    await tid(page, 'card-physical-choice').check();
    await tid(page, 'card-selection-next').click();
    await shot(page, 'card-review-standard');
    await tid(page, 'card-review-consent').check();
    await tid(page, 'card-submit').click();
    await tid(page, 'card-demo-tools').locator('summary').click();
    await shot(page, 'card-submitted-tools');
    await tid(page, 'card-demo-needs-info').click();
    await shot(page, 'card-needs-info');
    await nav(page, 'home');
    await shot(page, 'home-card-needs-info');
    await nav(page, 'card');
    await tid(page, 'card-resubmit').click();
    await tid(page, 'card-identity-consent').check();
    await tid(page, 'card-identity-next').click();
    await tid(page, 'card-selection-next').click();
    await tid(page, 'card-review-consent').check();
    await tid(page, 'card-submit').click();
    await tid(page, 'card-demo-tools').locator('summary').click();
    await tid(page, 'card-demo-reject').click();
    await shot(page, 'card-rejected');
    await tid(page, 'card-restart').click();
    await tid(page, 'card-identity-consent').check();
    await tid(page, 'card-identity-next').click();
    await tid(page, 'card-physical-choice').check();
    if (await tid(page, 'card-address-open').innerText() === '입력') { await tid(page, 'card-address-open').click(); await tid(page, 'address-result-03900').click(); await tid(page, 'address-save').click(); }
    await tid(page, 'card-selection-next').click();
    await tid(page, 'card-review-consent').check();
    await tid(page, 'card-submit').click();
    await shot(page, 'card-preparing', { quick: true });
    await nav(page, 'home');
    await shot(page, 'home-card-preparing', { quick: true });
    await nav(page, 'card');
    await page.locator('.cf-active').waitFor({ timeout: 10_000 });
    await shot(page, 'card-active-new', { keepToast: true });
    await save(page, 'card');
    return page;
  });

  // An active card: details, lock, phone wallets, membership, delivery, PIN, replacement, reissue, close.
  await section('card-manage', async (use) => {
    const page = use(await open('card'));
    await nav(page, 'card');
    await shot(page, 'card-active');
    await tid(page, 'card-details-toggle').click();
    await shot(page, 'card-revealed');
    await tid(page, 'card-details-toggle').click();
    await tid(page, 'card-lock-toggle').click();
    await shot(page, 'card-locked');
    await nav(page, 'home');
    await shot(page, 'home-card-locked');
    await nav(page, 'card');
    await tid(page, 'card-lock-toggle').click();
    await tid(page, 'wallet-add-samsung').click();
    await shot(page, 'wallet-terms');
    await tid(page, 'wallet-terms').check();
    await tid(page, 'wallet-next').click();
    await shot(page, 'wallet-verify');
    await tid(page, 'wallet-send-code').click();
    await tid(page, 'wallet-code').fill(await sixDigits(tid(page, 'wallet-demo-code')));
    await shot(page, 'wallet-code');
    await tid(page, 'wallet-confirm').click();
    await shot(page, 'wallet-done');
    await tid(page, 'wallet-done').click();
    await tid(page, 'card-plan-premium').click();
    await shot(page, 'plan-upgrade-premium');
    await closeSheet(page);
    await tid(page, 'card-plan-private').click();
    await shot(page, 'plan-upgrade-private-short');
    await closeSheet(page);
    await tid(page, 'card-address-change').click();
    await shot(page, 'address-change');
    await closeSheet(page);
    await openDetails(tid(page, 'card-demo-tools'));
    await shot(page, 'card-demo-tools');
    await tid(page, 'card-demo-shipped').click();
    await shot(page, 'card-shipped');
    await tid(page, 'card-demo-delivered').click();
    await shot(page, 'card-delivered');
    await tid(page, 'card-physical-activate').click();
    await shot(page, 'pin-activate');
    await tid(page, 'pin-input').fill('1234');
    await shot(page, 'pin-sequential');
    await tid(page, 'pin-input').fill('2580');
    await tid(page, 'pin-again').fill('2581');
    await shot(page, 'pin-mismatch');
    await tid(page, 'pin-again').fill('2580');
    await tid(page, 'pin-submit').click();
    await shot(page, 'card-physical-active');
    await tid(page, 'card-pin-change').click();
    await shot(page, 'pin-change');
    await closeSheet(page);
    await tid(page, 'card-reissue').click();
    await shot(page, 'reissue-sheet');
    await closeSheet(page);
    await tid(page, 'card-close').click();
    await shot(page, 'close-sheet');
    await tid(page, 'card-sheet-consent').check();
    await shot(page, 'close-sheet-consent');
    await closeSheet(page);
    await tid(page, 'card-plan-premium').click();
    await tid(page, 'card-sheet-confirm').click();
    await shot(page, 'card-premium-replacement', { keepToast: true });
    await openDetails(tid(page, 'card-demo-tools'));
    await tid(page, 'card-demo-replacement').click();
    await tid(page, 'card-demo-replacement').click();
    await shot(page, 'card-replacement-delivered');
    await tid(page, 'card-replacement-activate').click();
    await shot(page, 'replacement-activate');
    await tid(page, 'card-sheet-confirm').click();
    await shot(page, 'card-premium-active');
    await tid(page, 'card-plan-standard').click();
    await shot(page, 'plan-downgrade');
    await tid(page, 'card-sheet-confirm').click();
    await shot(page, 'card-downgrade-scheduled');
    await nav(page, 'settings');
    await shot(page, 'settings-premium');
    await save(page, 'premium');
    return page;
  });

  // Payments, receipts, refunds and the history they leave.
  await section('payments', async (use) => {
    const page = use(await open('card'));
    await shot(page, 'home-active');
    await tid(page, 'open-payment').click();
    await shot(page, 'payment-dialog');
    await page.locator('.preset-amounts button').nth(1).click();
    await shot(page, 'payment-online');
    await tid(page, 'action-amount').fill('9999999');
    await shot(page, 'payment-short');
    await tid(page, 'action-amount').fill('5800');
    await page.locator('.preset-amounts button').first().click();
    await tid(page, 'confirm-action').click();
    await tid(page, 'payment-receipt').waitFor();
    await shot(page, 'payment-receipt');
    await tid(page, 'receipt-close').click();
    await tid(page, 'open-payment').click();
    await page.locator('.preset-amounts button').nth(2).click();
    await tid(page, 'confirm-action').click();
    await tid(page, 'payment-receipt').waitFor();
    await tid(page, 'receipt-close').click();
    await shot(page, 'home-with-payments');
    await nav(page, 'activity');
    await shot(page, 'activity-all');
    await page.locator('.activity-page .segmented button').nth(1).click();
    await shot(page, 'activity-card');
    await page.locator('.activity-page .segmented button').nth(2).click();
    await shot(page, 'activity-cash');
    await page.locator('.activity-page .segmented button').nth(0).click();
    await page.getByRole('button', { name: '도쿄 카페 페이백 상세', exact: true }).click();
    await shot(page, 'tx-detail-payback');
    await closeSheet(page);
    await page.getByRole('button', { name: '도쿄 카페 상세', exact: true }).click();
    await shot(page, 'tx-detail-payment');
    await tid(page, 'transaction-refund').click();
    await shot(page, 'refund-dialog');
    await tid(page, 'action-amount').fill('1000');
    await page.locator('.rule-details summary').last().click();
    await shot(page, 'refund-dialog-rules');
    await tid(page, 'confirm-action').click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /환불 상세$/ }).first().click();
    await shot(page, 'tx-detail-refund');
    await closeSheet(page);
    await nav(page, 'benefits');
    await shot(page, 'benefits-active');
    await tid(page, 'rewards-auto').click();
    await shot(page, 'toast-success', { keepToast: true });
    await nav(page, 'settings');
    await tid(page, 'settings-statement').click();
    await shot(page, 'statement');
    await tid(page, 'statement-copy').click();
    await shot(page, 'statement-copy-fallback');
    return page;
  });

  // Account: password, closing the account, demo reset, sign-out, wrong password and reset.
  await section('account', async (use) => {
    const page = use(await open('sent'));
    await nav(page, 'settings');
    await tid(page, 'open-password').click();
    await shot(page, 'password-sheet');
    await tid(page, 'password-current').fill(PASSWORD);
    await tid(page, 'password-next').fill('short');
    await tid(page, 'password-confirm').fill('shorter');
    await shot(page, 'password-errors');
    await closeSheet(page);
    await tid(page, 'open-closure').click();
    await shot(page, 'closure-sheet');
    await closeSheet(page);
    await tid(page, 'demo-tools').locator('summary').click();
    await tid(page, 'reset-demo').click();
    await shot(page, 'dialog-reset');
    await closeSheet(page);
    await tid(page, 'sign-out').click();
    await shot(page, 'login');
    await tid(page, 'login-password').fill('wrong-password1');
    await tid(page, 'login-submit').click();
    await shot(page, 'login-error');
    await tid(page, 'login-forgot').click();
    await shot(page, 'reset-start');
    await tid(page, 'reset-send-code').click();
    await shot(page, 'reset-code');
    await tid(page, 'reset-code').fill(await sixDigits(tid(page, 'reset-demo-code')));
    await tid(page, 'reset-password').fill(NEW_PASSWORD);
    await tid(page, 'reset-password-confirm').fill(NEW_PASSWORD);
    await shot(page, 'reset-ready');
    await tid(page, 'reset-submit').click();
    await shot(page, 'login-after-reset');
    return page;
  });

  await writeFile(new URL('report.json', out), JSON.stringify(report, null, 2));
  const counts = {};
  for (const entry of report) for (const issue of entry.issues) counts[issue.type] = (counts[issue.type] ?? 0) + 1;
  console.log(`[${profileName}] ${report.length} screens, ${report.reduce((sum, entry) => sum + entry.files.length, 0)} shots`, counts);
}
