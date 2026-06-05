import test from 'node:test';
import assert from 'node:assert/strict';
import { ComplianceService, ageInYears, type ComplianceProfile } from './complianceService.ts';

const NOW = Date.UTC(2026, 0, 1); // 2026-01-01
const clean: ComplianceProfile = { kycStatus: 'none', dateOfBirth: null, country: null, selfExcludedUntil: null };

test('ageInYears computes full years (birthday boundary aware)', () => {
  assert.equal(ageInYears('2000-01-01', NOW), 26);
  assert.equal(ageInYears('2008-06-15', NOW), 17); // birthday not yet reached in 2026
  assert.equal(ageInYears('2008-01-01', NOW), 18);
  assert.equal(ageInYears(null, NOW), null);
  assert.equal(ageInYears('not-a-date', NOW), null);
});

test('all checks pass when every flag is OFF (default dev behavior)', () => {
  const svc = new ComplianceService({ kycRequired: false, minAge: 0, blockedCountries: [], responsibleGaming: false }, () => NOW);
  assert.equal(svc.enabled, false);
  assert.equal(svc.checkRealMoney(clean).allowed, true);
});

test('KYC gate blocks unverified accounts when enabled', () => {
  const svc = new ComplianceService({ kycRequired: true, minAge: 0, blockedCountries: [], responsibleGaming: false }, () => NOW);
  assert.equal(svc.checkRealMoney(clean).code, 'kyc_required');
  assert.equal(svc.checkRealMoney({ ...clean, kycStatus: 'verified' }).allowed, true);
});

test('age gate blocks under-age and missing DOB when enabled', () => {
  const svc = new ComplianceService({ kycRequired: false, minAge: 18, blockedCountries: [], responsibleGaming: false }, () => NOW);
  assert.equal(svc.checkRealMoney(clean).code, 'age_restricted'); // no DOB
  assert.equal(svc.checkRealMoney({ ...clean, dateOfBirth: '2010-01-01' }).code, 'age_restricted'); // 16
  assert.equal(svc.checkRealMoney({ ...clean, dateOfBirth: '2000-01-01' }).allowed, true);
});

test('geo gate blocks listed countries (case-insensitive) when enabled', () => {
  const svc = new ComplianceService({ kycRequired: false, minAge: 0, blockedCountries: ['US', 'FR'], responsibleGaming: false }, () => NOW);
  assert.equal(svc.checkRealMoney({ ...clean, country: 'us' }).code, 'geo_blocked');
  assert.equal(svc.checkRealMoney({ ...clean, country: 'AL' }).allowed, true);
});

test('geo gate FAILS CLOSED: an unknown/missing country is blocked when geo is enabled', () => {
  const svc = new ComplianceService({ kycRequired: false, minAge: 0, blockedCountries: ['US'], responsibleGaming: false }, () => NOW);
  assert.equal(svc.checkRealMoney({ ...clean, country: null }).code, 'geo_required');
  assert.equal(svc.checkWithdrawal({ ...clean, country: null }).code, 'geo_required');
  // With geo OFF (empty blocklist), a null country is fine.
  const off = new ComplianceService({ kycRequired: false, minAge: 0, blockedCountries: [], responsibleGaming: false }, () => NOW);
  assert.equal(off.checkRealMoney({ ...clean, country: null }).allowed, true);
});

test('self-exclusion blocks while active when responsible-gaming is on', () => {
  const svc = new ComplianceService({ kycRequired: false, minAge: 0, blockedCountries: [], responsibleGaming: true }, () => NOW);
  assert.equal(svc.checkRealMoney({ ...clean, selfExcludedUntil: NOW + 1000 }).code, 'self_excluded');
  assert.equal(svc.checkRealMoney({ ...clean, selfExcludedUntil: NOW - 1000 }).allowed, true); // expired
});
