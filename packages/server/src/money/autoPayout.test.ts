import test from 'node:test';
import assert from 'node:assert/strict';
import { processWithdrawal, type AutoSendOutcome } from './autoPayout.ts';
import type { Notifier } from '../notify/notifier.ts';

function recorder() {
  const calls: { sent: string[]; messages: string[]; interactive: string[] } = { sent: [], messages: [], interactive: [] };
  const notifier: Notifier = {
    name: 'rec',
    async notify(t) { calls.messages.push(t); },
    async notifyInteractive(t) { calls.interactive.push(t); },
  };
  const sendAuto = (result: AutoSendOutcome) => async (id: string) => { calls.sent.push(id); return result; };
  return { calls, notifier, sendAuto };
}

const REC = { id: 'wd_1', amountCents: 3000, destination: 'TXabc...' };
const VERIFIED = { username: 'lojtar', kycStatus: 'verified' as const };

test('auto + send OK → autoPaid, alerts AUTO-PAID, NO action buttons', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, VERIFIED, { sendAuto: r.sendAuto({ outcome: 'paid', providerRef: 'p1' }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.deepEqual(out, { tier: 'auto', autoPaid: true, ambiguous: false, error: null });
  assert.deepEqual(r.calls.sent, ['wd_1']);
  assert.match(r.calls.messages[0]!, /pagua AUTO/);
  assert.equal(r.calls.interactive.length, 0); // auto-paid → no Approve/Reject buttons
});

test('money-16: a DUPLICATE send is treated as PAID (no refund), no action buttons', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, VERIFIED, { sendAuto: r.sendAuto({ outcome: 'duplicate', providerRef: 'p1', error: 'dup' }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.autoPaid, true);
  assert.equal(out.ambiguous, false);
  assert.match(out.error!, /duplicate/);
  assert.equal(r.calls.interactive.length, 0); // completed → no buttons (can't be re-sent)
});

test('money-16: an AMBIGUOUS send is left PAID + flagged, NOT refunded, no action buttons', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, VERIFIED, { sendAuto: r.sendAuto({ outcome: 'ambiguous', error: 'timeout' }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.autoPaid, false);
  assert.equal(out.ambiguous, true);
  assert.match(r.calls.messages[0]!, /PASIGURT|VERIFIKO/);
  assert.equal(r.calls.interactive.length, 0); // NOT pending → no Approve/Reject (no accidental re-send)
});

test('a DEFINITE send failure → refunded → back to pending → SHOWS Approve/Reject buttons', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, VERIFIED, { sendAuto: r.sendAuto({ outcome: 'failed', error: 'insufficient balance' }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.autoPaid, false);
  assert.equal(out.ambiguous, false);
  assert.match(out.error!, /insufficient balance/);
  assert.equal(r.calls.interactive.length, 1); // pending again → operator can Approve to re-send
});

test('above the threshold → NO send attempt, manual review alert with buttons', async () => {
  const r = recorder();
  const big = { id: 'wd_2', amountCents: 9000, destination: 'TXbig...' };
  const out = await processWithdrawal(big, VERIFIED, { sendAuto: r.sendAuto({ outcome: 'paid' }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.tier, 'manual');
  assert.equal(out.autoPaid, false);
  assert.deepEqual(r.calls.sent, []); // never attempted
  assert.match(r.calls.messages[0] ?? r.calls.interactive[0]!, /rishiko/);
});

test('no payout provider configured (sendAuto null) → auto-eligible but stays manual (fast-track alert)', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, VERIFIED, { sendAuto: null, notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.tier, 'auto');
  assert.equal(out.autoPaid, false);
  assert.deepEqual(r.calls.sent, []);
  assert.match(r.calls.interactive[0]!, /fast-track/);
});

test('not_pending at send time (already resolved) → not paid, no refund, buttons NOT shown', async () => {
  const r = recorder();
  const out = await processWithdrawal(REC, VERIFIED, { sendAuto: r.sendAuto({ outcome: 'not_pending' }), notifier: r.notifier, autoMaxCents: 5000 });
  assert.equal(out.autoPaid, false);
  assert.equal(out.ambiguous, false);
  // The row is already resolved elsewhere → treat as not auto-paid; the alert still posts.
  assert.match(out.error!, /no longer pending|not sent/);
});
