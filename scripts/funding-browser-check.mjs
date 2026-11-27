import assert from 'node:assert/strict';
import { mkdir, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createTestDatabase } from '../server/test-support.ts';
import { Database } from '../server/database.ts';
import { grantApplicationRole, verifyApplicationRole } from '../server/permissions.ts';
import { createApiServer } from '../server/http.ts';
import { LedgerStore } from '../server/ledger.ts';
import { FundingStore } from '../server/funding-store.ts';
import { approveTestCustomer } from '../server/test-customer-access.ts';

const password = 'Funding-browser-test-42';
const staticDir = process.env.AQUA_FUNDING_BROWSER_STATIC_DIR ?? fileURLToPath(new URL('../dist/', import.meta.url));
await access(join(staticDir, 'index.html'));
const artifacts = new URL('../artifacts/server-funding/', import.meta.url);
await mkdir(artifacts, { recursive: true });
assert.ok(!['production', 'staging'].includes(process.env.NODE_ENV), 'Use a disposable local PostgreSQL environment.');
const [ownerUrl, appUrl] = ['TEST_DATABASE_URL', 'DATABASE_URL'].map(name => {
  const url = new URL(process.env[name]);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  return url;
});
assert.equal(ownerUrl.host, appUrl.host);
assert.equal(ownerUrl.pathname, appUrl.pathname);
assert.notEqual(ownerUrl.username, appUrl.username);
const probe = createServer();
await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
const { port } = probe.address();
await new Promise(resolve => probe.close(resolve));
const origin = 'http://127.0.0.1:' + port;
const fixture = await createTestDatabase();
const db = new Database({ connectionString: appUrl.href, schema: fixture.schema });
const funding = new FundingStore(fixture.database);
const app = createApiServer(new LedgerStore(db), { allowedOrigins: [origin], logger: false, staticDir });
let browser;
try {
  await grantApplicationRole(fixture.database, decodeURIComponent(appUrl.username));
  await verifyApplicationRole(db);
  await app.listen({ port, host: '127.0.0.1' });
  const auth = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: { origin },
    payload: { email: 'fundingbrowser@example.com', name: '테스트회원', tag: 'fundingbrowser', password } });
  assert.equal(auth.statusCode, 201);
  const owner = auth.json().user.id;
  await approveTestCustomer(fixture.database, owner);
  const balance = async () => Number((await fixture.database.query(
    'SELECT balance_won FROM ledger_accounts WHERE id=$1', ['user:' + owner])).rows[0].balance_won);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const [name, value] = String(auth.headers['set-cookie']).split(';')[0].split('=');
  await context.addCookies([{ name, value, url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(origin);
  await page.getByTestId('server-balance').filter({ hasText: /^0원$/ }).waitFor();
  const fund = page.locator('#funding-content');
  const open = () => page.getByRole('button', { name: '입출금 보기' }).click();
  await open();
  await fund.getByLabel('USDC 수량').fill('10');
  await fund.getByRole('button', { name: '견적 보기' }).click();
  await fund.getByRole('button', { name: '입금 주소 받기' }).click();
  await fund.getByText('입금 대기', { exact: true }).waitFor();
  const [deposit] = await funding.history(owner);
  const evidence = { transferRef: 'sim-tx:browser:0', blockRef: 'sim-block:browser' };
  const event = (action, eventId, extra = {}) => funding.event({ id: deposit.id, action, eventId, ...extra });
  await event('observe', 'browser-observe', { ...evidence, asset: deposit.asset, network: deposit.network,
    units: deposit.units, destination: deposit.destination });
  await event('confirm', 'browser-confirm', { ...evidence, confirmations: 2 });
  await event('convert', 'browser-convert');
  await page.reload();
  await open();
  await fund.getByText('입금 완료', { exact: true }).waitFor();
  assert.equal(await balance(), 14_000);
  await fund.getByRole('combobox', { name: /거래/ }).selectOption('withdrawal');
  await fund.getByLabel('지갑에서 출금할 원화 금액').fill('10000');
  await fund.getByLabel('체험용 받는 지갑').fill('aqua-test:polygon:my-wallet');
  await fund.getByRole('button', { name: '견적 보기' }).click();
  await fixture.database.query('UPDATE auth_sessions SET reauthenticated_at=NULL WHERE user_id=$1', [owner]);
  await fund.getByRole('button', { name: '출금 금액 보류하기' }).click();
  await fund.getByLabel('현재 비밀번호').fill(password);
  await fund.getByRole('button', { name: '본인 확인 후 출금' }).click();
  await fund.getByText('출금 금액 보류', { exact: true }).waitFor();
  assert.equal(await balance(), 4_000);
  await fund.getByRole('button', { name: '요청 취소' }).click();
  await fund.getByText('취소', { exact: true }).waitFor();
  assert.equal(await balance(), 14_000);
  assert.equal(await page.getByRole('heading', { name: '코인 입출금', exact: true }).count(), 1);
  await page.screenshot({ path: fileURLToPath(new URL('funding-mobile.png', artifacts)), fullPage: true });
  console.log('Connected mobile funding passed. Deposit credit, withdrawal reauthentication, hold and cancellation verified.');
} finally {
  await browser?.close();
  await app.close();
  await db.close();
  await fixture.cleanup();
}
