// ============================================================================
// MURLAN — Application composition root
// ----------------------------------------------------------------------------
// `buildHttpApp` builds the Fastify app (REST + middleware) for both serving and
// `app.inject` tests. `createGameServer` wires the full stack: HTTP + Socket.IO
// gateway + RoomManager + AuthService (+ optional Redis adapter).
//
// The user store is in-memory here; production swaps in a Prisma-backed
// UserRepository without touching callers (see userRepository.ts).
// ============================================================================

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Server } from 'socket.io';
import type {
  ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData,
} from '@murlan/shared';
import { loadConfig, type AppConfig } from './config.ts';
import { InMemoryUserRepository, type UserRepository } from './auth/userRepository.ts';
import { TokenService } from './auth/tokens.ts';
import { AuthService } from './auth/authService.ts';
import { InMemoryRefreshTokens, type RefreshTokenRepository } from './auth/refreshTokens.ts';
import { InMemoryAdminAudit, type AdminAuditRepository } from './auth/adminAudit.ts';
import { InMemoryGames, type GamesRepository } from './fair/gamesRepository.ts';
import { InMemoryMatchActions, type MatchActionsRepository } from './realtime/matchActions.ts';
import { InMemoryVerificationTokens, type VerificationTokenRepository } from './auth/verificationTokens.ts';
import { fairRoutes } from './http/fairRoutes.ts';
import { registry, httpRequestDuration, reconcileMismatches, orphanedMatchesRefunded, activeMatches, pendingWithdrawals, treasuryBufferCents as treasuryBufferGauge } from './metrics.ts';
import { authRoutes, requireAdmin } from './http/authRoutes.ts';
import { walletRoutes } from './http/walletRoutes.ts';
import { adminRoutes } from './http/adminRoutes.ts';
import { accountRoutes } from './http/accountRoutes.ts';
import { ComplianceService } from './compliance/complianceService.ts';
import { ResponsibleGamingService } from './compliance/responsibleGaming.ts';
import { RoomManager } from './room/roomManager.ts';
import { GameGateway, type AdminVoidResult } from './realtime/gateway.ts';
import { attachRedisAdapter } from './realtime/redisAdapter.ts';
import { InMemoryRoomOwnership } from './realtime/roomOwnership.ts';
import { InMemoryLedger, type LedgerRepository } from './money/ledger.ts';
import { WalletService } from './money/walletService.ts';
import { InMemoryMatchesRepository, type MatchesRepository } from './money/matchesRepository.ts';
import { MoneyService } from './money/moneyService.ts';
import { MockPaymentProvider, type PaymentProvider } from './money/paymentProvider.ts';
import { ConsoleEmailProvider, type EmailProvider } from './email/emailProvider.ts';
import { ResendEmailProvider } from './email/resendEmailProvider.ts';
import { createNotifier, type Notifier } from './notify/notifier.ts';
import { NullPayoutProvider, type PayoutProvider } from './money/payoutProvider.ts';
import { BinancePayoutProvider } from './money/binancePayout.ts';
import { TronDepositVerifier } from './money/tronDeposit.ts';
import { TronHdWallet } from './money/tronHd.ts';
import { BinanceDepositLister, BinanceAccountReader, checkUnclaimedDeposits } from './money/binanceDeposits.ts';
import { findStaleWithdrawals, pruneAlerted, treasuryBufferCents, reconcileFailedWithdrawals } from './money/paymentMonitor.ts';
import { BinanceWithdrawReader } from './money/binancePayout.ts';
import { InMemoryWithdrawals, WithdrawalService, type WithdrawalRepository } from './money/withdrawals.ts';
import { InMemoryDepositIntents, type DepositIntentRepository } from './money/depositIntents.ts';
import type { UnitOfWork } from './money/unitOfWork.ts';
import { InMemoryFriends, type FriendsRepository } from './social/friendsRepository.ts';
import { ProfileService } from './profile/profileService.ts';
import { FriendsService } from './social/friendsService.ts';
import { Presence } from './realtime/presence.ts';
import { socialRoutes } from './http/socialRoutes.ts';
import { RewardsService } from './rewards/rewardsService.ts';
import { rewardsRoutes } from './http/rewardsRoutes.ts';
import { InMemorySeasonRepository, type SeasonRepository } from './ranked/seasonRepository.ts';
import { RankedService } from './ranked/rankedService.ts';
import { rankedRoutes } from './http/rankedRoutes.ts';
import { MatchmakingService } from './realtime/matchmaking.ts';
import { InMemorySupportRepository, type SupportRepository } from './support/supportRepository.ts';
import { supportRoutes } from './http/supportRoutes.ts';
import { replayRoutes } from './http/replayRoutes.ts';
import { InMemorySuspicion, type SuspicionRepository } from './antiCheat/suspicionRepository.ts';
import { AntiCheatService } from './antiCheat/antiCheatService.ts';
import { InMemoryPushSubscriptions, type PushSubscriptionRepository } from './push/pushRepository.ts';
import { PushService } from './push/pushService.ts';
import { ConsolePushProvider } from './push/pushProvider.ts';
import { VipService } from './vip/vipService.ts';
import { vipRoutes } from './http/vipRoutes.ts';
import { InMemoryClubRepository, type ClubRepository } from './social/clubRepository.ts';
import { ClubService } from './social/clubService.ts';
import { InMemoryChatRepository, type ChatRepository } from './chat/chatRepository.ts';
import { ChatService } from './chat/chatService.ts';
import { clubRoutes } from './http/clubRoutes.ts';
import { tournamentRoutes } from './http/tournamentRoutes.ts';
import { TournamentService, InMemoryTournamentRepository, type TournamentRepository, type TournamentWallet } from './tournament/tournamentService.ts';

