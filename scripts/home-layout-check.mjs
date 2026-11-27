import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
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

let preview;
let browser;
try {
  const base = process.env.AQUA_BASE_URL || 'http://127.0.0.1:5198';
  if (!process.env.AQUA_BASE_URL) {
    preview = await createServer({ mode: 'mobile-preview', server: { host: '127.0.0.1', port: 5198, strictPort: true } });
    await preview.listen();
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'],
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=OverlayScrollbar'],
  });
  await checkDesktop(browser, base);
  await checkPhone(browser, base);
  console.log('Reserve and payment layouts stayed stable on desktop. The expanded phone form, footer and navigation remained accessible.');
} finally {
  try { await browser?.close(); } finally { await preview?.close(); }
}
