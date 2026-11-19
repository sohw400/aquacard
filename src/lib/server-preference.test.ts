import assert from 'node:assert/strict';
import test from 'node:test';
import { clearRewardPreference, readRewardPreference, storeRewardPreference, type RewardPreferenceIntent } from '../server/rewardPreference';

const first: RewardPreferenceIntent = { key: 'request-1111111111111111', useFirst: false, expectedVersion: 0, createdAt: 1_700_000_000_000 };
const second: RewardPreferenceIntent = { ...first, key: 'request-2222222222222222', useFirst: true, expectedVersion: 1 };

function fixture() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  return { values, close() { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage'); } };
}

test('preference intent survives a reload without crossing account boundaries or persisting account data', () => {
  const f = fixture();
  try {
    storeRewardPreference('alice', first);
    assert.deepEqual(readRewardPreference('alice'), first);
    assert.equal(readRewardPreference('bob'), null);
    storeRewardPreference('bob', second);
    assert.deepEqual(readRewardPreference('bob'), second);
    clearRewardPreference('bob', first.key);
    assert.deepEqual(readRewardPreference('alice'), first);
    assert.deepEqual(Object.keys(JSON.parse(f.values.get('aqua.server.reward-preference.alice')!)).sort(), ['createdAt', 'expectedVersion', 'key', 'useFirst']);
  } finally { f.close(); }
});

test('a late acknowledgement cannot delete a newer preference request for the same account', () => {
  const f = fixture();
  try {
    storeRewardPreference('alice', first);
    storeRewardPreference('alice', second);
    clearRewardPreference('alice', first.key);
    assert.deepEqual(readRewardPreference('alice'), second);
    clearRewardPreference('alice', second.key);
    assert.equal(readRewardPreference('alice'), null);
  } finally { f.close(); }
});

test('malformed saved preferences never become implicit boolean or version changes', () => {
  const f = fixture();
  try {
    for (const value of ['{', 'null', '[]', JSON.stringify({ ...first, useFirst: 'false' }), JSON.stringify({ ...first, expectedVersion: -1 }), JSON.stringify({ ...first, expectedVersion: 0.5 }), JSON.stringify({ ...first, key: 'bad key' }), JSON.stringify({ ...first, createdAt: 0.5 })]) {
      f.values.set('aqua.server.reward-preference.alice', value);
      assert.equal(readRewardPreference('alice'), null);
    }
    f.values.set('aqua.server.reward-preference.alice', JSON.stringify({ ...first, balanceWon: 12345, user: 'not-request-data' }));
    assert.deepEqual(readRewardPreference('alice'), first);
  } finally { f.close(); }
});

test('unavailable browser storage is recoverable for reads and must block new request persistence', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('Storage unavailable'); } });
  try {
    assert.equal(readRewardPreference('alice'), null);
    assert.throws(() => storeRewardPreference('alice', first), /Storage unavailable/);
    assert.doesNotThrow(() => clearRewardPreference('alice', first.key));
  } finally { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage'); }
});
