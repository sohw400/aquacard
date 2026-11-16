import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { AccountSnapshot, TransferResult } from '../shared/api';

test('API process restart preserves sessions, balances and the result of a repeated transfer', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aqua-restart-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((done) => probe.close(() => done()));
  const env = { ...process.env, NODE_ENV: 'development', AQUA_DB_PATH: join(directory, 'db.sqlite'), AQUA_MAIL_DIR: join(directory, 'mail'), AQUA_HOST: '127.0.0.1', AQUA_PORT: String(port), AQUA_ALLOWED_ORIGINS: 'http://127.0.0.1:5173' };
  const origin = 'http://127.0.0.1:5173';
  const base = `http://127.0.0.1:${port}/api`;
  let child: ChildProcess | undefined;
  async function start() {
    child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env, stdio: 'ignore' });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error('API exited before becoming ready');
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* Wait for this owned process. */ }
      await delay(50);
    }
    throw new Error('API did not start');
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const processToStop = child;
    const stopped = once(processToStop, 'exit');
    processToStop.kill('SIGTERM');
    const timeout = setTimeout(() => processToStop.kill('SIGKILL'), 3_000);
    try { await stopped; } finally { clearTimeout(timeout); child = undefined; }
  }
  async function request(path: string, cookie = '', body?: unknown, key?: string, owner?: string) {
    const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...(owner ? { 'X-Aqua-Account': owner } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `HTTP ${response.status} at ${path}`);
    return { data: await response.json() as AccountSnapshot & TransferResult, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  }
  try {
    await start();
    const sender = await request('/auth/signup', '', { email: 'restart.sender@example.com', tag: 'restart.sender', name: '보내는회원', password: 'Restart-password-42' });
    const receiver = await request('/auth/signup', '', { email: 'restart.receiver@example.com', tag: 'restart.receiver', name: '받는회원', password: 'Restart-password-42' });
    const funding = spawn(process.execPath, ['--import', 'tsx', 'server/credit.ts', 'restart.sender@example.com', '20000', 'restart-funding-0001'], { env, stdio: 'ignore' });
    assert.equal((await once(funding, 'exit'))[0], 0);
    const original = await request('/transfers', sender.cookie, { recipientTag: 'restart.receiver', amountWon: 7_000 }, 'restart-transfer-0001', sender.data.user.id);
    await stop();
    await start();
    assert.equal((await request('/account', sender.cookie)).data.balanceWon, 13_000);
    assert.equal((await request('/account', receiver.cookie)).data.balanceWon, 7_000);
    const retried = await request('/transfers', sender.cookie, { recipientTag: 'restart.receiver', amountWon: 7_000 }, 'restart-transfer-0001', sender.data.user.id);
    assert.equal(retried.data.transfer.id, original.data.transfer.id);
    assert.equal((await request('/account', receiver.cookie)).data.transactions.length, 1);
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});
