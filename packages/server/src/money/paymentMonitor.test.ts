import test from 'node:test';
import assert from 'node:assert/strict';
import { findStaleWithdrawals, pruneAlerted, treasuryBufferCents } from './paymentMonitor.ts';

const NOW = 1_700_000_000_000;
const h = (n: number) => NOW - n * 60 * 60 * 1000;
const w = (id: string, hoursAgo: number) => ({ id, createdAt: h(hoursAgo) });

test('findStaleWithdrawals returns only those older than the threshold and not yet alerted', () => {
  const pending = [w('a', 3), w('b', 1), w('c', 5)];
  const stale = findStaleWithdrawals(pending, NOW, 2 * 60 * 60 * 1000, new Set());
  assert.deepEqual(stale.map((x) => x.id), ['a', 'c']); // b (1h) is below 2h
});

test('findStaleWithdrawals skips ids already alerted', () => {
  const pending = [w('a', 3), w('c', 5)];
  const stale = findStaleWithdrawals(pending, NOW, 2 * 60 * 60 * 1000, new Set(['a']));
  assert.deepEqual(stale.map((x) => x.id), ['c']);
});

test('pruneAlerted drops ids that are no longer pending', () => {
  const alerted = new Set(['a', 'b', 'c']);
  pruneAlerted(alerted, ['b']); // only b still pending
  assert.deepEqual([...alerted], ['b']);
});

test('treasuryBufferCents = binance − liabilities (negative when under-funded)', () => {
  assert.equal(treasuryBufferCents(10_000, 6_000), 4_000);
  assert.equal(treasuryBufferCents(5_000, 8_000), -3_000); // under-funded
});
