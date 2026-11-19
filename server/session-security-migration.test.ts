import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { AuthService } from './auth';
import { Database } from './database';
import { LedgerError, LedgerStore } from './ledger';
import { applyMigrations, verifyMigrations } from './migrations';

const NOW = Date.UTC(2026, 10, 19);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

test('session upgrade preserves recent bearers, requires fresh password proof and revokes legacy devices beyond the visible limit', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required.');
  const schema = `test_session_upgrade_${randomBytes(10).toString('hex')}`;
  const database = new Database({ connectionString: process.env.TEST_DATABASE_URL, schema });
  const directory = await mkdtemp(join(tmpdir(), 'aqua-session-upgrade-'));
  try {
    const migrations = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => /^00[1-8]_.*\.sql$/.test(name))) {
      await copyFile(new URL(name, migrations), join(directory, name));
    }
    await applyMigrations(database, pathToFileURL(directory + '/'));
    await database.query(`INSERT INTO users(id,email,name,tag,password_hash,created_at)
      VALUES ('legacy','legacy@example.test','기존 회원','legacy','test-migration-hash',$1),
      ('another','another@example.test','다른 회원','another','test-migration-hash',$1)`, [NOW]);
    const tokens = Array.from({ length: 25 }, () => randomBytes(32).toString('hex'));
    for (const [index, token] of tokens.entries()) {
      await database.query('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4)',
        [digest(token), 'legacy', NOW + index, NOW + 86_400_000]);
    }
    const otherToken = randomBytes(32).toString('hex');
    await database.query('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4)',
      [digest(otherToken), 'another', NOW, NOW + 86_400_000]);

    await applyMigrations(database); await verifyMigrations(database);
    const auth = new AuthService(new LedgerStore(database), { now: () => NOW + 100 });
    const listed = await auth.listSessions(tokens[24], 'legacy');
    assert.equal(listed.sessions.length, 20);
    assert.equal(listed.sessions[0].current, true);
    assert.equal(listed.reauthenticatedUntil, null);
    assert.ok(listed.sessions.every((session) => session.deviceLabel === '알 수 없는 기기' && session.lastSeenAt === session.createdAt));
    assert.equal(new Set(listed.sessions.map((session) => session.id)).size, 20);
    for (const token of tokens.slice(0, 5)) assert.equal(await auth.authenticate(token), null);
    for (const token of tokens.slice(5)) assert.equal((await auth.authenticate(token))?.id, 'legacy');
    await assert.rejects(auth.revokeOtherSessions(tokens[24], 'legacy'),
      (error: unknown) => error instanceof LedgerError && error.code === 'REAUTHENTICATION_REQUIRED');
    assert.equal((await auth.listSessions(otherToken, 'another')).sessions.length, 1);
    const ids = listed.sessions.map((session) => session.id);
    await applyMigrations(database);
    assert.deepEqual((await auth.listSessions(tokens[24], 'legacy')).sessions.map((session) => session.id), ids);
  } finally {
    try { await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
