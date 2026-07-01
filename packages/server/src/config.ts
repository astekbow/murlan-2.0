// ============================================================================
// MURLAN — Server configuration
// ----------------------------------------------------------------------------
// Parsed once from the environment. Secrets have DEV-ONLY fallbacks so the app
// boots locally; in production (NODE_ENV=production) missing secrets throw.
// ============================================================================

import { z } from 'zod';
import { randomBytes } from 'node:crypto';

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
  ACCESS_TTL: z.string().default('5m'), // short by design — access tokens are now
  // revocation-aware (ver claim), but a short TTL still caps any residual window.
  REFRESH_TTL: z.string().default('7d'),
  REDIS_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(), // when set, use Prisma/Postgres instead of in-memory
  // Money knobs (used in Phase 6); kept here so config is the single source.
  RAKE_BPS: z.coerce.number().int().min(0).max(10_000).default(1_000), // 10.00%
  TURN_MS: z.coerce.number().int().positive().default(30_000),
  COUNTDOWN_MS: z.coerce.number().int().nonnegative().default(3_000),
  HAND_PAUSE_MS: z.coerce.number().int().min(0).max(60_000).default(7_000), // inter-hand standings pause; 0 = deal next hand immediately
  ABANDON_MS: z.coerce.number().int().positive().default(30_000), // reconnect grace before forfeit
  RANKED_BOT_MS: z.coerce.number().int().positive().default(20_000), // ranked solo-queue → vs-BOT fallback: no human opponent within this window starts a RATED bot match
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
  PAYMENT_WEBHOOK_IPS: z.string().optional(), // CSV of allowed source IPs for the webhook (empty = allow any)
  TRUST_PROXY: z.string().optional(), // 'true'|'false'|hop-count|CSV of trusted proxy IPs/CIDRs (default: loopback + RFC1918)
  METRICS_TOKEN: z.string().optional(), // when set, GET /metrics requires Authorization: Bearer <token> (else served only to private/loopback IPs)
  RESEND_API_KEY: z.string().optional(),       // set to send real reset/verification emails via Resend
  EMAIL_FROM: z.string().optional(),           // sender, e.g. "Murlan <noreply@yourdomain.com>"
  ADMIN_EMAIL: z.string().optional(),          // this account is auto-promoted to admin on boot
  VAPID_PUBLIC_KEY: z.string().optional(),     // Web Push public key (safe to expose) — `npx web-push generate-vapid-keys`
  VAPID_PRIVATE_KEY: z.string().optional(),    // Web Push private key — SECRET, server-only; enables real delivery
  VAPID_SUBJECT: z.string().optional(),        // VAPID contact: a mailto: or https URL (defaults to the admin mail)
  TELEGRAM_BOT_TOKEN: z.string().optional(),   // set BOTH token + chat id → ops alerts (e.g. new withdrawal) to Telegram
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(), // set → the admin bot is active: Telegram updates POST to /api/telegram/webhook (verified by this secret)
  AUTO_WITHDRAW_MAX_CENTS: z.coerce.number().int().nonnegative().default(0), // 0 = OFF; >0 = withdrawals ≤ this from KYC-verified users are flagged "auto-eligible" (fast-track)
  DAILY_AUTO_WITHDRAW_CAP_CENTS: z.coerce.number().int().nonnegative().default(0), // 0 = no daily cap; >0 = once a user's 24h withdrawals exceed this, further ones go MANUAL (anti-drain/AML)
  SWEEP_ALERT_CENTS: z.coerce.number().int().nonnegative().default(0), // 0 = OFF; >0 = Telegram "time to sweep" alert once the on-chain deposit-address USDT total reaches this (e.g. 10000 = $100)
  // money: how long (minutes) the auto-credit poller watches a player's deposit address after they
  // open the deposit screen. A transfer arriving AFTER this window isn't auto-credited (still
  // recoverable via the manual TxID paste). Was a hard-coded 30 min; default 120 (2h) is more
  // forgiving for a player who opens the screen then sends later. Idle cost stays proportional to
  // recent depositors, not total users.
  DEPOSIT_WATCH_MINUTES: z.coerce.number().int().positive().max(1440).default(120),
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
  // Demo leaderboard: seed the global (XP) leaderboard with ~100 deterministic demo
  // players so a fresh launch looks populated. ON by default; set false to show ONLY
  // real users once there's an organic player base.
  DEMO_LEADERBOARD: z.string().optional(),
  // Four-eyes on the tournament champion payout — needs TWO distinct admins. OFF by
  // default (a solo operator has no second admin; it would block every payout).
  TOURNAMENT_DUAL_CONTROL: z.string().optional(),
  // admin-6: require a 2nd distinct admin to confirm a manual balance adjustment. OFF by
  // default (the owner is a solo admin; mandatory dual-control would lock them out). The
  // per-call ceiling + per-admin rolling-24h cap + no-self-credit ALWAYS apply regardless.
  ADJUST_DUAL_CONTROL: z.string().optional(),
  // money-2: only the SINGLE payout-leader instance auto-pays crypto withdrawals. The anti-drain
  // budgets + serialization are in-process, so on >1 replica a non-leader must NOT auto-pay (it
  // routes everything to manual) or two replicas could each auto-pay past the shared cap. Default
  // TRUE (single-instance deploy = the leader); set PAYOUT_LEADER=false on every EXTRA replica.
  PAYOUT_LEADER: z.string().optional(),
  // money-4/6: per-user rolling-24h cap on P2P transfers OUT (cents). Default $1,000/day as a
  // baseline AML guardrail (audit M1 — default-capped, not default-open). Set 0 to disable, or a
  // higher value to loosen. >0 turns on the DB/ledger-enforced rail (sum of transfer_out in 24h).
  DAILY_TRANSFER_CAP_CENTS: z.coerce.number().int().nonnegative().default(100_000),
  // money-7: global rolling-24h auto-payout budget across ALL users (cents). 0 = OFF; >0 =
  // once total auto-paid in 24h would breach this, further auto-sends are forced to MANUAL.
  GLOBAL_AUTO_WITHDRAW_CAP_CENTS: z.coerce.number().int().nonnegative().default(0),
  // money-7: per-destination-ADDRESS rolling-24h auto-payout cap (cents). 0 = OFF; >0 =
  // once a single address has received this much auto-pay in 24h, further ones go MANUAL.
  DEST_AUTO_WITHDRAW_CAP_CENTS: z.coerce.number().int().nonnegative().default(0),
});

