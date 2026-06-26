import test from 'node:test';
import assert from 'node:assert/strict';
import { HandshakeThrottle } from './handshakeThrottle.ts';

test('allow: enforces the per-key cap within a window; keys are independent', () => {
  const t = new HandshakeThrottle(3_000, 3, 10_000); // max 3 per window
  const key = 'u1|1.2.3.4';
  assert.equal(t.allow(key), true);  // 1
  assert.equal(t.allow(key), true);  // 2
  assert.equal(t.allow(key), true);  // 3
  assert.equal(t.allow(key), false); // 4 → over cap
  assert.equal(t.allow('u2|1.2.3.4'), true); // a different key is tracked separately
});

test('resolve: caches per (user, ver); a ver bump (revocation) bypasses the cache', async () => {
  const t = new HandshakeThrottle();
  let calls = 0;
  const fetch = async () => { calls += 1; return { allowed: true, avatar: null }; };
  await t.resolve('u1', 1, fetch);
  await t.resolve('u1', 1, fetch); // same ver within TTL → served from cache
  assert.equal(calls, 1);
  await t.resolve('u1', 2, fetch); // ver bumped → must re-read (never serve a stale OK)
  assert.equal(calls, 2);
});

test('resolve: returns the fetched result and serves the SAME value from cache (no stale flip)', async () => {
  const t = new HandshakeThrottle();
  const res = await t.resolve('u1', 1, async () => ({ allowed: false, code: 'banned', avatar: 'a1' }));
  assert.deepEqual(res, { allowed: false, code: 'banned', avatar: 'a1' });
  // A cached hit must return the cached (denied) value, not whatever this fetch would produce.
  const again = await t.resolve('u1', 1, async () => ({ allowed: true, avatar: null }));
  assert.deepEqual(again, { allowed: false, code: 'banned', avatar: 'a1' });
});
