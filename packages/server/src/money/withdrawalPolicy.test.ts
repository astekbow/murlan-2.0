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

test('manual: KYC not verified even if small', () => {
  const c = classifyWithdrawal({ amountCents: 1000, kycStatus: 'pending' }, { autoMaxCents: 5000 });
  assert.equal(c.tier, 'manual');
  assert.ok(c.reasons.includes('KYC not verified'));
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

test('null kyc is treated as unverified', () => {
  const c = classifyWithdrawal({ amountCents: 100, kycStatus: null }, { autoMaxCents: 5000 });
  assert.equal(c.tier, 'manual');
  assert.ok(c.reasons.includes('KYC not verified'));
});