const isTrue = (v: string | undefined): boolean => v === 'true' || v === '1';

// Parse a JWT TTL string ('15m', '5m', '30s', '2h', '7d') or a bare number (seconds)
// to milliseconds. Returns null if it can't be parsed (caller treats that as invalid).
const TTL_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
function ttlToMs(v: string): number | null {
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000; // bare seconds (jsonwebtoken convention)
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * TTL_UNIT_MS[m[2]!]!;
}
// An access token is bearer authority for its whole life; even with revocation-aware
// auth, an excessively long TTL widens the residual window (the per-request DB check
// is the backstop, the short TTL is defense-in-depth). Refuse a misconfigured value.
const ACCESS_TTL_MAX_MS = 15 * 60 * 1000; // 15 minutes

// Default: trust ONLY loopback + private (RFC1918) ranges — the reverse proxy
// (Caddy/nginx) always reaches the server from a private/Docker IP, and the server
// isn't publicly reachable, so a spoofed X-Forwarded-For from the outside is ignored
// and req.ip resolves to the right-most UNtrusted address (the real client).
//
// TIGHTEN this in production to the EXACT proxy hop(s): set TRUST_PROXY to the proxy's
// concrete IP/CIDR (e.g. the Docker bridge address of the nginx/Caddy container, like
// '172.18.0.0/16'), or a small hop count matching your chain. Do NOT set TRUST_PROXY=true
// — it trusts ANY upstream and lets a client spoof its IP via a forged X-Forwarded-For,
// re-collapsing rate-limit buckets and poisoning the webhook IP allowlist.
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
  adjustDualControl: boolean; // admin-6: require a 2nd admin to confirm a manual balance adjust (OFF by default)
  payoutLeader: boolean; // money-2: this instance is THE auto-payout leader (default true); false on extra replicas
  dailyTransferCapCents: number; // money-4/6: per-user 24h P2P transfer-out cap (0 = unlimited)
  globalAutoWithdrawCapCents: number; // money-7: global 24h auto-payout budget (0 = off)
  destAutoWithdrawCapCents: number; // money-7: per-destination-address 24h auto-payout cap (0 = off)
  depositPollMs: number; // auto-credit poller cadence for active depositors (0 = off)
  movelogRetentionDays: number; // prune move-logs older than this many days (0 = keep forever)
  turnMs: number;
  countdownMs: number;
  handPauseMs: number; // inter-hand standings pause (ms); 0 = immediate next deal
  abandonMs: number;
  rankedBotMs: number; // ranked solo-queue → vs-BOT fallback delay (ms); 0 disabled by schema (positive)
  paymentWebhookSecret: string;
  paymentWebhookIps: string[];
  trustProxy: boolean | number | string[]; // Fastify trustProxy: which proxy hops/IPs to trust for X-Forwarded-For
  metricsToken: string | null;             // bearer token guarding GET /metrics (null = private-IP-only)
  resendApiKey: string | null;
  emailFrom: string;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  vapidSubject: string;
  adminEmail: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  telegramWebhookSecret: string | null;
  autoWithdrawMaxCents: number; // 0 = off; semi-auto fast-track threshold for KYC-verified players
  dailyAutoWithdrawCapCents: number; // 0 = off; per-user 24h auto-payout cap (excess → manual)
  sweepAlertCents: number; // 0 = off; >0 = "time to sweep" Telegram alert at this on-chain deposit total
  depositWatchMs: number; // how long the auto-credit poller watches a deposit address (from DEPOSIT_WATCH_MINUTES)
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
  demoLeaderboard: boolean; // seed the global XP leaderboard with ~100 demo players (ON by default)
  isProd: boolean;
  /** Staging/demo only: permit the stub payment/email providers in production. Never enable for real money. */
  allowStubProviders: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  const isProd = parsed.NODE_ENV === 'production';
  const stubRaw = (parsed.ALLOW_STUB_PROVIDERS ?? '').trim();

  // Bound the access-token TTL (no upper limit was enforced before). An unparseable
  // or too-long value is a misconfiguration — fail closed in every environment.
  const accessTtlMs = ttlToMs(parsed.ACCESS_TTL);
  if (accessTtlMs == null || accessTtlMs <= 0) {
    throw new Error(`ACCESS_TTL="${parsed.ACCESS_TTL}" is not a valid duration (e.g. '5m', '300s').`);
  }
  if (accessTtlMs > ACCESS_TTL_MAX_MS) {
    throw new Error(`ACCESS_TTL="${parsed.ACCESS_TTL}" exceeds the maximum of 15m — access tokens are short-lived bearer authority; use a refresh token for longer sessions.`);
  }

  // telegram-2/3: a GROUP/supergroup chat id is NEGATIVE; a private (1:1 owner) chat id is
  // POSITIVE. The admin bot's money commands authorize on the sender's id matching this
  // value — if it were a group id, every group member would be a money admin. Refuse a
  // negative TELEGRAM_CHAT_ID at boot in EVERY environment (it must be the owner's private
  // chat/user id). An empty value is allowed (the bot just isn't configured).
  const tgChat = (parsed.TELEGRAM_CHAT_ID ?? '').trim();
  if (tgChat !== '' && /^-\d+$/.test(tgChat)) {
    throw new Error('TELEGRAM_CHAT_ID is a group/supergroup chat id (negative) — the admin bot must target the owner\'s PRIVATE chat (a positive user id), or every group member becomes a money admin.');
  }

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

    // #10 — When the Telegram admin bot is ENABLED (token + chat id + webhook secret all
    // set), the webhook secret is the SOLE auth boundary for the bot's money commands, so
    // it must meet the same strength bar as the other prod secrets. (The bot is opt-in; if
    // any of token/chat/secret is unset the bot isn't mounted and this is skipped.)
    const botEnabled = !!(parsed.TELEGRAM_BOT_TOKEN && parsed.TELEGRAM_CHAT_ID && parsed.TELEGRAM_WEBHOOK_SECRET);
    if (botEnabled) {
      const s = parsed.TELEGRAM_WEBHOOK_SECRET!;
      if (s.length < 32) throw new Error('TELEGRAM_WEBHOOK_SECRET must be at least 32 characters in production (it is the only auth on the admin bot webhook).');
      if (PLACEHOLDER.test(s)) throw new Error('TELEGRAM_WEBHOOK_SECRET looks like a placeholder/dev secret — set a strong, unique value in production.');
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

    // infra-6: /metrics must be token-gated in production. If METRICS_TOKEN is unset we
    // AUTO-GENERATE a random one in the return below — so the endpoint is effectively CLOSED
    // (nobody knows the token) WITHOUT crashing a deploy that didn't set it. Set METRICS_TOKEN
    // explicitly to point a monitoring scraper at it. The loopback bind stays as defense-in-depth.
    if (!parsed.METRICS_TOKEN || parsed.METRICS_TOKEN.trim() === '') {
      console.warn('[config] METRICS_TOKEN not set in production — /metrics is closed behind an auto-generated token; set METRICS_TOKEN to enable a monitoring scraper.');
    }

    // infra-8: TRUST_PROXY=true trusts ANY upstream, letting a client forge X-Forwarded-For
    // and move req.ip (re-collapsing rate-limit buckets, poisoning the webhook IP allowlist).
    // Refuse `true` in production. A BLANK value is ALLOWED — it keeps the loopback+RFC1918
    // default, which the single nginx hop in the deployed topology resolves correctly, so a
    // deploy that didn't set it still boots; set the concrete proxy CIDR/hop count to be strict.
    const tpRaw = (parsed.TRUST_PROXY ?? '').trim();
    if (tpRaw === 'true') {
      throw new Error('TRUST_PROXY=true is refused in production — it trusts ANY upstream, letting a client forge X-Forwarded-For to spoof its IP. Set the concrete proxy IP/CIDR or a small hop count (e.g. "1").');
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
    adjustDualControl: isTrue(parsed.ADJUST_DUAL_CONTROL),
    payoutLeader: parsed.PAYOUT_LEADER === undefined ? true : isTrue(parsed.PAYOUT_LEADER),
    dailyTransferCapCents: parsed.DAILY_TRANSFER_CAP_CENTS,
    globalAutoWithdrawCapCents: parsed.GLOBAL_AUTO_WITHDRAW_CAP_CENTS,
    destAutoWithdrawCapCents: parsed.DEST_AUTO_WITHDRAW_CAP_CENTS,
    depositPollMs: parsed.DEPOSIT_POLL_MS,
    movelogRetentionDays: parsed.MOVELOG_RETENTION_DAYS,
    turnMs: parsed.TURN_MS,
    countdownMs: parsed.COUNTDOWN_MS,
    handPauseMs: parsed.HAND_PAUSE_MS,
    abandonMs: parsed.ABANDON_MS,
    rankedBotMs: parsed.RANKED_BOT_MS,
    paymentWebhookSecret: parsed.PAYMENT_WEBHOOK_SECRET ?? 'dev-webhook-secret-change-me',
    paymentWebhookIps: (parsed.PAYMENT_WEBHOOK_IPS ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0),
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
    // Explicit token if set; in prod a random one (closes /metrics, boot-safe); dev = null (loopback-only).
    metricsToken: (parsed.METRICS_TOKEN ?? '').trim() || (isProd ? randomBytes(24).toString('hex') : null),
    resendApiKey: parsed.RESEND_API_KEY || null,
    emailFrom: parsed.EMAIL_FROM || 'Murlan <onboarding@resend.dev>',
    adminEmail: parsed.ADMIN_EMAIL ? parsed.ADMIN_EMAIL.trim().toLowerCase() : null,
    vapidPublicKey: parsed.VAPID_PUBLIC_KEY || null,
    vapidPrivateKey: parsed.VAPID_PRIVATE_KEY || null,
    vapidSubject: parsed.VAPID_SUBJECT || (parsed.ADMIN_EMAIL ? `mailto:${parsed.ADMIN_EMAIL.trim()}` : 'mailto:admin@cryptomurlan.com'),
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: parsed.TELEGRAM_CHAT_ID || null,
    telegramWebhookSecret: parsed.TELEGRAM_WEBHOOK_SECRET || null,
    autoWithdrawMaxCents: parsed.AUTO_WITHDRAW_MAX_CENTS,
    dailyAutoWithdrawCapCents: parsed.DAILY_AUTO_WITHDRAW_CAP_CENTS,
    sweepAlertCents: parsed.SWEEP_ALERT_CENTS,
    depositWatchMs: parsed.DEPOSIT_WATCH_MINUTES * 60 * 1000,
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
    demoLeaderboard: parsed.DEMO_LEADERBOARD === undefined ? true : isTrue(parsed.DEMO_LEADERBOARD),
    isProd,
    // In prod, stubs require the explicit phrase (a bare `true` already threw above).
    // In dev/test, keep the simple `true`/`1` toggle for convenience.
    allowStubProviders: isProd ? stubRaw === STUB_PROD_PHRASE : isTrue(parsed.ALLOW_STUB_PROVIDERS),
  };
}
