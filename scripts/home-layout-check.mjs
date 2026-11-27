import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright-core';
import { createServer } from 'vite';

async function openIssuedHome(page, base) {
  const url = new URL(base);
  url.searchParams.set('scenario', 'issued');
  await page.goto(url.href);
  await page.getByTestId('open-payment').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function checkWidthOnExpand(toggle, control) {
  const width = () => control.evaluate(element => element.getBoundingClientRect().width);
  const before = await width();
  await toggle.click();
  const after = await width();
  assert.ok(Math.abs(before - after) <= 1, `${await toggle.innerText()} changed width from ${before}px to ${after}px`);
}

async function checkDesktop(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 680 }, reducedMotion: 'reduce' });
  try {
    await openIssuedHome(page, base);
    await page.getByTestId('open-reserve-card').click();
    const rules = page.locator('.reserve-page .rule-details');
    await checkWidthOnExpand(rules.locator('summary'), rules);
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), 'expanded Reserve rules must extend the page');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId('nav-home').click();
    await page.getByTestId('open-payment').click();
    const dialog = page.getByTestId('dialog-payment');
    await checkWidthOnExpand(dialog.locator('.payment-examples summary'), dialog.getByLabel('결제할 곳'));
    assert.ok(await dialog.locator('.modal-body').evaluate(body => body.scrollHeight > body.clientHeight), 'expanded payment examples must extend the dialog body');
  } finally { await page.close(); }
}

async function checkPhone(browser, base) {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  try {
    await openIssuedHome(page, base);
    await page.getByTestId('open-payment').tap();
    const dialog = page.getByTestId('dialog-payment');
    await dialog.locator('.payment-examples summary').tap();
    const body = dialog.locator('.modal-body');
    const hasAccess = await body.evaluate(element => {
      if (!['scroll', 'auto'].includes(getComputedStyle(element).overflowY)) return false;
      element.scrollTop = element.scrollHeight;
      return element.scrollTop > 0 && element.scrollWidth <= element.clientWidth + 1;
    });
    assert.ok(hasAccess, 'the expanded payment form must scroll vertically and fit without horizontal scrolling');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'payment dialog must fit the viewport');
    const cancel = dialog.getByRole('button', { name: '취소', exact: true });
    const footerReachable = await cancel.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    });
    assert.ok(footerReachable, 'the payment footer must stay reachable when the form is scrolled');
    await cancel.tap();
    await page.getByTestId('nav-benefits').tap();
    await page.getByTestId('page-benefits').waitFor();
  } finally { await page.close(); }
}

async function checkFundingChoices(browser, base) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  try {
    await page.clock.setFixedTime(new Date('2026-11-26T03:00:00Z'));
    await openIssuedHome(page, base);
    const reserve = page.getByTestId('open-reserve-card');
    assert.ok(await reserve.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return scrollY === 0 && button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    }), 'the Reserve entry must be tappable above the bottom navigation before any scrolling');
    await reserve.tap();
    await page.getByTestId('reserve-principal').waitFor();
    await page.getByTestId('go-back').tap();
    const readAmount = async locator => Number((await locator.innerText()).replace(/[^0-9]/g, ''));
    const wallet = await readAmount(page.getByTestId('spend-balance'));
    const rewards = await readAmount(page.getByTestId('available-rewards'));
    const purchase = wallet + rewards + 2_000;
    await page.getByTestId('nav-card').tap();
    await page.getByTestId('card-open-sources').tap();
    for (const useRewards of [false, true]) {
      for (const useReserve of [false, true]) {
        for (const [id, enabled] of [['rewards-auto', useRewards], ['reserve-auto', useReserve]]) {
          const toggle = page.getByTestId(id);
          if (await toggle.getAttribute('aria-checked') !== String(enabled)) await toggle.tap();
        }
        const names = [...(useRewards ? ['리워드'] : []), '지갑 잔액', ...(useReserve ? ['리저브 잔액'] : [])];
        assert.deepEqual(await page.getByTestId('funding-order').locator('li span').allTextContents(), names);
        await page.getByTestId('nav-home').tap();
        await page.getByTestId('open-payment').tap();
        const dialog = page.getByTestId('dialog-payment');
        await dialog.getByTestId('action-amount').fill(String(purchase));
        assert.equal(await dialog.getByTestId('confirm-action').isEnabled(), useReserve);
        if (useReserve) {
          const usedRewards = useRewards ? rewards : 0;
          assert.deepEqual(await dialog.locator('.source-row > span').allTextContents(), names);
          const amounts = (await dialog.locator('.source-row > strong').allTextContents()).map(text => Number(text.replace(/[^0-9]/g, '')));
          assert.deepEqual(amounts, [...(useRewards ? [usedRewards] : []), wallet, purchase - wallet - usedRewards]);
        } else {
          assert.equal(await dialog.getByTestId('payment-cashback').count(), 0, 'a declined payment must not promise cashback');
          assert.match(await dialog.getByRole('alert').innerText(), /모자라요/);
        }
        await dialog.getByRole('button', { name: '취소', exact: true }).tap();
        await page.getByTestId('open-payment-sources').tap();
      }
    }
  } finally { await page.close(); }
}

async function checkKeyboardAndTextScale(browser, base) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  try {
    await openIssuedHome(page, base);
    await page.getByTestId('open-payment-sources').focus();
    await page.keyboard.press('Enter');
    const sources = page.getByTestId('page-payment-sources');
    await sources.waitFor();
    // Emulate a user text-style override without also magnifying the tap targets.
    await sources.evaluate(root => {
      const text = [...root.querySelectorAll('strong,p,h3,li,li span')];
      const px = text.map(el => parseFloat(getComputedStyle(el).fontSize));
      text.forEach((el, i) => { el.style.fontSize = px[i] * 2 + 'px'; });
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '200% payment preference text must reflow');
    const toggle = sources.getByRole('switch', { name: '결제할 때 리워드 쓰기' });
    assert.match(await toggle.getAttribute('aria-describedby'), /\S/);
    await toggle.focus();
    await page.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await page.getByTestId('go-back').focus();
    await page.keyboard.press('Enter');
    const opener = page.getByTestId('open-payment');
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByTestId('dialog-payment');
    await dialog.waitFor();
    await dialog.getByTestId('confirm-action').focus();
    await page.keyboard.press('Tab');
    assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)), 'Tab must keep focus inside the open payment dialog');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(await opener.evaluate(element => element === document.activeElement), 'Escape must return focus to the payment opener');
  } finally { await page.close(); }
}

let preview;
let browser;
try {
  const base = process.env.AQUA_BASE_URL || 'http://127.0.0.1:5198';
  if (!process.env.AQUA_BASE_URL) {
    preview = await createServer({ mode: 'mobile-preview', server: { host: '127.0.0.1', port: 5198, strictPort: true } });
    await preview.listen();
  }
  const useWebKit = process.env.AQUA_LAYOUT_ENGINE === 'webkit';
  if (useWebKit) browser = await webkit.launch();
  else {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
      ignoreDefaultArgs: ['--hide-scrollbars'],
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=OverlayScrollbar'],
    });
    await checkDesktop(browser, base);
  }
  await checkPhone(browser, base);
  await checkFundingChoices(browser, base);
  await checkKeyboardAndTextScale(browser, base);
  console.log(`${browser.browserType().name()} passed phone layout, Reserve access, card funding settings, keyboard and 200% text checks.`);
} finally {
  try { await browser?.close(); } finally { await preview?.close(); }
}
