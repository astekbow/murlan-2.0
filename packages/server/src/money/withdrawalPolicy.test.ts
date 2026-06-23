import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithdrawal } from './withdrawalPolicy.ts';

test('auto: small amount + KYC verified + feature enabled', () => {
  const c = classifyWithdrawal({ amountCents: 2000, kycStatus: 'verified' }, { autoMaxCents: 5000 });
  assert.equal(c.tier, 'auto');
  assert.deepEqual(c.reasons, []);
});

test('manual: above the auto threshold', () => {
  const c = classifyWithdrawal({ amountCents: 9000, kycStatus: 'verified' }, { autoMaxCents: 5000 });
  assert.equal(c.tier, 'manual');
  assert.ok(c.reasons.includes('above auto threshold'));
});

test('KYC removed: a small UNVERIFIED withdrawal is now auto (kyc no longer a factor)', () => {
  const c = classifyWithdrawal({ amountCents: 1000, kycStatus: 'pending' }, { autoMaxCents: 5000 });
  assert.equal(c.tier, 'auto');
  assert.ok(!c.reasons.includes('KYC not verified'));
});

test('manual: feature disabled (autoMaxCents = 0) → everything manual', () => {
  const c = classifyWithdrawal({ amountCents: 100, kycStatus: 'verified' }, { autoMaxCents: 0 });
  assert.equal(c.tier, 'manual');
  assert.ok(c.reasons.includes('auto disabled'));
});

test('boundary: amount exactly at the threshold is auto', () => {
  const c = classifyWithdrawal({ amountCents: 5000, kycStatus: 'verified' }, { autoMaxCents: 5000 });
  assert.equal(c.tier, 'auto');
});

test('KYC removed: null/absent kyc classifies on amount + cap only (still auto)', () => {
  const c = classifyWithdrawal({ amountCents: 100, kycStatus: null }, { autoMaxCents: 5000 });
  assert.equal(c.tier, 'auto');
  assert.ok(!c.reasons.includes('KYC not verified'));
});

test('daily auto cap: within cap → auto; exceeding it → manual', () => {
  // cap $200, already withdrew $180 today, now wants $50 → 230 > 200 → manual
  const over = classifyWithdrawal({ amountCents: 5000, kycStatus: 'verified', priorTodayCents: 18000 }, { autoMaxCents: 5000, dailyAutoCapCents: 20000 });
  assert.equal(over.tier, 'manual');
  assert.ok(over.reasons.includes('above daily auto cap'));
  // already $100 today, now $50 → 150 ≤ 200 → still auto
  const under = classifyWithdrawal({ amountCents: 5000, kycStatus: 'verified', priorTodayCents: 10000 }, { autoMaxCents: 5000, dailyAutoCapCents: 20000 });
  assert.equal(under.tier, 'auto');
});

test('daily auto cap of 0 = no cap (unbounded auto, per-tx limits still apply)', () => {
  const c = classifyWithdrawal({ amountCents: 5000, kycStatus: 'verified', priorTodayCents: 999999 }, { autoMaxCents: 5000, dailyAutoCapCents: 0 });
  assert.equal(c.tier, 'auto');
});

// ===== money-7: global cap / per-destination cap / transfer-in → manual ======

test('money-7 global cap: breaching the 24h global auto budget forces MANUAL', () => {
  // global cap $1000; already $980 auto-paid today across all users; +$50 → 1030 > 1000 → manual
  const over = classifyWithdrawal({ amountCents: 5000, globalTodayCents: 98_000 }, { autoMaxCents: 5000, globalAutoCapCents: 100_000 });
  assert.equal(over.tier, 'manual');
  assert.ok(over.reasons.includes('above global auto cap'));
  // under the global cap → still auto
  const under = classifyWithdrawal({ amountCents: 5000, globalTodayCents: 10_000 }, { autoMaxCents: 5000, globalAutoCapCents: 100_000 });
  assert.equal(under.tier, 'auto');
});

test('money-7 global cap of 0 = off (no global limiting)', () => {
  const c = classifyWithdrawal({ amountCents: 5000, globalTodayCents: 9_999_999 }, { autoMaxCents: 5000, globalAutoCapCents: 0 });
  assert.equal(c.tier, 'auto');
});

test('money-7 per-destination cap: breaching one address 24h cap forces MANUAL', () => {
  const over = classifyWithdrawal({ amountCents: 5000, destTodayCents: 9_000 }, { autoMaxCents: 5000, destAutoCapCents: 10_000 });
  assert.equal(over.tier, 'manual');
  assert.ok(over.reasons.includes('above per-destination auto cap'));
  const under = classifyWithdrawal({ amountCents: 5000, destTodayCents: 1_000 }, { autoMaxCents: 5000, destAutoCapCents: 10_000 });
  assert.equal(under.tier, 'auto');
});

test('money-7 transfer-in → manual: any recent P2P-received funds route to manual review', () => {
  const c = classifyWithdrawal({ amountCents: 1000, recentTransferInCents: 500 }, { autoMaxCents: 5000 });
  assert.equal(c.tier, 'manual');
  assert.ok(c.reasons.includes('recent transfer-in (manual review)'));
  // no recent transfer-in → still auto
  const ok = classifyWithdrawal({ amountCents: 1000, recentTransferInCents: 0 }, { autoMaxCents: 5000 });
  assert.equal(ok.tier, 'auto');
});
