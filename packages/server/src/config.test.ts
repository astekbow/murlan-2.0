import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';

const STRONG_A = 'a'.repeat(40);
const STRONG_R = 'r'.repeat(40);
const STRONG_W = 'w'.repeat(40);

const prodEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: STRONG_A,
  JWT_REFRESH_SECRET: STRONG_R,
  PAYMENT_WEBHOOK_SECRET: STRONG_W,
  // Compliance flags must be EXPLICITLY set in prod (see the guard); these acknowledge them off.
  KYC_REQUIRED: 'false',
  MIN_AGE: '0',
  GEO_BLOCKED_COUNTRIES: '',
  RESPONSIBLE_GAMING: 'false',
  ...over,
});

test('production: boots with strong, distinct secrets', () => {
  const cfg = loadConfig(prodEnv());
  assert.equal(cfg.isProd, true);
  assert.equal(cfg.accessSecret, STRONG_A);
});

test('production: throws when a required secret is missing', () => {
  assert.throws(() => loadConfig(prodEnv({ JWT_ACCESS_SECRET: undefined })), /JWT_ACCESS_SECRET is required/);
});

test('production: rejects the docker-compose "change-me-*" placeholders', () => {
  assert.throws(() => loadConfig(prodEnv({ JWT_ACCESS_SECRET: 'change-me-access' })), /placeholder|required|32 characters/);
  assert.throws(() => loadConfig(prodEnv({ PAYMENT_WEBHOOK_SECRET: 'change-me-webhook' })), /placeholder|32 characters/);
});

test('production: rejects too-short secrets (<32 chars)', () => {
  assert.throws(() => loadConfig(prodEnv({ JWT_REFRESH_SECRET: 'short' })), /at least 32 characters/);
});

test('production: rejects identical access and refresh secrets', () => {
  assert.throws(() => loadConfig(prodEnv({ JWT_REFRESH_SECRET: STRONG_A })), /must be different/);
});

test('production: throws when a compliance flag is left unset (no silent OFF default)', () => {
  for (const flag of ['KYC_REQUIRED', 'MIN_AGE', 'GEO_BLOCKED_COUNTRIES', 'RESPONSIBLE_GAMING']) {
    assert.throws(() => loadConfig(prodEnv({ [flag]: undefined })), /Compliance flags must be explicitly configured/, `${flag} unset must throw`);
  }
});

test('production: boots when every compliance flag is explicitly set (even to off)', () => {
  const cfg = loadConfig(prodEnv({ KYC_REQUIRED: 'true', MIN_AGE: '18', GEO_BLOCKED_COUNTRIES: 'US,FR', RESPONSIBLE_GAMING: 'true' }));
  assert.equal(cfg.compliance.kycRequired, true);
  assert.equal(cfg.compliance.minAge, 18);
  assert.deepEqual(cfg.compliance.blockedCountries, ['US', 'FR']);
  assert.equal(cfg.compliance.responsibleGaming, true);
});

test('development: boots without secrets using safe dev fallbacks', () => {
  const cfg = loadConfig({ NODE_ENV: 'development' });
  assert.equal(cfg.isProd, false);
  assert.ok(cfg.accessSecret.length > 0); // dev fallback present
});
