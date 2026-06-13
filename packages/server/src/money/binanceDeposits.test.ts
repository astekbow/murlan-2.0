import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUnclaimedDeposits, type BinanceDeposit } from './binanceDeposits.ts';

const NOW = 1_700_000_000_000;
const old = (minsAgo: number) => NOW - minsAgo * 60 * 1000;

function rec() {
  const calls = { claimedChecks: [] as string[], messages: [] as string[] };
  const notify = async (t: string) => { calls.messages.push(t); };
  return { calls, notify };
}

const dep = (txId: string, amountCents: number, insertTime: number): BinanceDeposit => ({ txId, amountCents, address: 'TUcs', insertTime });

test('alerts an unclaimed deposit that is past the grace period', async () => {
  const r = rec();
  const n = await checkUnclaimedDeposits({
    list: async () => [dep('AbC123', 2000, old(30))],
    isClaimed: async (id) => { r.calls.claimedChecks.push(id); return false; },
    notify: r.notify,
    alerted: new Set(),
    now: NOW,
  });
  assert.equal(n, 1);
  assert.equal(r.calls.claimedChecks[0], 'abc123'); // checked lowercased
  assert.match(r.calls.messages[0]!, /PA-ATRIBUUAR/);
  assert.match(r.calls.messages[0]!, /\$20\.00/);
});

test('does NOT alert a deposit that was already claimed', async () => {
  const r = rec();
  const n = await checkUnclaimedDeposits({
    list: async () => [dep('abc', 2000, old(30))],
    isClaimed: async () => true,
    notify: r.notify,
    alerted: new Set(),
    now: NOW,
  });
  assert.equal(n, 0);
  assert.equal(r.calls.messages.length, 0);
});

test('does NOT alert a deposit still within the grace period', async () => {
  const r = rec();
  const n = await checkUnclaimedDeposits({
    list: async () => [dep('abc', 2000, old(2))], // 2 min ago, grace 10m
    isClaimed: async () => false,
    notify: r.notify,
    alerted: new Set(),
    now: NOW,
  });
  assert.equal(n, 0);
});

test('does NOT re-alert a deposit already in the alerted set', async () => {
  const r = rec();
  const alerted = new Set<string>(['abc']);
  const n = await checkUnclaimedDeposits({
    list: async () => [dep('abc', 2000, old(30))],
    isClaimed: async () => false,
    notify: r.notify,
    alerted,
    now: NOW,
  });
  assert.equal(n, 0);
});

test('adds alerted txIds to the set so the next run skips them', async () => {
  const r = rec();
  const alerted = new Set<string>();
  await checkUnclaimedDeposits({ list: async () => [dep('XyZ', 500, old(30))], isClaimed: async () => false, notify: r.notify, alerted, now: NOW });
  assert.ok(alerted.has('xyz'));
  // second run: same deposit → no new alert
  const n2 = await checkUnclaimedDeposits({ list: async () => [dep('XyZ', 500, old(30))], isClaimed: async () => false, notify: r.notify, alerted, now: NOW });
  assert.equal(n2, 0);
});
