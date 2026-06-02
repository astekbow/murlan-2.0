// ============================================================================
// MURLAN — Server configuration
// ----------------------------------------------------------------------------
// Parsed once from the environment. Secrets have DEV-ONLY fallbacks so the app
// boots locally; in production (NODE_ENV=production) missing secrets throw.
// ============================================================================

import { z } from 'zod';

const DEV_ACCESS_SECRET = 'dev-access-secret-change-me';
const DEV_REFRESH_SECRET = 'dev-refresh-secret-change-me';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().nonnegative().default(3000), // 0 = OS-assigned ephemeral port
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
  ABANDON_MS: z.coerce.number().int().positive().default(30_000), // reconnect grace before forfeit
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
  // Compliance switches (spec §13) — OFF by default; flip on per jurisdiction.
  KYC_REQUIRED: z.string().optional(),
  MIN_AGE: z.coerce.number().int().min(0).default(0),
  GEO_BLOCKED_COUNTRIES: z.string().optional(), // CSV of ISO-2 codes
  RESPONSIBLE_GAMING: z.string().optional(),
  // Engagement rewards (§2.6) — ON by default; set false to disable per jurisdiction.
  REWARDS_ENABLED: z.string().optional(),
});

const isTrue = (v: string | undefined): boolean => v === 'true' || v === '1';

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
  turnMs: number;
  countdownMs: number;
  abandonMs: number;
  paymentWebhookSecret: string;
  compliance: {
    kycRequired: boolean;
    minAge: number;
    blockedCountries: string[];
    responsibleGaming: boolean;
  };
  rewardsEnabled: boolean;
  isProd: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  const isProd = parsed.NODE_ENV === 'production';

  if (isProd && (!parsed.JWT_ACCESS_SECRET || !parsed.JWT_REFRESH_SECRET || !parsed.PAYMENT_WEBHOOK_SECRET)) {
    throw new Error('JWT_ACCESS_SECRET, JWT_REFRESH_SECRET and PAYMENT_WEBHOOK_SECRET are required in production.');
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
    turnMs: parsed.TURN_MS,
    countdownMs: parsed.COUNTDOWN_MS,
    abandonMs: parsed.ABANDON_MS,
    paymentWebhookSecret: parsed.PAYMENT_WEBHOOK_SECRET ?? 'dev-webhook-secret-change-me',
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
  };
}
