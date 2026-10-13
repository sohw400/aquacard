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

try {
  for (const name of profiles) {
    const { defaultBrowserType, ...profile } = devices[name];
    const context = await browser.newContext({ ...profile, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);
    await page.goto(base, { waitUntil: 'networkidle' });
    const readState = () => page.evaluate(() => JSON.parse(localStorage.getItem('aqua-card:poc:v1')));
    const initial = await readState();
    assert.ok(await page.evaluate(() => navigator.maxTouchPoints > 0));
    for (const menu of ['home', 'wallet', 'card', 'reserve', 'activity', 'settings']) {
      const nav = page.getByTestId(`nav-${menu}`);
      const bounds = await nav.boundingBox();
      assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, `${name} ${menu}: touch target smaller than 44px`);
      await nav.tap();
      await assertFits(page, `${name} ${menu}`);
    }

    await page.getByTestId('reserve-auto').tap();
    assert.equal(await page.getByTestId('reserve-auto').getAttribute('aria-checked'), 'true');
    const toggle = await page.getByTestId('reserve-auto').boundingBox();
    assert.ok(toggle.width >= 44 && toggle.height >= 44);

    await page.getByTestId('nav-home').tap();
    await page.getByTestId('open-deposit').tap();
    const depositAmount = page.getByTestId('action-amount');
    assert.ok(await depositAmount.evaluate((element) => parseFloat(getComputedStyle(element).fontSize) >= 16));
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'action-amount');
    assert.match(await page.getByTestId('dialog-fund').locator('.dialog-route').innerText(), /결제 잔액/);
    await depositAmount.fill('10000');
    await assertFits(page, `${name} deposit modal`);
    await page.getByTestId('confirm-action').tap();
    await page.getByTestId('dialog-fund').waitFor({ state: 'hidden' });
    assert.equal((await readState()).spend, initial.spend + 10_000);

    await page.getByTestId('nav-card').tap();
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
    assert.equal(issued.spend, initial.spend + 10_000);
    await assertFits(page, `${name} issued card`);

    await page.getByTestId('nav-home').tap();
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
    assert.equal(state.payments[0].fromReserve, 57_220);
    assert.equal(state.payments[0].cashback, 1_957);
    await page.reload({ waitUntil: 'networkidle' });
    await assertFits(page, `${name} restored home`);
    const restored = await readState();
    assert.equal(restored.card.stage, 'active');
    assert.equal(restored.reserveAuto, true);
    assert.equal(restored.spend, state.spend);
    assert.equal(restored.reserve, state.reserve);
    assert.equal(restored.rewards, state.rewards);
    assert.deepEqual(restored.payments, state.payments);
    const safeName = name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
    await page.screenshot({ path: new URL(`${safeName}.png`, artifacts).pathname, fullPage: true });
    assert.deepEqual(errors, []);
    results.push({ profile: name, engine: 'Chromium', emulationOnly: true, viewport: profile.viewport, hasTouch: profile.hasTouch, passed: true, checks: '6 menus, touch targets, deposit input focus and balance, 3-step card application and automatic issue/activation, Reserve payment, cashback, restored state' });
    console.log(`PASS ${name}: ${profile.viewport.width}px · touch · application · Reserve payment · cashback · reload (Chromium emulation)`);
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
