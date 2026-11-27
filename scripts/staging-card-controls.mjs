import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifyCardControls(api, member, stateDir) {
  const journal = join(stateDir, 'smoke-card-controls.json');
  const snapshot = () => api('/api/issuer-card');
  const initial = await snapshot();
  assert.ok(initial.canRequestStatus && initial.card, 'The signed-in QA member requires an enabled sandbox card.');
  const { id: cardId } = initial.card;
  let run;
  async function save() {
    const temp = journal + '.' + randomUUID();
    await writeFile(temp, JSON.stringify(run), { mode: 0o600, flag: 'wx' });
    await rename(temp, journal);
  }
  try { run = JSON.parse(await readFile(journal, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (run) {
    assert.ok(run.tag === member.tag && run.cardId === cardId, 'Card control journal belongs to a different fixture.');
  } else {
    assert.ok(initial.card.confirmedStatus === 'active' && initial.card.desiredStatus === 'active'
      && (!initial.card.command || initial.card.command.status === 'succeeded'), 'Start the card rehearsal with an active card and no unresolved command.');
    const account = await api('/api/account');
    run = { tag: member.tag, cardId, lockKey: randomUUID(), unlockKey: randomUUID(), lockVersion: initial.card.version,
      balanceWon: account.balanceWon, reserveWon: account.reserve.availableWon };
    await save();
  }

  const submit = (targetStatus, expectedVersion, key) => api('/api/issuer-card/status', { cardId, targetStatus, expectedVersion }, key, 202);
  async function waitForCard(commandId, status) {
    const deadline = Date.now() + 45_000;
    do {
      const { card } = await snapshot();
      assert.ok(card.id === cardId && card.command?.id === commandId, 'A different card command superseded this rehearsal.');
      if (card.command.status === 'succeeded') {
        assert.equal(card.desiredStatus, status);
        assert.equal(card.confirmedStatus, status);
        return card;
      }
      assert.ok(['pending', 'in_flight', 'retry'].includes(card.command.status), 'The issuer did not confirm the command.');
      await delay(350);
    } while (Date.now() < deadline);
    throw new Error('Timed out waiting for the signed issuer confirmation.');
  }
  const lock = await submit('locked', run.lockVersion, run.lockKey);
  if (run.unlockVersion === undefined) {
    const locked = await waitForCard(lock.id, 'locked');
    run.unlockVersion = locked.version;
    await save();
  }
  const unlock = await submit('active', run.unlockVersion, run.unlockKey);
  const active = await waitForCard(unlock.id, 'active');
  // Replaying an older lock after unlock must leave the confirmed, active card untouched.
  const repeated = await submit('locked', run.lockVersion, run.lockKey);
  assert.deepEqual(repeated, { ...lock, duplicate: true });
  assert.deepEqual((await snapshot()).card, active);
  const account = await api('/api/account');
  assert.equal(account.balanceWon, run.balanceWon);
  assert.equal(account.reserve.availableWon, run.reserveWon);
  await unlink(journal);
}
