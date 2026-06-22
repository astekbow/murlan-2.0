// ============================================================================
// MURLAN — Server configuration
// ----------------------------------------------------------------------------
// Parsed once from the environment. Secrets have DEV-ONLY fallbacks so the app
// boots locally; in production (NODE_ENV=production) missing secrets throw.
// ============================================================================

import { z } from 'zod';

const DEV_ACCESS_SECRET = 'dev-access-secret-change-me';
const DEV_REFRESH_SECRET = 'dev-refresh-secret-change-me';
// Production opt-in phrase for the stub providers. A bare ALLOW_STUB_PROVIDERS=true
// is REFUSED in prod (see loadConfig) — a leftover demo flag must never silently
// enable mock money on a real-money host; a deliberate staging deploy uses this phrase.
const STUB_PROD_PHRASE = 'staging-no-real-money';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().nonnegative().default(3100), // 3100 (NOT 3000 — avoids the local ren4all collision); 0 = OS-assigned
  HOST: z.string().default('0.0.0.0'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  JWT_ACCESS_SECRET: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().optional(),
  ACCESS_TTL: z.string().default('15m'),
  REFRESH_TTL: z.string().default('7d'),
  REDIS_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(), // when set, use Prisma/Postgres instead of in-memory
  // Money knobs (used in Phase 6); kept here so config is the single source.
  RAKE_BPS: z.coerce.number().int().min(0).max(10_000).default(1_000), // 10.00%
  TURN_MS: z.coerce.number().int().positive().default(30_000),
  COUNTDOWN_MS: z.coerce.number().int().nonnegative().default(3_000),
  HAND_PAUSE_MS: z.coerce.number().int().min(0).max(60_000).default(7_000), // inter-hand standings pause; 0 = deal next hand immediately
  ABANDON_MS: z.coerce.number().int().positive().default(30_000), // reconnect grace before forfeit
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
  PAYMENT_WEBHOOK_IPS: z.string().optional(), // CSV of allowed source IPs for the webhook (empty = allow any)
  TRUST_PROXY: z.string().optional(), // 'true'|'false'|hop-count|CSV of trusted proxy IPs/CIDRs (default: loopback + RFC1918)
  METRICS_TOKEN: z.string().optional(), // when set, GET /metrics requires Authorization: Bearer <token> (else served only to private/loopback IPs)
  RESEND_API_KEY: z.string().optional(),       // set to send real reset/verification emails via Resend
  EMAIL_FROM: z.string().optional(),           // sender, e.g. "Murlan <noreply@yourdomain.com>"
  ADMIN_EMAIL: z.string().optional(),          // this account is auto-promoted to admin on boot
  TELEGRAM_BOT_TOKEN: z.string().optional(),   // set BOTH token + chat id → ops alerts (e.g. new withdrawal) to Telegram
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(), // set → the admin bot is active: Telegram updates POST to /api/telegram/webhook (verified by this secret)
  AUTO_WITHDRAW_MAX_CENTS: z.coerce.number().int().nonnegative().default(0), // 0 = OFF; >0 = withdrawals ≤ this from KYC-verified users are flagged "auto-eligible" (fast-track)
  DAILY_AUTO_WITHDRAW_CAP_CENTS: z.coerce.number().int().nonnegative().default(0), // 0 = no daily cap; >0 = once a user's 24h withdrawals exceed this, further ones go MANUAL (anti-drain/AML)
  SWEEP_ALERT_CENTS: z.coerce.number().int().nonnegative().default(0), // 0 = OFF; >0 = Telegram "time to sweep" alert once the on-chain deposit-address USDT total reaches this (e.g. 10000 = $100)
  AUTO_WITHDRAW_CURRENCY: z.string().default('usdttrc20'), // payout coin/network for auto-payouts
  BINANCE_API_KEY: z.string().optional(),             // Binance withdraw API — auto-payout rail when set (with secret)
  BINANCE_API_SECRET: z.string().optional(),          // Binance API secret (HMAC-SHA256 request signing)
  TRON_DEPOSIT_XPUB: z.string().optional(),           // account-level TRON xpub (watch-only) → UNIQUE per-player deposit address (preferred; theft-proof attribution)
  TRON_DEPOSIT_ADDRESS: z.string().optional(),        // legacy SINGLE shared address (claim-jackable) — used only if no xpub is set
  TRONGRID_API_KEY: z.string().optional(),            // free TronGrid key (on-chain deposit verification; higher rate limits)
  DEPOSIT_POLL_MS: z.coerce.number().int().min(0).max(600_000).default(30_000), // auto-credit poller cadence for active depositors; 0 = OFF (manual TxID only)
  ALLOW_STUB_PROVIDERS: z.string().optional(), // staging/demo escape: allow the mock payment + console email stubs in production (NEVER for real money)
  // Data retention: prune match move-logs (game_actions) older than N days during the
  // periodic sweep. 0 = keep forever (the safe default — replays/audit stay available).
  MOVELOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  // Compliance switches (spec §13) — OFF by default; flip on per jurisdiction.
  KYC_REQUIRED: z.string().optional(),
  MIN_AGE: z.coerce.number().int().min(0).default(0),
  GEO_BLOCKED_COUNTRIES: z.string().optional(), // CSV of ISO-2 codes
  RESPONSIBLE_GAMING: z.string().optional(),
  // Engagement rewards (§2.6) — ON by default; set false to disable per jurisdiction.
  REWARDS_ENABLED: z.string().optional(),
  // Four-eyes on the tournament champion payout — needs TWO distinct admins. OFF by
  // default (a solo operator has no second admin; it would block every payout).
  TOURNAMENT_DUAL_CONTROL: z.string().optional(),
});

