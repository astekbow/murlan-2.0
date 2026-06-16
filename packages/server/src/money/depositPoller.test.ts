import test from 'node:test';
import assert from 'node:assert/strict';
import { DepositWatchRegistry, pollDepositsOnce, type CreditOutcome } from './depositPoller.ts';

test('DepositWatchRegistry: marks, lists active, expires after TTL, refreshes on re-mark, ignores empty', () => {
  let now = 1000;
  const reg = new DepositWatchRegistry(100, () => now); // 100ms TTL
  reg.markWatching('Taddr1', 'u1');
  reg.markWatching('Taddr2', 'u2');
  assert.deepEqual(reg.active().map((a) => a.address).sort(), ['Taddr1', 'Taddr2']);
  now = 1050;
  reg.markWatching('Taddr1', 'u1'); // refresh → until = 1150
  now = 1101; // Taddr2 (until 1100) expired; Taddr1 (until 1150) alive
  assert.deepEqual(reg.active().map((a) => a.address), ['Taddr1']);
  assert.equal(reg.size, 1); // active() pruned the expired entry
  now = 1200;
  assert.deepEqual(reg.active(), []);
  reg.markWatching(null, 'u3'); // null/undefined ignored (no crash, no entry)
  reg.markWatching(undefined, 'u3');
  assert.equal(reg.size, 0);
});

const tr = (txId: string, amountCents: number) => ({ txId, amountCents, from: 'Tsender' });

test('pollDepositsOnce: credits fresh transfers, skips replays + below-min, returns the FRESH count', async () => {
  const credited: Array<{ userId: string; amountCents: number; txId: string }> = [];
  const outcomes: Record<string, CreditOutcome> = { tx_new: 'credited', tx_seen: 'replay' };
  const n = await pollDepositsOnce({
    watched: [{ address: 'Aaddr', userId: 'u1' }],
    listIncoming: async () => [tr('tx_new', 1000), tr('tx_seen', 2000), tr('tx_small', 100)],
    credit: async (userId, amountCents, txId) => { credited.push({ userId, amountCents, txId }); return outcomes[txId] ?? 'credited'; },
    minCents: 500,
    alertedSkipped: new Set(),
  });
  assert.equal(n, 1); // only tx_new is a fresh credit
  assert.deepEqual(credited.map((c) => c.txId), ['tx_new', 'tx_seen']); // tx_small ($1) skipped BEFORE credit (below min)
});

test('pollDepositsOnce: over-cap is NOT credited and alerts the operator exactly ONCE across cycles', async () => {
  const alerts: string[] = [];
  const alertedSkipped = new Set<string>();
  const deps = {
    watched: [{ address: 'Aaddr', userId: 'u1' }],
    listIncoming: async () => [tr('tx_big', 100000)],
    credit: async (): Promise<CreditOutcome> => 'over_cap',
    minCents: 500,
    alertedSkipped,
    notify: async (text: string) => { alerts.push(text); },
  };
  assert.equal(await pollDepositsOnce(deps), 0); // arrived but over the self-imposed cap → not credited
  assert.equal(await pollDepositsOnce(deps), 0); // re-seen next cycle: still not credited
  assert.equal(alerts.length, 1);                // …and alerted only once
  assert.ok(alertedSkipped.has('tx_big'));
});

test('pollDepositsOnce: a BLOCKED account (frozen / non-compliant) is NOT credited and is alerted once', async () => {
  const alerts: string[] = [];
  const alertedSkipped = new Set<string>();
  const deps = {
    watched: [{ address: 'Aaddr', userId: 'frozen' }],
    listIncoming: async () => [tr('tx_blk', 5000)],
    credit: async (): Promise<CreditOutcome> => 'blocked',
    minCents: 500,
    alertedSkipped,
    notify: async (text: string) => { alerts.push(text); },
  };
  assert.equal(await pollDepositsOnce(deps), 0); // blocked → not credited
  assert.equal(await pollDepositsOnce(deps), 0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /bllokuar|jo-konforme/i); // reason surfaced to the operator
});

test('pollDepositsOnce: a credit error is logged (not silently swallowed) and the batch continues', async () => {
  const logs: string[] = [];
  const credited: string[] = [];
  const n = await pollDepositsOnce({
    watched: [{ address: 'A', userId: 'u1' }],
    listIncoming: async () => [tr('tx_err', 1000), tr('tx_ok', 1000)],
    credit: async (_u, _c, txId) => { if (txId === 'tx_err') throw new Error('user not found'); credited.push(txId); return 'credited'; },
    minCents: 500,
    alertedSkipped: new Set(),
    log: (msg) => logs.push(msg),
  });
  assert.equal(n, 1);
  assert.deepEqual(credited, ['tx_ok']);
  assert.ok(logs.some((l) => /FAILED/i.test(l))); // the failure was surfaced, not hidden
});

test('pollDepositsOnce: a per-address list error and a per-transfer credit error are ISOLATED (never throws)', async () => {
  const credited: string[] = [];
  const n = await pollDepositsOnce({
    watched: [
      { address: 'Abad', userId: 'u1' },  // listIncoming throws → skip this address
      { address: 'Agood', userId: 'u2' }, // one transfer's credit throws, the other succeeds
    ],
    listIncoming: async (addr) => {
      if (addr === 'Abad') throw new Error('TronGrid down');
      return [tr('tx_throws', 1000), tr('tx_ok', 1000)];
    },
    credit: async (_userId, _amountCents, txId) => {
      if (txId === 'tx_throws') throw new Error('credit blip');
      credited.push(txId);
      return 'credited';
    },
    minCents: 500,
    alertedSkipped: new Set(),
  });
  assert.equal(n, 1); // tx_ok still credited despite both failures
  assert.deepEqual(credited, ['tx_ok']);
});

test('pollDepositsOnce: notifies on a fresh credit when notify is provided', async () => {
  const alerts: string[] = [];
  const n = await pollDepositsOnce({
    watched: [{ address: 'A', userId: 'u1' }],
    listIncoming: async () => [tr('tx1', 2500)],
    credit: async () => 'credited',
    minCents: 500,
    alertedSkipped: new Set(),
    notify: async (text) => { alerts.push(text); },
  });
  assert.equal(n, 1);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /25\.00/); // $25.00
});
