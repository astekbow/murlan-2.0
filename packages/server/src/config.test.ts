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
  // infra-6/infra-8: prod requires an explicit metrics token + a concrete trust-proxy value.
  METRICS_TOKEN: 'm'.repeat(40),
  TRUST_PROXY: '1',
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

// ----- ACCESS_TTL bound (#1) ------------------------------------------------
test('ACCESS_TTL defaults to a short 5m', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).accessTtl, '5m');
});

test('ACCESS_TTL: an over-long value is refused (upper bound)', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'development', ACCESS_TTL: '7d' } as NodeJS.ProcessEnv), /exceeds the maximum/);
  assert.throws(() => loadConfig({ NODE_ENV: 'development', ACCESS_TTL: '20m' } as NodeJS.ProcessEnv), /exceeds the maximum/);
});

test('ACCESS_TTL: an unparseable value is refused', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'development', ACCESS_TTL: 'banana' } as NodeJS.ProcessEnv), /not a valid duration/);
});

test('ACCESS_TTL: a short value (and bare seconds) is accepted', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test', ACCESS_TTL: '2m' } as NodeJS.ProcessEnv).accessTtl, '2m');
  assert.equal(loadConfig({ NODE_ENV: 'test', ACCESS_TTL: '300' } as NodeJS.ProcessEnv).accessTtl, '300'); // 300s = 5m
});

// ----- #10 TELEGRAM_WEBHOOK_SECRET prod strength check ----------------------
test('#10 prod: a weak TELEGRAM_WEBHOOK_SECRET is refused when the bot is enabled', () => {
  const enabled = { TELEGRAM_BOT_TOKEN: 'bot-token-123', TELEGRAM_CHAT_ID: '987', TELEGRAM_WEBHOOK_SECRET: 'short' };
  assert.throws(() => loadConfig(prodEnv(enabled)), /TELEGRAM_WEBHOOK_SECRET must be at least 32/);
  assert.throws(() => loadConfig(prodEnv({ ...enabled, TELEGRAM_WEBHOOK_SECRET: 'change-me-' + 'x'.repeat(30) })), /placeholder/);
});

test('#10 prod: a strong TELEGRAM_WEBHOOK_SECRET boots when the bot is enabled', () => {
  const cfg = loadConfig(prodEnv({ TELEGRAM_BOT_TOKEN: 'bot-token-123', TELEGRAM_CHAT_ID: '987', TELEGRAM_WEBHOOK_SECRET: 'z'.repeat(40) }));
  assert.equal(cfg.telegramWebhookSecret, 'z'.repeat(40));
});

test('#10 prod: the telegram secret check is SKIPPED when the bot is not fully enabled', () => {
  // Only the secret set (no token/chat) → bot not mounted → no strength requirement.
  const cfg = loadConfig(prodEnv({ TELEGRAM_WEBHOOK_SECRET: 'short' }));
  assert.equal(cfg.telegramWebhookSecret, 'short');
});

// ----- telegram-2/3: reject a GROUP (negative) TELEGRAM_CHAT_ID at boot ------
test('telegram-2/3: a negative (group) TELEGRAM_CHAT_ID is refused at boot (every env)', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'development', TELEGRAM_CHAT_ID: '-1001234567890' } as NodeJS.ProcessEnv), /group\/supergroup/);
  assert.throws(() => loadConfig(prodEnv({ TELEGRAM_BOT_TOKEN: 'b', TELEGRAM_CHAT_ID: '-100', TELEGRAM_WEBHOOK_SECRET: 'z'.repeat(40) })), /group\/supergroup/);
});

test('telegram-2/3: a positive (private) TELEGRAM_CHAT_ID is accepted', () => {
  const cfg = loadConfig({ NODE_ENV: 'development', TELEGRAM_CHAT_ID: '987654321' } as NodeJS.ProcessEnv);
  assert.equal(cfg.telegramChatId, '987654321');
});

// ----- infra-6: METRICS_TOKEN closes /metrics in production (boot-safe) ------
test('infra-6 prod: an unset METRICS_TOKEN auto-generates a token (closed, but boots)', () => {
  const a = loadConfig(prodEnv({ METRICS_TOKEN: undefined }));
  const b = loadConfig(prodEnv({ METRICS_TOKEN: '' }));
  assert.ok(a.metricsToken && a.metricsToken.length >= 24, 'a random token is generated');
  assert.ok(b.metricsToken && b.metricsToken.length >= 24);
  assert.notEqual(a.metricsToken, b.metricsToken, 'each boot gets a fresh random token');
});

test('infra-6 prod: an explicit METRICS_TOKEN is used as-is', () => {
  assert.equal(loadConfig(prodEnv({ METRICS_TOKEN: 'x'.repeat(40) })).metricsToken, 'x'.repeat(40));
});

test('infra-6 dev: METRICS_TOKEN may be unset (loopback-only metrics)', () => {
  const cfg = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
  assert.equal(cfg.metricsToken, null);
});

// ----- infra-8: TRUST_PROXY fail-closed in production -----------------------
test('infra-8 prod: TRUST_PROXY=true is refused; blank is allowed (deployed nginx hop)', () => {
  assert.throws(() => loadConfig(prodEnv({ TRUST_PROXY: 'true' })), /TRUST_PROXY=true is refused/);
  assert.doesNotThrow(() => loadConfig(prodEnv({ TRUST_PROXY: undefined })));
  assert.doesNotThrow(() => loadConfig(prodEnv({ TRUST_PROXY: '' })));
});

test('infra-8 prod: a concrete hop count or CIDR is accepted', () => {
  assert.equal(loadConfig(prodEnv({ TRUST_PROXY: '1' })).trustProxy, 1);
  assert.deepEqual(loadConfig(prodEnv({ TRUST_PROXY: '172.18.0.0/16' })).trustProxy, ['172.18.0.0/16']);
});

test('infra-8 dev: TRUST_PROXY default (loopback + RFC1918) is unchanged', () => {
  const cfg = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
  assert.ok(Array.isArray(cfg.trustProxy));
});
