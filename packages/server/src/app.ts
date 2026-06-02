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
import { InMemoryVerificationTokens, type VerificationTokenRepository } from './auth/verificationTokens.ts';
import { fairRoutes } from './http/fairRoutes.ts';
import { authRoutes } from './http/authRoutes.ts';
import { walletRoutes } from './http/walletRoutes.ts';
import { adminRoutes } from './http/adminRoutes.ts';
import { accountRoutes } from './http/accountRoutes.ts';
import { ComplianceService } from './compliance/complianceService.ts';
import { RoomManager } from './room/roomManager.ts';
import { GameGateway } from './realtime/gateway.ts';
import { attachRedisAdapter } from './realtime/redisAdapter.ts';
import { InMemoryLedger, type LedgerRepository } from './money/ledger.ts';
import { WalletService } from './money/walletService.ts';
import { InMemoryMatchesRepository, type MatchesRepository } from './money/matchesRepository.ts';
import { MoneyService } from './money/moneyService.ts';
import { MockPaymentProvider, type PaymentProvider } from './money/paymentProvider.ts';
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

export interface HttpDeps {
  auth: AuthService;
  config: AppConfig;
  wallet?: WalletService;
  withdrawals?: WithdrawalService;
  provider?: PaymentProvider;
  intents?: DepositIntentRepository;
  compliance?: ComplianceService;
  rooms?: RoomManager;
  profiles?: ProfileService;
  friends?: FriendsService;
  rewards?: RewardsService;
  adminAudit?: AdminAuditRepository;
  games?: GamesRepository;
}

export async function buildHttpApp(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.config.isProd });

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

  app.get('/health', async () => ({ ok: true, service: 'murlan-server' }));

  await authRoutes(app, {
    auth: deps.auth,
    isProd: deps.config.isProd,
    authRateLimit: { max: 20, timeWindow: '1 minute' },
  });
  await accountRoutes(app, { auth: deps.auth });

  if (deps.profiles && deps.friends) {
    await socialRoutes(app, { auth: deps.auth, profiles: deps.profiles, friends: deps.friends });
  }
  if (deps.rewards) {
    await rewardsRoutes(app, { auth: deps.auth, rewards: deps.rewards });
  }
  if (deps.games) {
    await fairRoutes(app, { games: deps.games });
  }

  if (deps.wallet && deps.withdrawals && deps.provider && deps.intents) {
    await walletRoutes(app, {
      auth: deps.auth, wallet: deps.wallet, withdrawals: deps.withdrawals,
      provider: deps.provider, intents: deps.intents, compliance: deps.compliance,
    });
    await adminRoutes(app, { auth: deps.auth, wallet: deps.wallet, withdrawals: deps.withdrawals, rooms: deps.rooms, audit: deps.adminAudit });
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
  let verificationTokensRepo: VerificationTokenRepository;
  let uow: UnitOfWork | undefined; // transactional wrapper for credit/debit (Prisma only)

  if (config.databaseUrl && !opts.userRepository) {
    const { getPrisma } = await import('./db/prismaClient.ts');
    const { createPrismaStores } = await import('./db/prismaRepositories.ts');
    const stores = createPrismaStores(getPrisma(config.databaseUrl));
    repo = stores.users;
    ledger = stores.ledger;
    matchesRepo = stores.matches;
    withdrawalsRepo = stores.withdrawals;
    intentsRepo = stores.intents;
    friendsRepo = stores.friends;
    refreshTokensRepo = stores.refreshTokens;
    adminAuditRepo = stores.adminAudit;
    gamesRepo = stores.games;
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
    verificationTokensRepo = new InMemoryVerificationTokens();
  }

  // Email verification + password reset use the console email provider until real
  // SMTP/API credentials are configured (links are logged in dev).
  const auth = new AuthService(repo, tokens, refreshTokensRepo, {
    verificationTokens: verificationTokensRepo,
    appUrl: config.clientOrigin,
  });
  const rooms = new RoomManager({ startTarget: 21 });
  const presence = new Presence();
  const profiles = new ProfileService(repo);
  const friends = new FriendsService(repo, friendsRepo, presence);
  const rewards = new RewardsService(repo, config.rewardsEnabled);

  const wallet = new WalletService(repo, ledger, uow);
  const money = new MoneyService(wallet, matchesRepo, uow);
  const provider = new MockPaymentProvider(config.paymentWebhookSecret);
  const withdrawals = new WithdrawalService(wallet, withdrawalsRepo);
  const intents = intentsRepo;
  const compliance = new ComplianceService(config.compliance);

  const app = await buildHttpApp({ auth, config, wallet, withdrawals, provider, intents, compliance, rooms, profiles, friends, rewards, adminAudit: adminAuditRepo, games: gamesRepo });
  await app.ready(); // ensures app.server exists before Socket.IO attaches

  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    app.server,
    {
      cors: { origin: config.clientOrigin, credentials: true },
      // Bound message size so a hostile client can't send a giant payload that
      // ties up the event loop before our per-handler validation even runs.
      maxHttpBufferSize: 16 * 1024,
    },
  );

  let detachRedis: (() => Promise<void>) | null = null;
  if (config.redisUrl) detachRedis = await attachRedisAdapter(io, config.redisUrl);

  // The gateway registers all socket handlers on construction.
  new GameGateway(io, rooms, auth, {
    turnMs: config.turnMs,
    countdownMs: config.countdownMs,
    money,
    rakeBps: config.rakeBps,
    abandonMs: config.abandonMs,
    compliance,
    profiles,
    friends,
    presence,
    games: gamesRepo,
  });

  // Crash recovery: refund any match a previous (crashed) process left 'active'
  // with stakes still escrowed. At boot no room is live yet, so every active row
  // is orphaned. refund() is idempotent, so this is always safe.
  const recovered = await money.recoverOrphanedMatches(new Set()).catch((err) => {
    app.log.error({ err }, 'boot crash-recovery sweep failed');
    return [] as string[];
  });
  if (recovered.length) app.log.warn({ matchIds: recovered }, 'refunded orphaned matches at boot');

  // Periodic safety net: refund matches no live room owns + verify the money
  // conservation invariant, paging the operator on any drift.
  const RECONCILE_MS = 5 * 60 * 1000;
  const sweepTimer = setInterval(() => {
    void (async () => {
      try {
        const refunded = await money.recoverOrphanedMatches(rooms.activeMatchIds());
        if (refunded.length) app.log.warn({ matchIds: refunded }, 'refunded orphaned matches (periodic sweep)');
        const rec = await wallet.reconcile();
        if (!rec.ok) app.log.error({ mismatches: rec.mismatches }, 'BALANCE RECONCILE MISMATCH — investigate');
      } catch (err) {
        app.log.error({ err }, 'periodic money sweep failed');
      }
    })();
  }, RECONCILE_MS);
  sweepTimer.unref?.(); // never keep the process alive just for the sweep

  return {
    app,
    io,
    rooms,
    auth,
    config,
    async listen() {
      await app.listen({ port: config.port, host: config.host });
    },
    async close() {
      clearInterval(sweepTimer);
      io.close();
      if (detachRedis) await detachRedis();
      await app.close();
    },
  };
}
