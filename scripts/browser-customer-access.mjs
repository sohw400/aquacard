import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Approves only disposable browser-fixture accounts through the local owner connection. */
export function approveBrowserCustomer(userId) {
  assert.equal(typeof userId, 'string');
  const result = spawnSync(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', '--input-type=module', '-e', `
    import { databaseFromEnvironment } from './server/database.ts';
    import { CustomerAccessStore } from './server/customer-access.ts';
    if (process.env.NODE_ENV === 'production') throw new Error('Browser fixture approval is disabled in production.');
    const owner = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(owner.hostname)) throw new Error('Browser fixture approval requires a local owner connection.');
    const db = await databaseFromEnvironment(true);
    try {
      await new CustomerAccessStore(db).transition({
        userId: process.env.AQUA_BROWSER_APPROVAL_USER,
        status: 'active', expectedVersion: 1,
        idempotencyKey: 'browser-fixture-approval:' + process.env.AQUA_BROWSER_APPROVAL_USER,
        reason: 'Sandbox browser test approval for disposable fixture only',
      });
    } finally { await db.close(); }
  `], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, AQUA_BROWSER_APPROVAL_USER: userId },
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, `Explicit browser fixture approval failed. ${result.stderr?.slice(-1_500) ?? ''}`);
}