export interface HttpDeps {
  auth: AuthService;
  config: AppConfig;
  wallet?: WalletService;
  withdrawals?: WithdrawalService;
  provider?: PaymentProvider;
  intents?: DepositIntentRepository;
  compliance?: ComplianceService;
  rg?: ResponsibleGamingService;
  vip?: VipService;
  clubs?: ClubService;
  tournaments?: TournamentService;
  chat?: ChatService;
  rooms?: RoomManager;
  notifier?: Notifier; // ops alerts (Telegram) — e.g. new withdrawal request
  payout?: PayoutProvider; // auto crypto payout for small KYC-verified withdrawals
  tronDeposit?: TronDepositVerifier; // fee-free USDT-TRC20 deposits via TxID verify
  binanceFreeUsdtCents?: () => Promise<number | null>; // treasury: Binance free-USDT payout pool
  depositWallet?: TronHdWallet; // watch-only HD wallet → unique per-player deposit address
  tronDepositAddress?: string | null;
  kickUser?: (userId: string) => void; // force-disconnect a user's live sockets (ban/suspend)
  matches?: MatchesRepository; // for admin revenue-by-match-type reporting
  voidMatch?: (roomId: string, meta: { adminId: string; reason: string }) => Promise<AdminVoidResult | { ok: false; reason: 'unavailable' }>;
  profiles?: ProfileService;
  ranked?: RankedService;
  friends?: FriendsService;
  rewards?: RewardsService;
  adminAudit?: AdminAuditRepository;
  games?: GamesRepository;
  matchLog?: MatchActionsRepository;
  support?: SupportRepository;
  antiCheat?: AntiCheatService;
  push?: PushService;
  dbPing?: () => Promise<boolean>; // readiness probe for the DB (Prisma only)
  isDraining?: () => boolean; // true during graceful shutdown → /ready returns 503
}

