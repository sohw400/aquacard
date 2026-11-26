import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';

const base = new URL(process.env.MOBILE_PREVIEW_URL);
const scenario = (name) => new URL(`?scenario=${name}`, base).href;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium' });

try {
  for (const device of ['iPhone SE (3rd gen)', 'Pixel 7']) {
    const context = await browser.newContext({ ...devices[device], locale: 'ko-KR', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    const response = await page.goto(scenario('signup'));
    assert.equal(response?.status(), 200);
    await page.getByTestId('auth-signup').waitFor();
    await page.goto(scenario('issued'));
    const balance = page.getByTestId('available-balance');
    await balance.waitFor();
    assert.equal(await balance.innerText(), '65,163원');

    await page.getByTestId('open-payment').click();
    const payment = page.getByTestId('dialog-payment');
    await payment.getByLabel('결제할 곳').fill('프리뷰 서점');
    await payment.getByTestId('action-amount').fill('27500');
    await payment.getByTestId('confirm-action').click();
    const receipt = page.getByTestId('payment-receipt');
    assert.equal(await receipt.getByTestId('receipt-rewards-used').innerText(), '−4,963원');
    assert.equal(await receipt.getByTestId('receipt-rewards-after').innerText(), '225원');

    await page.goto(scenario('signup'));
    await page.getByTestId('auth-signup').waitFor();
    await page.goto(scenario('issued'));
    const transaction = page.getByRole('button', { name: '프리뷰 서점 상세', exact: true });
    await transaction.click();
    const detail = page.getByTestId('transaction-sheet');
    await detail.getByTestId('transaction-refund').click();
    await page.getByTestId('action-amount').fill('3000');
    await page.getByTestId('confirm-action').click();
    await transaction.click();
    assert.equal(await detail.getByTestId('transaction-amount').innerText(), '24,500원');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${device} (Chromium touch emulation): signup, issued, payment, isolated revisit and partial refund passed`);
  }
} finally {
  await browser.close();
}
