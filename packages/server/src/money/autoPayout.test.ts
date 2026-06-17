import test from 'node:test';
import assert from 'node:assert/strict';
import { processWithdrawal } from './autoPayout.ts';
import type { PayoutProvider, PayoutResult } from './payoutProvider.ts';
import type { Notifier } from '../notify/notifier.ts';

function recorder() {
  const calls: { approved: string[]; paid: string[]; messages: string[] } = { approved: [], paid: [], messages: [] };
  const notifier: Notifier = { name: 'rec', async notify(t) { calls.messages.push(t); } };
  const approve = async (id: string) => { calls.approved.push(id); };
  const payoutProvider = (result: PayoutResult): PayoutProvider => ({
    name: 'binance-payout',
    async payout(req) { calls.paid.push(req.withdrawalId); return result; },
  });
  return { calls, notifier, approve, payoutProvider };
}

const REC = { id: 'wd_1', amountCents: 3000, destination: 'TXabc...' };
const VERIFIED = { username: 'lojtar', kycStatus: 'verified' as const };

test('auto + provider OK → pays, marks complete, alerts AUTO-PAID', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, VERIFIED, { approve: r.approve, payout: r.payoutProvider({ ok: true, providerRef: 'p1' }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.deepEqual(out, { tier: 'auto', autoPaid: true, error: null });
  assert.deepEqual(r.calls.paid, ['wd_1']);
  assert.deepEqual(r.calls.approved, ['wd_1']);
  assert.match(r.calls.messages[0]!, /pagua AUTO/);
});

test('auto + provider FAILS → does NOT mark complete, alerts failure (stays manual)', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, VERIFIED, { approve: r.approve, payout: r.payoutProvider({ ok: false, error: 'insufficient balance' }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.autoPaid, false);
  assert.match(out.error!, /insufficient balance/);
  assert.deepEqual(r.calls.approved, []); // never marked paid
  assert.match(r.calls.messages[0]!, /DËSHTOI/);
});

test('above the threshold → NO payout attempt, manual review alert', async () => {
  const r = recorder();
  const big = { id: 'wd_2', amountCents: 9000, destination: 'TXbig...' };
  const out = await processWithdrawal(big, VERIFIED, { approve: r.approve, payout: r.payoutProvider({ ok: true }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.tier, 'manual');
  assert.equal(out.autoPaid, false);
  assert.deepEqual(r.calls.paid, []); // provider never called
  assert.match(r.calls.messages[0]!, /rishiko/);
});

test('KYC removed: a small UNVERIFIED withdrawal now auto-pays (kyc no longer blocks)', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, { username: 'x', kycStatus: 'pending' }, { approve: r.approve, payout: r.payoutProvider({ ok: true }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.tier, 'auto');
  assert.deepEqual(r.calls.paid, ['wd_1']);
});

test('no payout provider configured → auto-eligible but stays manual (fast-track alert)', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, VERIFIED, { approve: r.approve, payout: null, notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.tier, 'auto');
  assert.equal(out.autoPaid, false);
  assert.deepEqual(r.calls.paid, []);
  assert.match(r.calls.messages[0]!, /fast-track/);
});

test('provider that throws is caught → not paid, error reported', async () => {
  const r = recorder();
  const throwing: PayoutProvider = { name: 'binance-payout', async payout() { throw new Error('network down'); } };
  const out = await processWithdrawal(REC, VERIFIED, { approve: r.approve, payout: throwing, notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.autoPaid, false);
  assert.match(out.error!, /payout threw/);
  assert.deepEqual(r.calls.approved, []);
});

test('payout OK but mark-complete throws → autoPaid true with a surfaced error', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, VERIFIED, { approve: async () => { throw new Error('db down'); }, payout: r.payoutProvider({ ok: true }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.autoPaid, true);
  assert.match(out.error!, /mark-complete failed/);
});