const isTrue = (v: string | undefined): boolean => v === 'true' || v === '1';

// Default: trust ONLY loopback + private (RFC1918) ranges — the reverse proxy
// (Caddy/nginx) always reaches the server from a private/Docker IP, and the server
// isn't publicly reachable, so a spoofed X-Forwarded-For from the outside is ignored.
// Override with TRUST_PROXY: 'true'/'false', a hop count, or a CSV of IPs/CIDRs.
const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
function parseTrustProxy(v: string | undefined): boolean | number | string[] {
  const s = (v ?? '').trim();
  if (s === '') return DEFAULT_TRUSTED_PROXIES;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^\d+$/.test(s)) return Number(s); // hop count
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  clientOrigin: string;
  accessSecret: string;
  refreshSecret: string;
  accessTtl: string;
  refreshTtl: string;
  redisUrl: string | null;
  databaseUrl: string | null;
  rakeBps: number;
  tournamentDualControl: boolean; // require a 2nd distinct admin to confirm a champion payout
  depositPollMs: number; // auto-credit poller cadence for active depositors (0 = off)
  movelogRetentionDays: number; // prune move-logs older than this many days (0 = keep forever)
  turnMs: number;
  countdownMs: number;
  handPauseMs: number; // inter-hand standings pause (ms); 0 = immediate next deal
  abandonMs: number;
  paymentWebhookSecret: string;
  paymentWebhookIps: string[];
  trustProxy: boolean | number | string[]; // Fastify trustProxy: which proxy hops/IPs to trust for X-Forwarded-For
  metricsToken: string | null;             // bearer token guarding GET /metrics (null = private-IP-only)
  resendApiKey: string | null;
  emailFrom: string;
  adminEmail: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  telegramWebhookSecret: string | null;
  autoWithdrawMaxCents: number; // 0 = off; semi-auto fast-track threshold for KYC-verified players
  dailyAutoWithdrawCapCents: number; // 0 = off; per-user 24h auto-payout cap (excess → manual)
  sweepAlertCents: number; // 0 = off; >0 = "time to sweep" Telegram alert at this on-chain deposit total
  autoWithdrawCurrency: string; // payout coin/network (e.g. 'usdttrc20')
  binanceApiKey: string | null;
  binanceApiSecret: string | null;
  tronDepositXpub: string | null;
  tronDepositAddress: string | null;
  tronGridApiKey: string | null;
  compliance: {
    kycRequired: boolean;
    minAge: number;
    blockedCountries: string[];
    responsibleGaming: boolean;
  };
  rewardsEnabled: boolean;
  isProd: boolean;
  /** Staging/demo only: permit the stub payment/email providers in production. Never enable for real money. */
  allowStubProviders: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  const isProd = parsed.NODE_ENV === 'production';
  const stubRaw = (parsed.ALLOW_STUB_PROVIDERS ?? '').trim();

  if (isProd) {
    // Fail CLOSED: a production deploy that forgot to set strong secrets must not
    // boot with a present-but-weak/placeholder value (e.g. the docker-compose
    // 'change-me-*' defaults or the dev fallbacks below) — those are publicly
    // known and would make every token forgeable.
    const PLACEHOLDER = /change[-_ ]?me|^dev-|secret-change/i;
    for (const [name, val] of [
      ['JWT_ACCESS_SECRET', parsed.JWT_ACCESS_SECRET],
      ['JWT_REFRESH_SECRET', parsed.JWT_REFRESH_SECRET],
      ['PAYMENT_WEBHOOK_SECRET', parsed.PAYMENT_WEBHOOK_SECRET],
    ] as const) {
      if (!val) throw new Error(`${name} is required in production.`);
      if (val.length < 32) throw new Error(`${name} must be at least 32 characters in production.`);
      if (PLACEHOLDER.test(val)) throw new Error(`${name} looks like a placeholder/dev secret — set a strong, unique value in production.`);
    }
    if (parsed.JWT_ACCESS_SECRET === parsed.JWT_REFRESH_SECRET) {
      throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different in production.');
    }

    // Fail CLOSED on compliance: a real-money production deploy must make a DELIBERATE
    // decision on each gate, never inherit a silent OFF default. Every compliance flag
    // must be explicitly present in the environment — set it to enable, or explicitly
    // to a disabling value ('false'/'0'/'' for geo) to acknowledge it is intentionally
    // off for this jurisdiction. This prevents accidentally shipping with zero KYC/age/geo.
    const COMPLIANCE_FLAGS = ['KYC_REQUIRED', 'MIN_AGE', 'GEO_BLOCKED_COUNTRIES', 'RESPONSIBLE_GAMING'] as const;
    const unset = COMPLIANCE_FLAGS.filter((k) => env[k] === undefined);
    if (unset.length > 0) {
      throw new Error(
        `Compliance flags must be explicitly configured in production (unset: ${unset.join(', ')}). ` +
        `Set each to enable, or explicitly to a disabling value ('false'/'0', or empty for GEO_BLOCKED_COUNTRIES) to acknowledge it is intentionally off.`,
      );
    }

    // Fail CLOSED on the stub-providers escape: a bare ALLOW_STUB_PROVIDERS=true/1
    // (e.g. left over from a demo) must NOT silently enable mock deposits/email on a
    // real-money host. 'false'/'0'/unset = off; only the explicit phrase opts in.
    const stubDisabled = stubRaw === '' || stubRaw === 'false' || stubRaw === '0';
    if (!stubDisabled && stubRaw !== STUB_PROD_PHRASE) {
      throw new Error(
        `ALLOW_STUB_PROVIDERS="${stubRaw}" is refused in production (mock payment/email must never run with real money). ` +
        `Remove it for a real deploy, or set ALLOW_STUB_PROVIDERS=${STUB_PROD_PHRASE} for a deliberate staging/demo WITHOUT real money.`,
      );
    }

    // CORS: a wildcard origin with credentials is always unsafe — refuse it. A
    // non-HTTPS origin in prod is suspicious (cookies are Secure) — warn loudly.
    if (parsed.CLIENT_ORIGIN.includes('*')) {
      throw new Error('CLIENT_ORIGIN must be an exact origin in production, not a wildcard (credentialed CORS with "*" is unsafe).');
    }
    if (!parsed.CLIENT_ORIGIN.startsWith('https://')) {
      // eslint-disable-next-line no-console
      console.warn(`⚠️  CLIENT_ORIGIN is not https:// in production (${parsed.CLIENT_ORIGIN}) — secure cookies + CORS expect your real HTTPS site origin. Set CLIENT_ORIGIN=https://yourdomain.`);
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    clientOrigin: parsed.CLIENT_ORIGIN,
    accessSecret: parsed.JWT_ACCESS_SECRET ?? DEV_ACCESS_SECRET,
    refreshSecret: parsed.JWT_REFRESH_SECRET ?? DEV_REFRESH_SECRET,
    accessTtl: parsed.ACCESS_TTL,
    refreshTtl: parsed.REFRESH_TTL,
    redisUrl: parsed.REDIS_URL ?? null,
    databaseUrl: parsed.DATABASE_URL ?? null,
    rakeBps: parsed.RAKE_BPS,
    tournamentDualControl: isTrue(parsed.TOURNAMENT_DUAL_CONTROL),
    depositPollMs: parsed.DEPOSIT_POLL_MS,
    movelogRetentionDays: parsed.MOVELOG_RETENTION_DAYS,
    turnMs: parsed.TURN_MS,
    countdownMs: parsed.COUNTDOWN_MS,
    handPauseMs: parsed.HAND_PAUSE_MS,
    abandonMs: parsed.ABANDON_MS,
    paymentWebhookSecret: parsed.PAYMENT_WEBHOOK_SECRET ?? 'dev-webhook-secret-change-me',
    paymentWebhookIps: (parsed.PAYMENT_WEBHOOK_IPS ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0),
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
    metricsToken: parsed.METRICS_TOKEN || null,
    resendApiKey: parsed.RESEND_API_KEY || null,
    emailFrom: parsed.EMAIL_FROM || 'Murlan <onboarding@resend.dev>',
    adminEmail: parsed.ADMIN_EMAIL ? parsed.ADMIN_EMAIL.trim().toLowerCase() : null,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: parsed.TELEGRAM_CHAT_ID || null,
    telegramWebhookSecret: parsed.TELEGRAM_WEBHOOK_SECRET || null,
    autoWithdrawMaxCents: parsed.AUTO_WITHDRAW_MAX_CENTS,
    dailyAutoWithdrawCapCents: parsed.DAILY_AUTO_WITHDRAW_CAP_CENTS,
    sweepAlertCents: parsed.SWEEP_ALERT_CENTS,
    autoWithdrawCurrency: parsed.AUTO_WITHDRAW_CURRENCY,
    binanceApiKey: parsed.BINANCE_API_KEY || null,
    binanceApiSecret: parsed.BINANCE_API_SECRET || null,
    tronDepositXpub: parsed.TRON_DEPOSIT_XPUB || null,
    tronDepositAddress: parsed.TRON_DEPOSIT_ADDRESS || null,
    tronGridApiKey: parsed.TRONGRID_API_KEY || null,
    compliance: {
      kycRequired: isTrue(parsed.KYC_REQUIRED),
      minAge: parsed.MIN_AGE,
      blockedCountries: (parsed.GEO_BLOCKED_COUNTRIES ?? '')
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => c.length > 0),
      responsibleGaming: isTrue(parsed.RESPONSIBLE_GAMING),
    },
    rewardsEnabled: parsed.REWARDS_ENABLED === undefined ? true : isTrue(parsed.REWARDS_ENABLED),
    isProd,
    // In prod, stubs require the explicit phrase (a bare `true` already threw above).
    // In dev/test, keep the simple `true`/`1` toggle for convenience.
    allowStubProviders: isProd ? stubRaw === STUB_PROD_PHRASE : isTrue(parsed.ALLOW_STUB_PROVIDERS),
  };
}
