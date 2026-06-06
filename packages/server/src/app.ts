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
import { registry, httpRequestDuration, reconcileMismatches, orphanedMatchesRefunded, activeMatches, pendingWithdrawals } from './metrics.ts';
import { authRoutes, requireAdmin } from './http/authRoutes.ts';
import { walletRoutes } from './http/walletRoutes.ts';
import { adminRoutes } from './http/adminRoutes.ts';
import { accountRoutes } from './http/accountRoutes.ts';
import { ComplianceService } from './compliance/complianceService.ts';
import { ResponsibleGamingService } from './compliance/responsibleGaming.ts';
import { RoomManager } from './room/roomManager.ts';
import { GameGateway } from './realtime/gateway.ts';
import { attachRedisAdapter } from './realtime/redisAdapter.ts';
import { InMemoryRoomOwnership } from './realtime/roomOwnership.ts';
import { InMemoryLedger, type LedgerRepository } from './money/ledger.ts';
import { WalletService } from './money/walletService.ts';
import { InMemoryMatchesRepository, type MatchesRepository } from './money/matchesRepository.ts';
import { MoneyService } from './money/moneyService.ts';
import { MockPaymentProvider, type PaymentProvider } from './money/paymentProvider.ts';
import { ConsoleEmailProvider } from './email/emailProvider.ts';
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
  chat?: ChatService;
  rooms?: RoomManager;
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
    // Behind a reverse proxy (see deploy/nginx.conf): honor X-Forwarded-For so
    // req.ip is the real client — used by IP-keyed rate-limiting and the optional
    // payment-webhook IP allowlist. The proxy MUST set XFF authoritatively (e.g.
    // `proxy_set_header X-Forwarded-For $remote_addr;`) so it can't be spoofed.
    trustProxy: true,
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

  // Observability: time every request into a Prometheus histogram (keyed by the
  // ROUTE PATTERN, not the raw path, to avoid label cardinality blow-up).
  app.addHook('onResponse', (req, reply, done) => {
    const route = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? req.url;
    httpRequestDuration.observe({ method: req.method, route, status: reply.statusCode }, reply.elapsedTime / 1000);
    done();
  });
  app.get('/metrics', async (_req, reply) => {
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
    authRateLimit: { max: 20, timeWindow: '1 minute' },
  });
  await accountRoutes(app, { auth: deps.auth, audit: deps.adminAudit, rg: deps.rg, push: deps.push });

  if (deps.profiles && deps.friends) {
    await socialRoutes(app, { auth: deps.auth, profiles: deps.profiles, friends: deps.friends });
  }
  if (deps.rewards) {
    await rewardsRoutes(app, { auth: deps.auth, rewards: deps.rewards });
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
      webhookIps: deps.config.paymentWebhookIps,
    });
    await adminRoutes(app, { auth: deps.auth, wallet: deps.wallet, withdrawals: deps.withdrawals, rooms: deps.rooms, audit: deps.adminAudit, chat: deps.chat });
  }

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
  let seasonsRepo: SeasonRepository;
  let verificationTokensRepo: VerificationTokenRepository;
  let uow: UnitOfWork | undefined; // transactional wrapper for credit/debit (Prisma only)
  let dbPing: (() => Promise<boolean>) | undefined; // DB readiness probe (Prisma only)

  if (config.databaseUrl && !opts.userRepository) {
    const { getPrisma } = await import('./db/prismaClient.ts');
    const { createPrismaStores } = await import('./db/prismaRepositories.ts');
    const prisma = getPrisma(config.databaseUrl);
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
    seasonsRepo = stores.seasons;
    verificationTokensRepo = stores.verificationTokens;
    uow = stores.uow; // Postgres: credit/debit run in one $transaction
  } else {
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
    seasonsRepo = new InMemorySeasonRepository();
    verificationTokensRepo = new InMemoryVerificationTokens();
  }

  // Provider stubs (mock payment, console email) must NEVER ship to production
  // silently: a stub can't move real money or deliver verification/reset links.
  // Fail CLOSED — a prod boot still on a stub throws. Wire a real provider here
  // (env-selected) before going live. ALLOW_STUB_PROVIDERS=true is a DELIBERATE
  // staging/demo escape: it permits the stubs in prod (keeping every other prod
  // protection) so the app can be deployed WITHOUT payment/email integration —
  // NEVER set it for a real-money instance.
  const email = new ConsoleEmailProvider();
  const provider = new MockPaymentProvider(config.paymentWebhookSecret);
  if (config.isProd && !config.allowStubProviders) {
    if (provider.name === 'mock') throw new Error('A real PaymentProvider must be configured in production (MockPaymentProvider is a stub — wire Stripe/PayPal/crypto). For a staging/demo deploy WITHOUT real money, set ALLOW_STUB_PROVIDERS=true.');
    if (email.name === 'console') throw new Error('A real EmailProvider must be configured in production (ConsoleEmailProvider is a stub — wire SMTP/SES/Postmark). For a staging/demo deploy WITHOUT real money, set ALLOW_STUB_PROVIDERS=true.');
  }
  if (config.isProd && config.allowStubProviders && (provider.name === 'mock' || email.name === 'console')) {
    // eslint-disable-next-line no-console
    console.warn('⚠️  ALLOW_STUB_PROVIDERS=true: running in production with STUB payment/email (mock deposits, emails printed to logs). This is a STAGING/DEMO mode — NOT safe for real money. Wire real providers + unset this flag before accepting deposits.');
  }

  // Email verification + password reset go through the EmailProvider above.
  const auth = new AuthService(repo, tokens, refreshTokensRepo, {
    verificationTokens: verificationTokensRepo,
    appUrl: config.clientOrigin,
    email,
  });
  const rooms = new RoomManager({ startTarget: 21 });
  const presence = new Presence();
  const profiles = new ProfileService(repo);
  const ranked = new RankedService(seasonsRepo, repo);
  const matchmaking = new MatchmakingService();
  const friends = new FriendsService(repo, friendsRepo, presence);
  const rewards = new RewardsService(repo, config.rewardsEnabled);

  const wallet = new WalletService(repo, ledger, uow);
  const money = new MoneyService(wallet, matchesRepo, uow);
  const withdrawals = new WithdrawalService(wallet, withdrawalsRepo);
  const intents = intentsRepo;
  const compliance = new ComplianceService(config.compliance);
  const responsibleGaming = new ResponsibleGamingService(repo, wallet);
  const antiCheat = new AntiCheatService(matchLogRepo, repo, suspicionRepo);
  // Web Push re-engagement. ConsolePushProvider LOGS nudges until VAPID keys are
  // configured for real browser delivery (see push/pushProvider.ts).
  const push = new PushService(pushSubsRepo, new ConsolePushProvider());
  const vip = new VipService(wallet);
  const clubs = new ClubService(clubsRepo, repo);
  // Club chat + moderation. Membership-gated + mute-aware + abuse reports.
  // Foundation ships ON; review moderation POLICY before broad public promotion.
  const chat = new ChatService(chatRepo, clubs);

  // Drain flag for graceful shutdown: when active, /ready returns 503 (the LB
  // stops routing) and the gateway rejects new matches/queue joins so in-flight
  // matches can finish before the process exits.
  const drainState = { active: false };
  const isDraining = () => drainState.active;

  const app = await buildHttpApp({ auth, config, wallet, withdrawals, provider, intents, compliance, rg: responsibleGaming, vip, clubs, chat, rooms, profiles, ranked, friends, rewards, adminAudit: adminAuditRepo, games: gamesRepo, matchLog: matchLogRepo, support: supportRepo, antiCheat, push, dbPing, isDraining });
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
  new GameGateway(io, rooms, auth, {
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
  const sweepTimer = setInterval(() => {
    void (async () => {
      try {
        const refunded = await money.recoverOrphanedMatches(rooms.activeMatchIds());
        if (refunded.length) {
          app.log.warn({ matchIds: refunded }, 'refunded orphaned matches (periodic sweep)');
          orphanedMatchesRefunded.inc(refunded.length);
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
      const refunded = await money.recoverOrphanedMatches(new Set()).catch(() => [] as string[]);
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
