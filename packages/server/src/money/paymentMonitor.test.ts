import test from 'node:test';
import assert from 'node:assert/strict';
import { findStaleWithdrawals, pruneAlerted, treasuryBufferCents, reconcileFailedWithdrawals } from './paymentMonitor.ts';

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

function reconcileRec() {
  const calls = { reversed: [] as string[], messages: [] as string[] };
  return {
    calls,
    reverse: async (w: { id: string }) => { calls.reversed.push(w.id); },
    notify: async (t: string) => { calls.messages.push(t); },
  };
}
const completed = (userId: string, amountCents: number) => async () => ({ userId, amountCents, status: 'completed' });

test('reconcileFailedWithdrawals refunds a FAILED (status 5) completed payout', async () => {
  const r = reconcileRec();
  const n = await reconcileFailedWithdrawals({
    list: async () => [{ withdrawOrderId: 'wd_1', status: 5, amountCents: 3000 }],
    findWithdrawal: completed('u1', 3000),
    reverse: r.reverse, notify: r.notify, reversed: new Set(),
  });
  assert.equal(n, 1);
  assert.deepEqual(r.calls.reversed, ['wd_1']);
  assert.match(r.calls.messages[0]!, /DËSHTOI/);
});

test('does NOT reverse a Completed (6) or Processing (4) withdrawal', async () => {
  const r = reconcileRec();
  const n = await reconcileFailedWithdrawals({
    list: async () => [{ withdrawOrderId: 'a', status: 6, amountCents: 100 }, { withdrawOrderId: 'b', status: 4, amountCents: 100 }],
    findWithdrawal: completed('u1', 100),
    reverse: r.reverse, notify: r.notify, reversed: new Set(),
  });
  assert.equal(n, 0);
  assert.deepEqual(r.calls.reversed, []);
});

test('does NOT reverse a withdrawal that is not ours / not completed', async () => {
  const r = reconcileRec();
  const n = await reconcileFailedWithdrawals({
    list: async () => [{ withdrawOrderId: 'x', status: 5, amountCents: 100 }, { withdrawOrderId: 'y', status: 5, amountCents: 100 }],
    findWithdrawal: async (id) => (id === 'x' ? null : { userId: 'u', amountCents: 100, status: 'pending' }),
    reverse: r.reverse, notify: r.notify, reversed: new Set(),
  });
  assert.equal(n, 0);
});

test('does NOT double-reverse (reversed set blocks repeats) and prunes out-of-window ids', async () => {
  const r = reconcileRec();
  const reversed = new Set<string>(['wd_1']);       // already reversed
  const n = await reconcileFailedWithdrawals({
    list: async () => [{ withdrawOrderId: 'wd_1', status: 5, amountCents: 3000 }],
    findWithdrawal: completed('u1', 3000),
    reverse: r.reverse, notify: r.notify, reversed,
  });
  assert.equal(n, 0);                                // not reversed again
  assert.deepEqual(r.calls.reversed, []);
  assert.ok(reversed.has('wd_1'));                   // still in window → retained
  // an id no longer in the window is pruned
  const reversed2 = new Set<string>(['old_id']);
  await reconcileFailedWithdrawals({ list: async () => [], findWithdrawal: completed('u', 1), reverse: r.reverse, notify: r.notify, reversed: reversed2 });
  assert.equal(reversed2.has('old_id'), false);
});
