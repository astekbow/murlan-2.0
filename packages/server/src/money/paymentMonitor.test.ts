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
  const calls = { order: [] as string[], reversed: [] as string[], marked: [] as string[], messages: [] as string[] };
  return {
    calls,
    reverse: async (w: { id: string }) => { calls.order.push('reverse'); calls.reversed.push(w.id); },
    markReversed: async (id: string) => { calls.order.push('mark'); calls.marked.push(id); },
    notify: async (t: string) => { calls.messages.push(t); },
  };
}
const completed = (userId: string, amountCents: number) => async () => ({ userId, amountCents, status: 'completed' });

test('refunds a FAILED (status 5) completed payout: credit FIRST, then mark, then alert', async () => {
  const r = reconcileRec();
  const n = await reconcileFailedWithdrawals({
    list: async () => [{ withdrawOrderId: 'wd_1', status: 5, amountCents: 3000 }],
    findWithdrawal: completed('u1', 3000),
    reverse: r.reverse, markReversed: r.markReversed, notify: r.notify,
  });
  assert.equal(n, 1);
  assert.deepEqual(r.calls.reversed, ['wd_1']);
  assert.deepEqual(r.calls.marked, ['wd_1']);
  assert.deepEqual(r.calls.order, ['reverse', 'mark']); // credit before mark (idempotency-safe)
  assert.match(r.calls.messages[0]!, /DËSHTOI/);
});

test('does NOT reverse a Completed (6) or Processing (4) withdrawal', async () => {
  const r = reconcileRec();
  const n = await reconcileFailedWithdrawals({
    list: async () => [{ withdrawOrderId: 'a', status: 6, amountCents: 100 }, { withdrawOrderId: 'b', status: 4, amountCents: 100 }],
    findWithdrawal: completed('u1', 100),
    reverse: r.reverse, markReversed: r.markReversed, notify: r.notify,
  });
  assert.equal(n, 0);
  assert.deepEqual(r.calls.reversed, []);
});

test('does NOT reverse a withdrawal that is not ours, or not in completed state', async () => {
  const r = reconcileRec();
  const n = await reconcileFailedWithdrawals({
    list: async () => [{ withdrawOrderId: 'x', status: 5, amountCents: 100 }, { withdrawOrderId: 'y', status: 5, amountCents: 100 }, { withdrawOrderId: 'z', status: 5, amountCents: 100 }],
    findWithdrawal: async (id) => (id === 'x' ? null : id === 'y' ? { userId: 'u', amountCents: 100, status: 'pending' } : { userId: 'u', amountCents: 100, status: 'rejected' }),
    reverse: r.reverse, markReversed: r.markReversed, notify: r.notify,
  });
  assert.equal(n, 0); // null (not ours), pending (not paid), rejected (already reversed) → all skipped
  assert.deepEqual(r.calls.reversed, []);
});

test('status is the durable dedup: an already-reversed (now rejected) record is skipped — no re-credit/re-alert', async () => {
  const r = reconcileRec();
  // Same failed Binance record, but our withdrawal is now 'rejected' (was reversed last sweep).
  const n = await reconcileFailedWithdrawals({
    list: async () => [{ withdrawOrderId: 'wd_1', status: 5, amountCents: 3000 }],
    findWithdrawal: async () => ({ userId: 'u1', amountCents: 3000, status: 'rejected' }),
    reverse: r.reverse, markReversed: r.markReversed, notify: r.notify,
  });
  assert.equal(n, 0);
  assert.deepEqual(r.calls.reversed, []);
  assert.deepEqual(r.calls.messages, []);
});