export async function buildHttpApp(deps: HttpDeps): Promise<FastifyInstance> {
  // Structured (pino) logging always on — info in prod, warn in dev to stay quiet.
  // Redact credentials so tokens/cookies never land in logs.
  const app = Fastify({
    logger: {
      level: deps.config.isProd ? 'info' : 'warn',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    // Behind a reverse proxy (Caddy/nginx): honor X-Forwarded-For so req.ip is the
    // real client — used by IP-keyed rate-limiting and the payment-webhook allowlist.
    // We trust XFF ONLY from the proxy (default: loopback + RFC1918 private ranges,
    // configurable via TRUST_PROXY), so a client that ever reaches the server directly
    // can't spoof its IP. The proxy must set XFF authoritatively.
    trustProxy: deps.config.trustProxy,
  });

  // Capture the RAW JSON body (needed for webhook signature verification) while
  // still parsing JSON normally for every route.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const raw = body.toString('utf8');
    (req as unknown as { rawBody?: string }).rawBody = raw;
    if (raw.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  await app.register(cookie);
  // Security headers (HSTS in prod, frameguard, noSniff, referrer policy). CSP is
  // left off here because the SPA is served separately (Vite/static host owns it);
  // enable a CSP at that layer for the client origin.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    hsts: deps.config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
  });
  await app.register(cors, { origin: deps.config.clientOrigin, credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // Global safety net: an UNHANDLED route exception must never leak its message or
  // stack to a (real-money) client. Our explicit 4xx replies and Fastify's own
  // validation 4xx pass through with their status + message; anything 500-level is
  // logged server-side and returned as a generic error.
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; code?: string; message?: string };
    const sc = typeof e.statusCode === 'number' ? e.statusCode : 500;
    const status = sc >= 400 && sc < 500 ? sc : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled route error');
    reply.code(status).send({
      error: {
        code: status >= 500 ? 'internal' : (e.code ?? 'error'),
        message: status >= 500 ? 'Gabim i brendshëm.' : (e.message ?? 'Gabim.'),
      },
    });
  });

  // Observability: time every request into a Prometheus histogram (keyed by the
  // ROUTE PATTERN, not the raw path, to avoid label cardinality blow-up).
  app.addHook('onResponse', (req, reply, done) => {
    const route = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? req.url;
    httpRequestDuration.observe({ method: req.method, route, status: reply.statusCode }, reply.elapsedTime / 1000);
    done();
  });
  // Metrics can leak operational info, so guard them: if METRICS_TOKEN is set, require
  // a matching bearer token; otherwise serve ONLY to private/loopback IPs (a public
  // scrape via the proxy is refused). Scrapers on the internal network still work.
  const metricsToken = deps.config.metricsToken;
  const isPrivateIp = (ip: string): boolean =>
    ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' ||
    /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^(::ffff:)?(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  app.get('/metrics', async (req, reply) => {
    if (metricsToken) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${metricsToken}`) return reply.code(401).send({ error: { code: 'unauthorized', message: 'metrics require a token' } });
    } else if (!isPrivateIp(req.ip)) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'metrics are private' } });
    }
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  // Liveness: cheap, no dependencies — used by the Docker HEALTHCHECK.
  app.get('/health', async () => ({ ok: true, service: 'murlan-server' }));

  // Readiness: 503 if the DB is down OR the instance is DRAINING (graceful
  // shutdown) — either way the load balancer stops routing new traffic here.
  app.get('/ready', async (_req, reply) => {
    if (deps.isDraining?.()) return reply.code(503).send({ ok: false, draining: true });
    const db = deps.dbPing ? await deps.dbPing() : null; // null = in-memory (no DB)
    const ready = db !== false;
    return reply.code(ready ? 200 : 503).send({ ok: ready, db });
  });

  await authRoutes(app, {
    auth: deps.auth,
    isProd: deps.config.isProd,
    // Per-IP. register/verify/forgot/reset: 10 / 5 min. login: tighter 8 / 5 min — and
    // the per-EMAIL throttle in AuthService stops IP-rotation brute-force (MONEY-7/WEB-2).
    authRateLimit: { max: 10, timeWindow: '5 minutes' },
    loginRateLimit: { max: 8, timeWindow: '5 minutes' },
  });
  await accountRoutes(app, { auth: deps.auth, audit: deps.adminAudit, rg: deps.rg, push: deps.push });

  if (deps.profiles && deps.friends) {
    await socialRoutes(app, { auth: deps.auth, profiles: deps.profiles, friends: deps.friends });
  }
  if (deps.rewards) {
    await rewardsRoutes(app, { auth: deps.auth, rewards: deps.rewards, compliance: deps.compliance, rg: deps.rg });
  }
  if (deps.ranked) {
    await rankedRoutes(app, { auth: deps.auth, ranked: deps.ranked });
  }
  if (deps.support) {
    await supportRoutes(app, { auth: deps.auth, support: deps.support, audit: deps.adminAudit });
  }
  if (deps.vip) {
    await vipRoutes(app, { auth: deps.auth, vip: deps.vip });
  }
  if (deps.clubs) {
    await clubRoutes(app, { auth: deps.auth, clubs: deps.clubs, chat: deps.chat });
  }
  if (deps.tournaments) {
    await tournamentRoutes(app, { auth: deps.auth, tournaments: deps.tournaments, compliance: deps.compliance, rg: deps.rg, audit: deps.adminAudit });
  }
  if (deps.antiCheat) {
    // Admin-only review list of anti-collusion/anti-bot heuristic flags (never auto-action).
    const adminGuard = requireAdmin(deps.auth);
    const antiCheat = deps.antiCheat;
    app.get('/api/admin/suspicions', async (req, reply) => {
      if (!(await adminGuard(req, reply))) return;
      const raw = Number((req.query as { minSeverity?: string })?.minSeverity);
      const minSeverity = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
      return reply.send({ flags: await antiCheat.listFlags({ minSeverity, limit: 200 }) });
    });
  }
  if (deps.games) {
    await fairRoutes(app, { games: deps.games });
  }
  if (deps.games && deps.matchLog) {
    await replayRoutes(app, { games: deps.games, matchLog: deps.matchLog });
  }

  if (deps.wallet && deps.withdrawals && deps.provider && deps.intents) {
    await walletRoutes(app, {
      auth: deps.auth, wallet: deps.wallet, withdrawals: deps.withdrawals,
      provider: deps.provider, intents: deps.intents, compliance: deps.compliance, rg: deps.rg,
      notifier: deps.notifier, payout: deps.payout, autoWithdrawMaxCents: deps.config.autoWithdrawMaxCents,
      dailyAutoWithdrawCapCents: deps.config.dailyAutoWithdrawCapCents,
      tronDeposit: deps.tronDeposit, depositWallet: deps.depositWallet, tronDepositAddress: deps.config.tronDepositAddress,
      // Hosted-checkout deposits are disabled in prod when only the mock provider is
      // wired (real deposits use the on-chain TxID flow) — removes dead money surface.
      hostedDepositEnabled: !(deps.config.isProd && deps.provider.name === 'mock' && !deps.config.allowStubProviders),
      webhookIps: deps.config.paymentWebhookIps,
      webhookSignatureHeader: deps.provider.signatureHeader,
    });
    await adminRoutes(app, { auth: deps.auth, wallet: deps.wallet, withdrawals: deps.withdrawals, payout: deps.payout, binanceFreeUsdtCents: deps.binanceFreeUsdtCents, depositAddressBalanceCents: deps.tronDeposit ? (a) => deps.tronDeposit!.usdtBalanceCents(a) : undefined, rooms: deps.rooms, matches: deps.matches, voidMatch: deps.voidMatch, audit: deps.adminAudit, chat: deps.chat, kickUser: deps.kickUser });
  }

  // Lightweight in-house client error logging (no third party): the browser POSTs
  // uncaught errors here; they land in the server logs (pino), rate-limited by the
  // global limiter. No auth — errors can occur before sign-in. Fields are truncated.
  app.post('/api/client-errors', async (req, reply) => {
    const b = (req.body ?? {}) as { message?: unknown; stack?: unknown; url?: unknown; kind?: unknown };
    const message = typeof b.message === 'string' ? b.message.slice(0, 500) : '';
    if (!message) return reply.code(204).send();
    app.log.warn(
      {
        clientError: {
          message,
          stack: typeof b.stack === 'string' ? b.stack.slice(0, 2000) : undefined,
          url: typeof b.url === 'string' ? b.url.slice(0, 300) : undefined,
          kind: typeof b.kind === 'string' ? b.kind.slice(0, 40) : undefined,
          ip: req.ip,
        },
      },
      'client error',
    );
    return reply.code(204).send();
  });

  return app;
}

export interface GameServer {
  app: FastifyInstance;
  io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
  rooms: RoomManager;
  auth: AuthService;
  config: AppConfig;
  listen: () => Promise<void>;
  /** Flip the drain flag manually (mostly for tests; SIGTERM uses drain()). */
  setDraining: (active: boolean) => void;
  /** Graceful shutdown: drain new traffic, settle/refund in-flight, then close. */
  drain: (graceMs?: number) => Promise<number>;
  close: () => Promise<void>;
}

export interface CreateServerOptions {
  config?: AppConfig;
  userRepository?: UserRepository; // inject Prisma repo in production
}

export async function createGameServer(opts: CreateServerOptions = {}): Promise<GameServer> {
  const config = opts.config ?? loadConfig();
  const tokens = new TokenService({
    accessSecret: config.accessSecret,
    refreshSecret: config.refreshSecret,
    accessTtl: config.accessTtl,
    refreshTtl: config.refreshTtl,
  });

  // Persistence: Postgres/Prisma when DATABASE_URL is set, else in-memory.
  // The Prisma module is dynamically imported so the in-memory path never
  // loads @prisma/client. All five stores share the same interface contract.
  let repo: UserRepository;
  let ledger: LedgerRepository;
  let matchesRepo: MatchesRepository;
  let withdrawalsRepo: WithdrawalRepository;
  let intentsRepo: DepositIntentRepository;
  let friendsRepo: FriendsRepository;
  let refreshTokensRepo: RefreshTokenRepository;
  let adminAuditRepo: AdminAuditRepository;
  let gamesRepo: GamesRepository;
  let matchLogRepo: MatchActionsRepository;
  let supportRepo: SupportRepository;
  let suspicionRepo: SuspicionRepository;
  let pushSubsRepo: PushSubscriptionRepository;
  let chatRepo: ChatRepository;
  let clubsRepo: ClubRepository;
  let tournamentsRepo: TournamentRepository;
  let seasonsRepo: SeasonRepository;
  let verificationTokensRepo: VerificationTokenRepository;
  let uow: UnitOfWork | undefined; // transactional wrapper for credit/debit (Prisma only)
  let dbPing: (() => Promise<boolean>) | undefined; // DB readiness probe (Prisma only)

  if (config.databaseUrl && !opts.userRepository) {
    const { getPrisma } = await import('./db/prismaClient.ts');
    const { createPrismaStores } = await import('./db/prismaRepositories.ts');
    const prisma = getPrisma(config.databaseUrl);
    // Boot-time provenance log (audit 2026-06-08, finding C2): print WHICH database
    // host + env the live process is actually using — WITHOUT secrets — so a misconfig
    // (e.g. still pointing at an external DB, or NODE_ENV=development in prod) is
    // visible in `docker compose logs server` without exec'ing into the container.
    const dbHost = (() => { try { return new URL(config.databaseUrl!).host; } catch { return 'unparseable'; } })();
    // eslint-disable-next-line no-console
    console.log(`[db] store=postgres host=${dbHost} env=${config.isProd ? 'production' : 'development'}`);
    dbPing = async () => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    };
    const stores = createPrismaStores(prisma);
    repo = stores.users;
    ledger = stores.ledger;
    matchesRepo = stores.matches;
    withdrawalsRepo = stores.withdrawals;
    intentsRepo = stores.intents;
    friendsRepo = stores.friends;
    refreshTokensRepo = stores.refreshTokens;
    adminAuditRepo = stores.adminAudit;
    gamesRepo = stores.games;
    matchLogRepo = stores.matchActions;
    supportRepo = stores.support;
    suspicionRepo = stores.suspicion;
    pushSubsRepo = stores.pushSubscriptions;
    chatRepo = stores.chat;
    clubsRepo = stores.clubs;
    tournamentsRepo = stores.tournaments;
    seasonsRepo = stores.seasons;
    verificationTokensRepo = stores.verificationTokens;
    uow = stores.uow; // Postgres: credit/debit run in one $transaction
  } else {
    // Production with no DATABASE_URL would silently keep ALL balances in RAM and
    // lose them on restart — catastrophic for real money. Fail closed, exactly like
    // the secret/compliance gates. The staging/demo escape (ALLOW_STUB_PROVIDERS) and
    // tests (which inject opts.userRepository) may still use the in-memory store.
    if (config.isProd && !opts.userRepository && !config.allowStubProviders) {
      throw new Error('DATABASE_URL is required in production (the in-memory store loses all balances on restart). Set DATABASE_URL, or for a staging/demo deploy WITHOUT real money set ALLOW_STUB_PROVIDERS=staging-no-real-money.');
    }
    if (config.isProd && !opts.userRepository) {
      // eslint-disable-next-line no-console
      console.warn('⚠️  [db] store=IN-MEMORY (ALLOW_STUB_PROVIDERS) — DATA WILL NOT PERSIST across restarts. NEVER use for real money.');
    }
    repo = opts.userRepository ?? new InMemoryUserRepository();
    ledger = new InMemoryLedger();
    matchesRepo = new InMemoryMatchesRepository();
    withdrawalsRepo = new InMemoryWithdrawals();
    intentsRepo = new InMemoryDepositIntents();
    friendsRepo = new InMemoryFriends();
    refreshTokensRepo = new InMemoryRefreshTokens();
    adminAuditRepo = new InMemoryAdminAudit();
    gamesRepo = new InMemoryGames();
    matchLogRepo = new InMemoryMatchActions();
    supportRepo = new InMemorySupportRepository();
    suspicionRepo = new InMemorySuspicion();
    pushSubsRepo = new InMemoryPushSubscriptions();
    chatRepo = new InMemoryChatRepository();
    clubsRepo = new InMemoryClubRepository();
    tournamentsRepo = new InMemoryTournamentRepository();
    seasonsRepo = new InMemorySeasonRepository();
    verificationTokensRepo = new InMemoryVerificationTokens();
  }

  // Provider stubs (mock payment, console email) must NEVER ship to production
  // silently: a stub can't move real money or deliver verification/reset links.
  // Fail CLOSED — a prod boot still on a stub throws. Wire a real provider here
  // (env-selected) before going live. ALLOW_STUB_PROVIDERS=staging-no-real-money is a
  // DELIBERATE staging/demo escape: it permits the stubs in prod (keeping every other prod
  // protection) so the app can be deployed WITHOUT payment/email integration —
  // NEVER set it for a real-money instance.
  // Real email (Resend) when configured, else the console stub.
  const email: EmailProvider = config.resendApiKey
    ? new ResendEmailProvider(config.resendApiKey, config.emailFrom)
    : new ConsoleEmailProvider();
  // Ops alerts (Telegram) when configured, else a no-op. Used for withdrawal pings.
  const notifier: Notifier = createNotifier(config);
  // AUTO crypto payout for small KYC-verified withdrawals — ON only when the Binance
  // withdraw API creds AND a positive cap are set; else NullPayoutProvider (manual).
  // This moves REAL money — keep the cap small. Larger withdrawals stay manual.
  let payout: PayoutProvider = new NullPayoutProvider();
  if (config.autoWithdrawMaxCents > 0 && config.binanceApiKey && config.binanceApiSecret) {
    payout = new BinancePayoutProvider({ apiKey: config.binanceApiKey, apiSecret: config.binanceApiSecret, currency: config.autoWithdrawCurrency });
  }
  // Fee-free USDT-TRC20 deposits via on-chain TxID verify. PREFERRED: a watch-only
  // HD wallet (TRON_DEPOSIT_XPUB) gives every player a UNIQUE deposit address, so a
  // deposit is attributed by which address received it (theft-proof, no claim-jack)
  // and the server holds NO private keys. Legacy fallback: a single shared address.
  const depositWallet = config.tronDepositXpub ? new TronHdWallet(config.tronDepositXpub) : undefined;
  const tronDeposit = depositWallet || config.tronDepositAddress
    ? new TronDepositVerifier({ depositAddress: config.tronDepositAddress ?? undefined, apiKey: config.tronGridApiKey })
    : undefined;
  if (depositWallet) {
    // eslint-disable-next-line no-console
    console.warn('[deposit] UNIQUE per-player USDT-TRC20 deposit addresses ENABLED (watch-only xpub; no private keys on the server).');
  } else if (config.tronDepositAddress) {
    // eslint-disable-next-line no-console
    console.warn('⚠️  [deposit] Using a SINGLE shared TRON deposit address (TRON_DEPOSIT_ADDRESS). This is claim-jackable — set TRON_DEPOSIT_XPUB for unique per-player addresses.');
  }
  // Unclaimed-deposit watcher: when deposits land in a Binance account AND we can
  // alert (Telegram), poll deposit history and ping the owner about USDT-TRC20
  // deposits that arrived but were never claimed via the TxID flow (player forgot).
  const depositWatcher = config.binanceApiKey && config.binanceApiSecret && config.tronDepositAddress && notifier.name !== 'null'
    ? { lister: new BinanceDepositLister({ apiKey: config.binanceApiKey, apiSecret: config.binanceApiSecret }), alerted: new Set<string>() }
    : null;
  // Treasury check: compare Binance free USDT to total player liabilities so we get
  // alerted before we can't cover withdrawals. Available when Binance keys are set.
  const binanceAccount = config.binanceApiKey && config.binanceApiSecret
    ? new BinanceAccountReader({ apiKey: config.binanceApiKey, apiSecret: config.binanceApiSecret })
    : null;
  // Withdrawal-status reconciliation: Binance accepts a payout synchronously but the
  // on-chain send can fail later (no webhook) → poll history + refund the player.
  const binanceWithdrawReader = config.binanceApiKey && config.binanceApiSecret
    ? new BinanceWithdrawReader({ apiKey: config.binanceApiKey, apiSecret: config.binanceApiSecret })
    : null;
  if (payout.name !== 'null') {
    // eslint-disable-next-line no-console
    console.warn(`[payout] AUTO crypto payout ENABLED via ${payout.name} (${config.autoWithdrawCurrency}, ≤ ${config.autoWithdrawMaxCents}¢). REAL money is sent automatically for small KYC-verified withdrawals.`);
  }
  // Deposit hosted-checkout/webhook flow. The PRIMARY deposit rail is now the
  // fee-free USDT-TRC20 TxID flow (`tronDeposit` above); this PaymentProvider is the
  // dev/test stub behind /api/payments/webhook/:provider (kept for local dev + tests).
  const provider: PaymentProvider = new MockPaymentProvider(config.paymentWebhookSecret);
  // A real deposit rail in production = on-chain USDT-TRC20 (per-player xpub addresses
  // or a configured address). Without it, the only deposit path is the mock stub →
  // block boot unless explicitly staging.
  const hasRealDepositRail = tronDeposit != null;
  if (config.isProd && !config.allowStubProviders) {
    if (!hasRealDepositRail) throw new Error('A real deposit rail must be configured in production: set TRON_DEPOSIT_XPUB for UNIQUE per-player USDT-TRC20 deposit addresses (recommended — theft-proof; generate it offline with tools/tron-xpub.mjs), or TRON_DEPOSIT_ADDRESS for the legacy single shared address. For a staging/demo deploy WITHOUT real money, set ALLOW_STUB_PROVIDERS=staging-no-real-money.');
    if (email.name === 'console') throw new Error('A real EmailProvider must be configured in production (ConsoleEmailProvider is a stub — wire SMTP/SES/Postmark). For a staging/demo deploy WITHOUT real money, set ALLOW_STUB_PROVIDERS=staging-no-real-money.');
  }
  if (config.isProd && config.allowStubProviders && (!hasRealDepositRail || email.name === 'console')) {
    // eslint-disable-next-line no-console
    console.warn('⚠️  ALLOW_STUB_PROVIDERS=staging-no-real-money: running in production with STUB deposit/email (mock deposits, emails printed to logs). This is a STAGING/DEMO mode — NOT safe for real money. Configure a real deposit rail + EmailProvider, then unset this flag before accepting deposits.');
  }

  // Email verification + password reset go through the EmailProvider above.
  const auth = new AuthService(repo, tokens, refreshTokensRepo, {
    verificationTokens: verificationTokensRepo,
    appUrl: config.clientOrigin,
    email,
  });

  // Admin bootstrap: promote the configured ADMIN_EMAIL to admin on boot (if that
  // account exists). Idempotent — a no-op once they're already admin. Lets the
  // owner reach the admin panel without manual DB surgery.
  if (config.adminEmail) {
    void repo.findByEmail(config.adminEmail).then(async (u) => {
      if (u && u.role !== 'admin') {
        await repo.setRole(u.id, 'admin');
        // eslint-disable-next-line no-console
        console.log(`[admin] promoted ${config.adminEmail} to admin`);
      }
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[admin] bootstrap promote failed:', e);
    });
  }

  const rooms = new RoomManager({ startTarget: 21 });
  const presence = new Presence();
  const profiles = new ProfileService(repo);
  const ranked = new RankedService(seasonsRepo, repo);
  const matchmaking = new MatchmakingService();
  const friends = new FriendsService(repo, friendsRepo, presence);

  const wallet = new WalletService(repo, ledger, uow);
  const rewards = new RewardsService(repo, config.rewardsEnabled, wallet);
  const money = new MoneyService(wallet, matchesRepo, uow);
  // Pass the UoW (Prisma only) so a withdrawal's debit + record-insert are one atomic
  // transaction (no phantom debit on a crash). In-memory: uow is undefined → safe
  // sequential path (single-threaded).
  const withdrawals = new WithdrawalService(wallet, withdrawalsRepo, undefined, uow);
  const intents = intentsRepo;
  const compliance = new ComplianceService(config.compliance);
  const responsibleGaming = new ResponsibleGamingService(repo, wallet);
  const antiCheat = new AntiCheatService(matchLogRepo, repo, suspicionRepo);
  // Web Push re-engagement. ConsolePushProvider LOGS nudges until VAPID keys are
  // configured for real browser delivery (see push/pushProvider.ts).
  const push = new PushService(pushSubsRepo, new ConsolePushProvider());
  const vip = new VipService(wallet);
  const clubs = new ClubService(clubsRepo, repo);
  // Tournaments: buy-in escrow + prize payout reuse the proven wallet money paths.
  // Credits carry the reason as a unique providerRef → idempotent (no double-pay).
  const tournamentWallet: TournamentWallet = {
    // `ctx` (when the service opened an outer tx) → escrow on the SAME tx as the row write.
    async debit(userId, cents, reason, ctx) { await (ctx ? wallet.bind(ctx) : wallet).debit(userId, cents, { type: 'bet', reason }); },
    async credit(userId, cents, reason) { await wallet.credit(userId, cents, { type: 'payout', reason, providerRef: reason }); },
    async recordRake(cents, ref) { await wallet.recordRake(cents, { providerRef: ref }); },
    // Champion prize + house rake in ONE transaction (Prisma) so a crash can't split
    // them; in-memory falls back to sequential (single-threaded → already safe).
    async payoutChampion(winnerId, prizeCents, rakeCents, ref, ctx) {
      const pay = async (w: typeof wallet) => {
        if (prizeCents > 0) await w.credit(winnerId, prizeCents, { type: 'payout', reason: `tournament prize:${ref}`, providerRef: `tournament prize:${ref}` });
        if (rakeCents > 0) await w.recordRake(rakeCents, { providerRef: `tournament-rake:${ref}` });
      };
      if (ctx) await pay(wallet.bind(ctx));                                   // compose into the service's tx
      else if (uow) await uow.transaction(async (c) => { await pay(wallet.bind(c)); });
      else await pay(wallet);
    },
  };
  // Pass the uow so register/finish can make escrow+payout atomic with the row write (SCH-3).
  // dualControl: four-eyes on the champion payout (off by default — solo operation).
  const tournaments = new TournamentService(tournamentsRepo, tournamentWallet, config.rakeBps, undefined, undefined, uow, config.tournamentDualControl);
  // Club chat + moderation. Membership-gated + mute-aware + abuse reports.
  // Foundation ships ON; review moderation POLICY before broad public promotion.
  const chat = new ChatService(chatRepo, clubs);

  // Drain flag for graceful shutdown: when active, /ready returns 503 (the LB
  // stops routing) and the gateway rejects new matches/queue joins so in-flight
  // matches can finish before the process exits.
  const drainState = { active: false };
  const isDraining = () => drainState.active;

  // Late-bind the admin match-void to the gateway (created below, after the HTTP
  // app). The admin route calls this holder; until the gateway exists it reports
  // 'unavailable'. Lets the HTTP layer trigger a gateway-owned refund + room-end.
  const voidHolder: { fn?: (roomId: string, meta: { adminId: string; reason: string }) => Promise<AdminVoidResult> } = {};
  const voidMatch = (roomId: string, meta: { adminId: string; reason: string }) =>
    voidHolder.fn ? voidHolder.fn(roomId, meta) : Promise.resolve({ ok: false as const, reason: 'unavailable' as const });

  // Late-bind admin "kick user" to the gateway (created below): on ban/suspend the
  // admin route disconnects the user's live sockets. No-op until the gateway exists.
  const kickHolder: { fn?: (userId: string) => void } = {};
  const kickUser = (userId: string) => kickHolder.fn?.(userId);

  const app = await buildHttpApp({ auth, config, wallet, withdrawals, provider, intents, compliance, rg: responsibleGaming, vip, clubs, tournaments, chat, rooms, notifier, payout, tronDeposit, depositWallet, binanceFreeUsdtCents: binanceAccount ? () => binanceAccount.freeUsdtCents() : undefined, matches: matchesRepo, voidMatch, kickUser, profiles, ranked, friends, rewards, adminAudit: adminAuditRepo, games: gamesRepo, matchLog: matchLogRepo, support: supportRepo, antiCheat, push, dbPing, isDraining });
  await app.ready(); // ensures app.server exists before Socket.IO attaches

  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    app.server,
    {
      cors: { origin: config.clientOrigin, credentials: true },
      // Bound message size so a hostile client can't send a giant payload that
      // ties up the event loop before our per-handler validation even runs.
      maxHttpBufferSize: 16 * 1024,
      // Liveness + slow-client defenses: a heartbeat detects dead/idle sockets and
      // reclaims them (no zombie connection holds a seat), and connectTimeout caps a
      // slowloris-style handshake that never completes the Engine.IO upgrade.
      pingInterval: 25_000, // server → client ping cadence
      pingTimeout: 20_000,  // drop the socket if no pong within this window
      connectTimeout: 10_000, // abort a handshake that stalls before connecting
    },
  );

  let detachRedis: (() => Promise<void>) | null = null;
  if (config.redisUrl) {
    detachRedis = await attachRedisAdapter(io, config.redisUrl);
    // REDIS_URL implies multi-instance intent. The adapter shares broadcasts, but
    // timers/rate-limit/presence/matchmaking are still per-instance — so loudly
    // remind the operator that >1 replica REQUIRES sticky-by-room routing (else
    // live matches corrupt). See DEPLOYMENT.md §7.
    app.log.warn(
      'REDIS_URL set: Socket.IO broadcasts are shared, but timers/rate-limit/presence/matchmaking remain PER-INSTANCE. Run a SINGLE replica, or enforce sticky-by-room routing at the load balancer (DEPLOYMENT.md §7) — multiple replicas without it WILL corrupt live matches.',
    );
  }

  // The gateway registers all socket handlers on construction.
  const gateway = new GameGateway(io, rooms, auth, {
    turnMs: config.turnMs,
    countdownMs: config.countdownMs,
    money,
    rakeBps: config.rakeBps,
    abandonMs: config.abandonMs,
    compliance,
    rg: responsibleGaming,
    profiles,
    ranked,
    antiCheat,
    matchmaking,
    friends,
    presence,
    games: gamesRepo,
    matchLog: matchLogRepo,
    push,
    chat,
    isDraining,
    // Room-ownership registry. In-memory = single-instance no-op; swap for a
    // Redis-backed impl (DEPLOYMENT.md §7) to make horizontal scaling safe.
    ownership: new InMemoryRoomOwnership(),
  });
  // Now the gateway exists, point the admin match-void + kick-user routes at it.
  voidHolder.fn = (roomId, meta) => gateway.adminVoidMatch(roomId, meta);
  kickHolder.fn = (userId) => gateway.disconnectUser(userId);

  // Crash recovery: refund any match a previous (crashed) process left 'active'
  // with stakes still escrowed. At boot no room is live yet, so every active row
  // is orphaned. refund() is idempotent, so this is always safe.
  const recovered = await money.recoverOrphanedMatches(new Set()).catch((err) => {
    app.log.error({ err }, 'boot crash-recovery sweep failed');
    return [] as string[];
  });
  if (recovered.length) {
    app.log.warn({ matchIds: recovered }, 'refunded orphaned matches at boot');
    orphanedMatchesRefunded.inc(recovered.length);
  }

  // Periodic safety net: refund matches no live room owns + verify the money
  // conservation invariant, paging the operator on any drift.
  const RECONCILE_MS = 5 * 60 * 1000;
  // Abandoned tournaments (admin-advanced, no realtime auto-run) get refunded +
  // voided once this old, so escrowed buy-ins can't be stranded forever (C4).
  const TOURNAMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  // Payment-ops alerting state (in-memory): manual withdrawals unapproved past this,
  // and a throttle so the under-funding alert pings at most hourly.
  const STALE_WITHDRAWAL_MS = 2 * 60 * 60 * 1000;
  const TREASURY_ALERT_THROTTLE_MS = 60 * 60 * 1000;
  const alertedStaleWithdrawals = new Set<string>();
  let lastTreasuryAlert = 0;
  const sweepTimer = setInterval(() => {
    void (async () => {
      try {
        const refunded = await money.recoverOrphanedMatches(rooms.activeMatchIds());
        if (refunded.length) {
          app.log.warn({ matchIds: refunded }, 'refunded orphaned matches (periodic sweep)');
          orphanedMatchesRefunded.inc(refunded.length);
        }
        const voidedTournaments = await tournaments.sweepStale(TOURNAMENT_MAX_AGE_MS);
        if (voidedTournaments.length) {
          app.log.warn({ tournamentIds: voidedTournaments }, 'voided + refunded abandoned tournaments (periodic sweep)');
        }
        const rec = await wallet.reconcile();
        if (!rec.ok) {
          app.log.error({ mismatches: rec.mismatches }, 'BALANCE RECONCILE MISMATCH — investigate');
          reconcileMismatches.inc();
        }
        // Retention: purge expired auth/verification tokens so the tables don't
        // grow unbounded (and stale data doesn't linger past its usefulness).
        const now = Date.now();
        const purged = (await refreshTokensRepo.deleteExpired(now)) + (await verificationTokensRepo.deleteExpired(now));
        if (purged > 0) app.log.info({ purged }, 'purged expired tokens');
        // Safety net: ping the operator about Binance deposits that arrived but were
        // never claimed via the TxID flow (so a forgotten deposit isn't lost).
        if (depositWatcher) {
          const alerts = await checkUnclaimedDeposits({
            list: (since) => depositWatcher.lister.listRecent(since),
            isClaimed: async (txId) => (await ledger.findByProviderRef(`tron:${txId}`)) != null,
            notify: (text) => notifier.notify(text),
            alerted: depositWatcher.alerted,
            now,
          }).catch((err) => { app.log.warn({ err }, 'deposit watcher failed'); return 0; });
          if (alerts) app.log.warn({ unclaimedDeposits: alerts }, 'alerted operator about unclaimed Binance deposits');
        }
        // Stale manual withdrawals: ping the operator about ones unapproved too long.
        if (notifier.name !== 'null') {
          const pending = await withdrawals.listPending().catch(() => []);
          for (const wd of findStaleWithdrawals(pending, now, STALE_WITHDRAWAL_MS, alertedStaleWithdrawals)) {
            alertedStaleWithdrawals.add(wd.id);
            const wu = await auth.getUser(wd.userId).catch(() => null);
            await notifier.notify(
              `⌛ <b>Tërheqje në pritje > ${Math.round(STALE_WITHDRAWAL_MS / 3_600_000)}h</b>\n` +
              `Lojtari: ${wu?.username ?? wd.userId}\nShuma: $${(wd.amountCents / 100).toFixed(2)}\n→ Aprovo ose refuzo te admin paneli.`,
            ).catch(() => {});
          }
          pruneAlerted(alertedStaleWithdrawals, pending.map((p) => p.id));
        }
        // Treasury: is Binance funded enough to cover what we owe players?
        if (binanceAccount) {
          const binCents = await binanceAccount.freeUsdtCents();
          if (binCents != null) {
            const liabilities = (await auth.listUsers()).filter((u) => u.role === 'user').reduce((s, u) => s + u.balanceCents, 0);
            const buffer = treasuryBufferCents(binCents, liabilities);
            treasuryBufferGauge.set(buffer);
            if (buffer < 0 && notifier.name !== 'null' && now - lastTreasuryAlert > TREASURY_ALERT_THROTTLE_MS) {
              lastTreasuryAlert = now;
              await notifier.notify(
                `🚨 <b>Binance NËN-FINANCUAR</b>\n` +
                `Balanca Binance: $${(binCents / 100).toFixed(2)}\nDetyrime ndaj lojtarëve: $${(liabilities / 100).toFixed(2)}\n` +
                `Mungesë: <b>$${(Math.abs(buffer) / 100).toFixed(2)}</b>\n→ Shto USDT te Binance Spot që të mbulosh tërheqjet.`,
              ).catch(() => {});
            }
          }
        }
        // Reverse auto-payouts that Binance accepted but later FAILED on-chain (no
        // webhook) — refund the player. Idempotent (providerRef + reversed set).
        if (binanceWithdrawReader && wallet) {
          const reversedN = await reconcileFailedWithdrawals({
            // 7-day lookback so an on-chain failure that manifests slowly is still caught.
            list: () => binanceWithdrawReader.listRecent(now - 7 * 24 * 60 * 60 * 1000),
            findWithdrawal: async (id) => {
              const w = await withdrawals.find(id);
              if (!w) return null;
              const u = await auth.getUser(w.userId).catch(() => null);
              return { userId: w.userId, username: u?.username, amountCents: w.amountCents, status: w.status };
            },
            reverse: ({ id, userId, amountCents }) =>
              wallet.credit(userId, amountCents, { type: 'admin_adjust', reason: 'rikthim: tërheqja dështoi në Binance', providerRef: `withdrawal_reversal:${id}` }).then(() => {}),
            markReversed: (id) => withdrawals.markReversed(id),
            notify: (text) => notifier.notify(text),
          }).catch((err) => { app.log.warn({ err }, 'withdrawal reconciliation failed'); return 0; });
          if (reversedN) app.log.warn({ reversedWithdrawals: reversedN }, 'reversed failed Binance withdrawals — players refunded');
        }
      } catch (err) {
        app.log.error({ err }, 'periodic money sweep failed');
      }
    })();
  }, RECONCILE_MS);
  sweepTimer.unref?.(); // never keep the process alive just for the sweep

  // Live state gauges, refreshed often (cheap: a Set size + a pending-withdrawals
  // count) so dashboards/alerts see concurrency + the money-ops queue in near-real-time.
  const GAUGE_MS = 15 * 1000;
  const gaugeTimer = setInterval(() => {
    void (async () => {
      try {
        activeMatches.set(rooms.activeMatchIds().size);
        pendingWithdrawals.set((await withdrawals.listPending()).length);
      } catch { /* metrics must never break the app */ }
    })();
  }, GAUGE_MS);
  gaugeTimer.unref?.();

  const closeAll = async () => {
    clearInterval(sweepTimer);
    clearInterval(gaugeTimer);
    io.close();
    if (detachRedis) await detachRedis();
    await app.close();
  };

  return {
    app,
    io,
    rooms,
    auth,
    config,
    async listen() {
      await app.listen({ port: config.port, host: config.host });
    },
    setDraining(active: boolean) {
      drainState.active = active;
    },
    /**
     * Graceful shutdown: flip /ready to 503 + reject new matches, wait a grace
     * window for in-flight matches to finish + settle, then refund any match still
     * escrowed (so a restart never strands a pot) and close. Returns the count
     * refunded. Call this from SIGTERM/SIGINT instead of close() for zero-loss deploys.
     */
    async drain(graceMs = 10_000) {
      drainState.active = true;
      app.log.warn('draining: /ready now 503, rejecting new matches');
      await new Promise((r) => setTimeout(r, graceMs));
      // Log loudly if the drain refund fails — silently swallowing it could strand
      // escrowed stakes with no signal (boot recovery would still retry next start).
      const refunded = await money.recoverOrphanedMatches(new Set()).catch((err) => {
        app.log.error({ err }, 'drain crash-recovery refund FAILED — in-flight stakes may be stranded until next boot');
        return [] as string[];
      });
      if (refunded.length) {
        app.log.warn({ matchIds: refunded }, 'refunded in-flight matches on drain');
        orphanedMatchesRefunded.inc(refunded.length);
      }
      await closeAll();
      return refunded.length;
    },
    close: closeAll,
  };
}
