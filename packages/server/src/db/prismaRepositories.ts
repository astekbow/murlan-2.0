// ============================================================================
// MURLAN — Prisma/PostgreSQL repository adapters (spec §11)
// ----------------------------------------------------------------------------
// Implement the SAME repository interfaces the services use, so swapping in
// Postgres requires no change to AuthService/WalletService/MoneyService/etc.
// `balanceCents` adjustments are conditional single-statement updates (no
// overdraw race). WalletService.credit/debit perform two repo writes (ledger row +
// balance); these ARE wrapped in one prisma.$transaction via PrismaUnitOfWork —
// wired into the wallet in app.ts — so both commit or roll back together.
// ============================================================================

import type { PrismaClient } from '@prisma/client';
import { type User, type NewUser, type UserRepository, type ComplianceUpdate, type KycStatus, type RewardsPatch, type AccountStatePatch, type UserRole, DuplicateUserError } from '../auth/userRepository.ts';
import {
  type LedgerRepository, type Transaction, type NewTransaction, type TransactionType, type TransactionStatus,
  type LedgerPageOpts,
  DuplicateProviderRefError,
} from '../money/ledger.ts';
import type { MatchesRepository, MatchRecord, NewMatch, MatchStatus } from '../money/matchesRepository.ts';
import type { WithdrawalRepository, WithdrawalRecord, WithdrawalStatus, WithdrawalResolution } from '../money/withdrawals.ts';
import { WITHDRAWALS_PAGE_DEFAULT } from '../money/withdrawals.ts';
import type { DepositIntentRepository, DepositIntentRecord } from '../money/depositIntents.ts';
import type { UnitOfWork, WalletTxContext } from '../money/unitOfWork.ts';
import type { FriendsRepository, Friendship } from '../social/friendsRepository.ts';
import type { RefreshTokenRepository, RefreshTokenRecord, NewRefreshToken } from '../auth/refreshTokens.ts';
import type { AdminAuditRepository, AdminActionRecord, NewAdminAction, AdminActionType } from '../auth/adminAudit.ts';
import type { GamesRepository, GameRecord, NewGameRecord } from '../fair/gamesRepository.ts';
import type { VerificationTokenRepository, VerificationTokenRecord, NewVerificationToken, VerificationTokenType } from '../auth/verificationTokens.ts';
import type { SeasonRepository, Season, NewSeason, SeasonStatus, UserSeason } from '../ranked/seasonRepository.ts';
import type { MatchActionsRepository, MatchActionRecord, NewMatchAction, MatchActionType } from '../realtime/matchActions.ts';
import type { SupportRepository, SupportTicket, NewSupportTicket, SupportStatus, SupportCategory } from '../support/supportRepository.ts';
import type { SuspicionRepository, SuspicionFlag, NewSuspicionFlag } from '../antiCheat/suspicionRepository.ts';
import type { PushSubscriptionRepository, PushSubscriptionRecord } from '../push/pushRepository.ts';
import type { WebPushSubscription } from '../push/pushProvider.ts';
import type { ChatRepository, ChatMessageRecord, ChatReportRecord } from '../chat/chatRepository.ts';
import { type ClubRepository, type Club, type ClubMember, type ClubRole, type NewClub, DuplicateClubTagError, genClubCode } from '../social/clubRepository.ts';
import type { TournamentRepository, Tournament, BracketMatch } from '../tournament/tournamentService.ts';
import type { Card } from '@murlan/engine';
import type { MatchType } from '@murlan/shared';

const ms = (d: Date): number => d.getTime();
const msOrNull = (d: Date | null): number | null => (d ? d.getTime() : null);

function toUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.passwordHash,
    role: row.role as User['role'],
    permissions: row.permissions ?? [],
    balanceCents: row.balanceCents,
    createdAt: ms(row.createdAt),
    tokenVersion: row.tokenVersion ?? 0,
    emailVerified: row.emailVerified ?? false,
    accountState: (row.accountState ?? 'active') as User['accountState'],
    accountStateReason: row.accountStateReason ?? null,
    accountStateUntil: msOrNull(row.accountStateUntil ?? null),
    depositAddress: row.depositAddress ?? null,
    depositAddressIndex: row.depositAddressIndex ?? null,
    kycStatus: row.kycStatus as KycStatus,
    dateOfBirth: row.dateOfBirth,
    country: row.country,
    selfExcludedUntil: msOrNull(row.selfExcludedUntil),
    dailyDepositLimitCents: row.dailyDepositLimitCents ?? null,
    dailyLossLimitCents: row.dailyLossLimitCents ?? null,
    xp: row.xp ?? 0,
    gamesPlayed: row.gamesPlayed ?? 0,
    wins: row.wins ?? 0,
    biggestPotCents: row.biggestPotCents ?? 0,
    currentStreak: row.currentStreak ?? 0,
    avatar: row.avatar ?? null,
    lastDailyClaim: msOrNull(row.lastDailyClaim ?? null),
    dailyStreak: row.dailyStreak ?? 0,
    cosmetics: row.cosmetics ?? [],
    cardBack: row.cardBack ?? null,
    tableFelt: row.tableFelt ?? null,
    claimedChallenges: row.claimedChallenges ?? [],
  };
}

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(u: NewUser): Promise<User> {
    try {
      const row = await this.db.user.create({
        data: {
          username: u.username,
          usernameLower: u.username.toLowerCase(), // case-insensitive uniqueness key
          email: u.email.toLowerCase(),
          passwordHash: u.passwordHash,
          role: u.role ?? 'user',
        },
      });
      return toUser(row);
    } catch (e: any) {
      // Map a unique-constraint race to the typed error callers translate to 409.
      if (e?.code === 'P2002') {
        const target = String(e?.meta?.target ?? '');
        throw new DuplicateUserError(target.includes('email') ? 'email' : 'username');
      }
      throw e;
    }
  }
  async findById(id: string): Promise<User | null> {
    const row = await this.db.user.findUnique({ where: { id } });
    return row ? toUser(row) : null;
  }
  async findManyByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.user.findMany({ where: { id: { in: ids } } });
    return rows.map(toUser);
  }
  async findByEmail(email: string): Promise<User | null> {
    const row = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    return row ? toUser(row) : null;
  }
  async findByUsername(username: string): Promise<User | null> {
    const row = await this.db.user.findUnique({ where: { usernameLower: username.toLowerCase() } });
    return row ? toUser(row) : null;
  }

  /**
   * Atomic conditional balance change — rejects (null) if it would go negative.
   * The conditional updateMany IS the atomic guard; no wrapping $transaction, so
   * this composes inside an outer UnitOfWork transaction without nesting.
   */
  async adjustBalance(id: string, deltaCents: number): Promise<number | null> {
    const where = deltaCents < 0 ? { id, balanceCents: { gte: -deltaCents } } : { id };
    const res = await this.db.user.updateMany({ where, data: { balanceCents: { increment: deltaCents } } });
    if (res.count === 0) return null; // not found or insufficient funds
    const row = await this.db.user.findUnique({ where: { id } });
    return row ? row.balanceCents : null;
  }

  async assignDepositAddress(id: string, derive: (index: number) => string): Promise<{ address: string; index: number } | null> {
    // Idempotent: return the existing assignment if any.
    const existing = await this.db.user.findUnique({ where: { id }, select: { depositAddress: true, depositAddressIndex: true } });
    if (!existing) return null;
    if (existing.depositAddress && existing.depositAddressIndex != null) {
      return { address: existing.depositAddress, index: existing.depositAddressIndex };
    }
    // A DB SEQUENCE hands every caller a DISTINCT index — no max+1 contention, so
    // concurrent first-time visitors never collide. `derive` is total for a valid
    // index (the xpub is validated once at construction); a throw would only waste
    // one index (gaps are fine) and surface as a 500, never a wrong address.
    const rows = await this.db.$queryRawUnsafe<Array<{ nextval: bigint }>>(`SELECT nextval('deposit_address_index_seq') AS nextval`);
    const index = Number(rows[0]?.nextval ?? 0n);
    const address = derive(index);
    const res = await this.db.user.updateMany({
      where: { id, depositAddress: null },
      data: { depositAddress: address, depositAddressIndex: index },
    });
    if (res.count === 1) return { address, index };
    // count 0 → a concurrent call for the SAME user assigned first; return the winner.
    const u = await this.db.user.findUnique({ where: { id }, select: { depositAddress: true, depositAddressIndex: true } });
    return u?.depositAddress != null && u.depositAddressIndex != null ? { address: u.depositAddress, index: u.depositAddressIndex } : null;
  }

  async updateCompliance(id: string, patch: ComplianceUpdate): Promise<User | null> {
    const data: Record<string, unknown> = {};
    if (patch.kycStatus !== undefined) data.kycStatus = patch.kycStatus;
    if (patch.dateOfBirth !== undefined) data.dateOfBirth = patch.dateOfBirth;
    if (patch.country !== undefined) data.country = patch.country;
    if (patch.selfExcludedUntil !== undefined) data.selfExcludedUntil = patch.selfExcludedUntil ? new Date(patch.selfExcludedUntil) : null;
    const row = await this.db.user.update({ where: { id }, data }).catch(() => null);
    return row ? toUser(row) : null;
  }

  async setLimits(id: string, patch: { dailyDepositLimitCents?: number | null; dailyLossLimitCents?: number | null }): Promise<User | null> {
    const data: Record<string, unknown> = {};
    if (patch.dailyDepositLimitCents !== undefined) data.dailyDepositLimitCents = patch.dailyDepositLimitCents;
    if (patch.dailyLossLimitCents !== undefined) data.dailyLossLimitCents = patch.dailyLossLimitCents;
    const row = await this.db.user.update({ where: { id }, data }).catch(() => null);
    return row ? toUser(row) : null;
  }

  async setAccountState(id: string, patch: AccountStatePatch): Promise<User | null> {
    const row = await this.db.user.update({
      where: { id },
      data: {
        accountState: patch.state,
        accountStateReason: patch.reason ?? null,
        accountStateUntil: patch.until ? new Date(patch.until) : null,
      },
    }).catch(() => null);
    return row ? toUser(row) : null;
  }

  async list(): Promise<User[]> {
    return (await this.db.user.findMany({ orderBy: { createdAt: 'desc' } })).map(toUser);
  }

  async applyMatchResult(id: string, r: { won: boolean; potCents: number; xpGain: number }): Promise<User | null> {
    // Cosmetic stats — a plain read-modify-write (no money, no transaction needed).
    const cur = await this.db.user.findUnique({ where: { id } });
    if (!cur) return null;
    const row = await this.db.user.update({
      where: { id },
      data: {
        gamesPlayed: { increment: 1 },
        wins: { increment: r.won ? 1 : 0 },
        xp: { increment: Math.max(0, Math.floor(r.xpGain)) },
        currentStreak: r.won ? cur.currentStreak + 1 : 0,
        biggestPotCents: Math.max(cur.biggestPotCents, r.potCents),
      },
    });
    return toUser(row);
  }

  async setAvatar(id: string, avatar: string): Promise<User | null> {
    const row = await this.db.user.update({ where: { id }, data: { avatar } }).catch(() => null);
    return row ? toUser(row) : null;
  }

  async topByXp(limit: number): Promise<User[]> {
    return (await this.db.user.findMany({ orderBy: [{ xp: 'desc' }, { wins: 'desc' }], take: Math.max(0, limit) })).map(toUser);
  }

  async addXp(id: string, deltaXp: number): Promise<User | null> {
    const cur = await this.db.user.findUnique({ where: { id } });
    if (!cur) return null;
    const xp = Math.max(0, cur.xp + Math.floor(deltaXp));
    return toUser(await this.db.user.update({ where: { id }, data: { xp } }));
  }

  async setRewards(id: string, patch: RewardsPatch): Promise<User | null> {
    const data: Record<string, unknown> = {};
    if (patch.lastDailyClaim !== undefined) data.lastDailyClaim = patch.lastDailyClaim ? new Date(patch.lastDailyClaim) : null;
    if (patch.dailyStreak !== undefined) data.dailyStreak = patch.dailyStreak;
    if (patch.cosmetics !== undefined) data.cosmetics = patch.cosmetics;
    if (patch.cardBack !== undefined) data.cardBack = patch.cardBack;
    if (patch.tableFelt !== undefined) data.tableFelt = patch.tableFelt;
    if (patch.claimedChallenges !== undefined) data.claimedChallenges = patch.claimedChallenges;
    const row = await this.db.user.update({ where: { id }, data }).catch(() => null);
    return row ? toUser(row) : null;
  }

  async bumpTokenVersion(id: string): Promise<number | null> {
    const row = await this.db.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } } }).catch(() => null);
    return row ? row.tokenVersion : null;
  }

  async anonymize(id: string): Promise<boolean> {
    const suffix = id.slice(0, 8).toLowerCase();
    const row = await this.db.user.update({
      where: { id },
      data: {
        username: `deleted_${suffix}`,
        usernameLower: `deleted_${suffix}`,
        email: `deleted_${id}@deleted.invalid`,
        passwordHash: '!anonymized!', // unusable hash → password login can never match
        dateOfBirth: null,
        country: null,
        avatar: null,
        accountState: 'banned', // closed: blocks login (reason marks it self-deletion)
        accountStateReason: 'account_self_deleted',
        accountStateUntil: null,
        tokenVersion: { increment: 1 }, // invalidate existing sessions
      },
    }).catch(() => null);
    return row !== null;
  }

  async purchaseCosmetic(id: string, cosmeticId: string, cost: number): Promise<{ ok: boolean; code?: string }> {
    // One atomic conditional update: deduct + grant only if affordable AND not
    // already owned. count===1 ⇒ purchased; otherwise diagnose why it failed.
    const res = await this.db.user.updateMany({
      where: { id, xp: { gte: cost }, NOT: { cosmetics: { has: cosmeticId } } },
      data: { xp: { decrement: cost }, cosmetics: { push: cosmeticId } },
    });
    if (res.count === 1) return { ok: true };
    const u = await this.db.user.findUnique({ where: { id } });
    if (!u) return { ok: false, code: 'not_found' };
    if (u.cosmetics.includes(cosmeticId)) return { ok: false, code: 'owned' };
    return { ok: false, code: 'insufficient_xp' };
  }

  // NOTE: these are security-state writes (password reset, role/permission change,
  // email verification). They MUST throw on failure — swallowing the error reported a
  // failed password-reset or admin demotion as SUCCESS while the old state persisted.
  // Callers (authService.resetPassword/setRole/...) propagate the throw → the route 500s.
  async setEmailVerified(id: string, verified: boolean): Promise<void> {
    await this.db.user.update({ where: { id }, data: { emailVerified: verified } });
  }
  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.db.user.update({ where: { id }, data: { passwordHash } });
  }
  async setRole(id: string, role: UserRole): Promise<void> {
    await this.db.user.update({ where: { id }, data: { role } });
  }
  async setPermissions(id: string, permissions: string[]): Promise<void> {
    await this.db.user.update({ where: { id }, data: { permissions } });
  }
}

function toFriendship(row: any): Friendship {
  return { id: row.id, requesterId: row.requesterId, addresseeId: row.addresseeId, status: row.status, createdAt: ms(row.createdAt) };
}

export class PrismaFriends implements FriendsRepository {
  constructor(private readonly db: PrismaClient) {}

  async request(requesterId: string, addresseeId: string) {
    if (requesterId === addresseeId) throw new Error('cannot befriend yourself');
    const existing = await this.findBetween(requesterId, addresseeId);
    if (existing) return existing;
    const row = await this.db.friendship.create({ data: { requesterId, addresseeId } });
    return toFriendship(row);
  }
  async respond(id: string, userId: string, accept: boolean) {
    const row = await this.db.friendship.findUnique({ where: { id } });
    if (!row || row.addresseeId !== userId || row.status !== 'pending') return null;
    if (!accept) { await this.db.friendship.delete({ where: { id } }).catch((e) => console.error('[friends] decline-delete failed', e)); return null; }
    return toFriendship(await this.db.friendship.update({ where: { id }, data: { status: 'accepted' } }));
  }
  async remove(id: string, userId: string) {
    const res = await this.db.friendship.deleteMany({ where: { id, OR: [{ requesterId: userId }, { addresseeId: userId }] } });
    return res.count > 0;
  }
  async listFor(userId: string) {
    const rows = await this.db.friendship.findMany({ where: { OR: [{ requesterId: userId }, { addresseeId: userId }] } });
    return rows.map(toFriendship);
  }
  async findBetween(a: string, b: string) {
    const row = await this.db.friendship.findFirst({
      where: { OR: [{ requesterId: a, addresseeId: b }, { requesterId: b, addresseeId: a }] },
    });
    return row ? toFriendship(row) : null;
  }
  async block(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) return;
    await this.db.friendship.deleteMany({
      where: { OR: [{ requesterId: blockerId, addresseeId: blockedId }, { requesterId: blockedId, addresseeId: blockerId }] },
    });
    await this.db.friendship.create({ data: { requesterId: blockerId, addresseeId: blockedId, status: 'blocked' } });
  }
  async unblock(blockerId: string, blockedId: string) {
    await this.db.friendship.deleteMany({ where: { requesterId: blockerId, addresseeId: blockedId, status: 'blocked' } });
  }
}

function toTx(row: any): Transaction {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as TransactionType,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status as TransactionStatus,
    providerRef: row.providerRef,
    matchId: row.matchId,
    reason: row.reason,
    createdAt: ms(row.createdAt),
  };
}

export class PrismaLedger implements LedgerRepository {
  constructor(private readonly db: PrismaClient) {}

  async append(tx: NewTransaction): Promise<Transaction> {
    try {
      const row = await this.db.transaction.create({
        data: {
          userId: tx.userId,
          type: tx.type,
          amountCents: tx.amountCents,
          currency: tx.currency ?? 'USD',
          status: tx.status ?? 'completed',
          providerRef: tx.providerRef ?? null,
          matchId: tx.matchId ?? null,
          reason: tx.reason ?? null,
        },
      });
      return toTx(row);
    } catch (e: any) {
      // Unique constraint on providerRef → idempotency collision.
      if (e?.code === 'P2002' && tx.providerRef) throw new DuplicateProviderRefError(tx.providerRef);
      throw e;
    }
  }
  async appendIdempotent(tx: NewTransaction & { providerRef: string }): Promise<{ transaction: Transaction; created: boolean }> {
    // createMany(skipDuplicates) compiles to INSERT ... ON CONFLICT DO NOTHING:
    // a duplicate providerRef does NOT raise, so it never aborts the enclosing
    // transaction. Then read the row (just-inserted or pre-existing).
    const res = await this.db.transaction.createMany({
      data: [{
        userId: tx.userId,
        type: tx.type,
        amountCents: tx.amountCents,
        currency: tx.currency ?? 'USD',
        status: tx.status ?? 'completed',
        providerRef: tx.providerRef,
        matchId: tx.matchId ?? null,
        reason: tx.reason ?? null,
      }],
      skipDuplicates: true,
    });
    const row = await this.db.transaction.findUnique({ where: { providerRef: tx.providerRef } });
    if (!row) throw new Error(`appendIdempotent: row for providerRef ${tx.providerRef} missing after upsert`);
    return { transaction: toTx(row), created: res.count === 1 };
  }

  async findByProviderRef(ref: string): Promise<Transaction | null> {
    const row = await this.db.transaction.findUnique({ where: { providerRef: ref } });
    return row ? toTx(row) : null;
  }
  async listByUser(userId: string, opts?: LedgerPageOpts): Promise<Transaction[]> {
    // No opts → unbounded scan (unchanged: reconcile/RG/VIP aggregates need every row).
    if (!opts) return (await this.db.transaction.findMany({ where: { userId } })).map(toTx);
    // Bounded keyset page, newest-first, for display lists. Cursor is a transaction id;
    // skip:1 excludes the cursor row itself (rows strictly older follow it).
    const rows = await this.db.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.max(0, opts.take),
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    return rows.map(toTx);
  }
  async all(): Promise<Transaction[]> {
    return (await this.db.transaction.findMany()).map(toTx);
  }
  async sumByUserAndType(userId: string, type: TransactionType): Promise<number> {
    // DB aggregate — no whole-table JS scan (db-6 / money-23). Rake rows are positive,
    // but take abs() to be sign-agnostic and match the in-memory implementation.
    const agg = await this.db.transaction.aggregate({ where: { userId, type }, _sum: { amountCents: true } });
    return Math.abs(agg._sum.amountCents ?? 0);
  }
  async sumByUserTypesSince(userId: string, types: TransactionType[], sinceMs: number): Promise<number> {
    // SIGNED DB aggregate for the responsible-gaming hot paths (db-6 / dos-2).
    const agg = await this.db.transaction.aggregate({
      where: { userId, type: { in: types }, createdAt: { gte: new Date(sinceMs) } },
      _sum: { amountCents: true },
    });
    return agg._sum.amountCents ?? 0;
  }
}

function toMatch(row: any): MatchRecord {
  return {
    id: row.id,
    type: row.type as MatchType,
    stakeCents: row.stakeCents,
    rakeBps: row.rakeBps,
    potCents: row.potCents,
    status: row.status as MatchStatus,
    // winnerSeats is informational and not used by settle/refund logic (those key
    // off status); only the representative winnerSide is persisted.
    winnerSeats: null,
    players: (row.players ?? []).map((p: any) => ({ seat: p.seat, userId: p.userId })),
    createdAt: ms(row.createdAt),
    endedAt: msOrNull(row.endedAt),
  };
}

export class PrismaMatchesRepository implements MatchesRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(m: NewMatch): Promise<MatchRecord> {
    const row = await this.db.match.create({
      data: {
        id: m.id,
        type: m.type,
        stakeCents: m.stakeCents,
        rakeBps: m.rakeBps,
        potCents: m.potCents,
        players: { create: m.players.map((p) => ({ seat: p.seat, userId: p.userId })) },
      },
      include: { players: true },
    });
    return { ...toMatch(row), winnerSeats: null };
  }
  async find(id: string): Promise<MatchRecord | null> {
    const row = await this.db.match.findUnique({ where: { id }, include: { players: true } });
    return row ? toMatch(row) : null;
  }
  async findManyByIds(ids: string[]): Promise<MatchRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.match.findMany({ where: { id: { in: ids } }, include: { players: true } });
    return rows.map(toMatch);
  }
  async markSettled(id: string, winnerSeats: number[]): Promise<void> {
    // winnerSide is a representative seat; full winner set is derivable from match_players + finishingOrder.
    // Status-guarded (WHERE status='active'): a duplicate/late transition is a harmless
    // no-op (0 rows), so a multi-instance or retried settle can't re-finalize a match.
    await this.db.match.updateMany({ where: { id, status: 'active' }, data: { status: 'settled', winnerSide: winnerSeats[0] ?? null, endedAt: new Date() } });
  }
  async markCancelled(id: string): Promise<void> {
    await this.db.match.updateMany({ where: { id, status: 'active' }, data: { status: 'cancelled', endedAt: new Date() } });
  }
  async listActive(): Promise<MatchRecord[]> {
    const rows = await this.db.match.findMany({ where: { status: 'active' }, include: { players: true } });
    return rows.map(toMatch);
  }
}

function toWithdrawal(row: any): WithdrawalRecord {
  return {
    id: row.id,
    userId: row.userId,
    amountCents: row.amountCents,
    destination: row.destination,
    status: row.status as WithdrawalStatus,
    createdAt: ms(row.createdAt),
    resolvedAt: msOrNull(row.resolvedAt),
    providerRef: row.providerRef ?? null,
    network: row.network ?? null,
    txHash: row.txHash ?? null,
    resolvedByAdminId: row.resolvedByAdminId ?? null,
    failureReason: row.failureReason ?? null,
  };
}

/** Map a WithdrawalResolution to a Prisma update payload (only defined keys). */
function withdrawalAuditData(audit?: WithdrawalResolution): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (!audit) return d;
  if (audit.resolvedByAdminId !== undefined) d.resolvedByAdminId = audit.resolvedByAdminId;
  if (audit.providerRef !== undefined) d.providerRef = audit.providerRef;
  if (audit.network !== undefined) d.network = audit.network;
  if (audit.txHash !== undefined) d.txHash = audit.txHash;
  if (audit.failureReason !== undefined) d.failureReason = audit.failureReason;
  return d;
}

export class PrismaWithdrawals implements WithdrawalRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(r: Omit<WithdrawalRecord, 'id' | 'status' | 'createdAt' | 'resolvedAt' | 'providerRef' | 'network' | 'txHash' | 'resolvedByAdminId' | 'failureReason'>): Promise<WithdrawalRecord> {
    const row = await this.db.withdrawal.create({ data: { userId: r.userId, amountCents: r.amountCents, destination: r.destination } });
    return toWithdrawal(row);
  }
  async find(id: string): Promise<WithdrawalRecord | null> {
    const row = await this.db.withdrawal.findUnique({ where: { id } });
    return row ? toWithdrawal(row) : null;
  }
  async setStatusIfPending(id: string, status: WithdrawalStatus, audit?: WithdrawalResolution): Promise<WithdrawalRecord | null> {
    // Atomic compare-and-set: only a 'pending' row transitions. count===0 means
    // it was already resolved (lost the race) → null. Stamps audit fields too.
    const res = await this.db.withdrawal.updateMany({ where: { id, status: 'pending' }, data: { status, resolvedAt: new Date(), ...withdrawalAuditData(audit) } });
    if (res.count === 0) return null;
    const row = await this.db.withdrawal.findUnique({ where: { id } });
    return row ? toWithdrawal(row) : null;
  }
  async markReversed(id: string): Promise<void> {
    // Atomic: only flip a 'completed' payout that later failed on-chain → 'rejected'.
    await this.db.withdrawal.updateMany({ where: { id, status: 'completed' }, data: { status: 'rejected', resolvedAt: new Date(), failureReason: 'payout failed on-chain (auto-reversed)' } });
  }
  async setAudit(id: string, audit: WithdrawalResolution): Promise<void> {
    // Stamp audit fields only (no status change) — records the payout ref after a send.
    await this.db.withdrawal.update({ where: { id }, data: withdrawalAuditData(audit) });
  }
  async listPending(): Promise<WithdrawalRecord[]> {
    return (await this.db.withdrawal.findMany({ where: { status: 'pending' } })).map(toWithdrawal);
  }
  async listByUser(userId: string, limit = WITHDRAWALS_PAGE_DEFAULT): Promise<WithdrawalRecord[]> {
    const take = Math.max(1, Math.min(WITHDRAWALS_PAGE_DEFAULT, Math.floor(limit)));
    // Newest-first + bounded (dos-2): a user history never loads an unbounded set.
    return (await this.db.withdrawal.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take })).map(toWithdrawal);
  }
  async listCompletedSince(sinceMs: number): Promise<WithdrawalRecord[]> {
    return (await this.db.withdrawal.findMany({ where: { status: 'completed', resolvedAt: { gte: new Date(sinceMs) } } })).map(toWithdrawal);
  }
}

export class PrismaDepositIntents implements DepositIntentRepository {
  constructor(private readonly db: PrismaClient) {}

  async save(r: Omit<DepositIntentRecord, 'createdAt'>): Promise<void> {
    // Last-write-wins, matching the in-memory store's overwrite semantics.
    await this.db.depositIntent.upsert({
      where: { providerRef: r.providerRef },
      create: { providerRef: r.providerRef, userId: r.userId, amountCents: r.amountCents, currency: r.currency },
      update: { userId: r.userId, amountCents: r.amountCents, currency: r.currency },
    });
  }
  async find(providerRef: string): Promise<DepositIntentRecord | null> {
    const row = await this.db.depositIntent.findUnique({ where: { providerRef } });
    return row ? { providerRef: row.providerRef, userId: row.userId, amountCents: row.amountCents, currency: row.currency, createdAt: ms(row.createdAt) } : null;
  }
}

export class PrismaRefreshTokens implements RefreshTokenRepository {
  constructor(private readonly db: PrismaClient) {}

  async save(r: NewRefreshToken): Promise<void> {
    await this.db.refreshToken.create({
      data: { jti: r.jti, userId: r.userId, family: r.family, expiresAt: new Date(r.expiresAt) },
    });
  }
  async find(jti: string): Promise<RefreshTokenRecord | null> {
    const row = await this.db.refreshToken.findUnique({ where: { jti } });
    return row
      ? { jti: row.jti, userId: row.userId, family: row.family, revoked: row.revoked, expiresAt: ms(row.expiresAt), createdAt: ms(row.createdAt) }
      : null;
  }
  async revoke(jti: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { jti }, data: { revoked: true } });
  }
  async revokeIfActive(jti: string): Promise<boolean> {
    // ATOMIC compare-and-set: only the row that is STILL unrevoked flips. count===1 means
    // THIS call won the rotation; count===0 means it was already rotated (concurrent reuse).
    const res = await this.db.refreshToken.updateMany({ where: { jti, revoked: false }, data: { revoked: true } });
    return res.count === 1;
  }
  async revokeFamily(family: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { family }, data: { revoked: true } });
  }
  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { userId, revoked: false }, data: { revoked: true } });
  }
  async deleteExpired(nowMs: number): Promise<number> {
    const res = await this.db.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date(nowMs) } } });
    return res.count;
  }
}

export class PrismaAdminAudit implements AdminAuditRepository {
  constructor(private readonly db: PrismaClient) {}

  async record(a: NewAdminAction): Promise<void> {
    await this.db.adminAction.create({
      data: {
        adminId: a.adminId,
        action: a.action,
        targetUserId: a.targetUserId ?? null,
        amountCents: a.amountCents ?? null,
        detail: a.detail ?? null,
      },
    });
  }
  async list(limit = 200): Promise<AdminActionRecord[]> {
    const rows = await this.db.adminAction.findMany({ orderBy: { createdAt: 'desc' }, take: Math.max(0, limit) });
    return rows.map((row: any) => ({
      id: row.id,
      adminId: row.adminId,
      action: row.action as AdminActionType,
      targetUserId: row.targetUserId,
      amountCents: row.amountCents,
      detail: row.detail,
      createdAt: ms(row.createdAt),
    }));
  }
  async sumAdjustmentsBy(adminId: string, sinceMs: number): Promise<number> {
    // SUM(|amountCents|) of this admin's balance_adjust rows in the window. Postgres has no
    // SUM(ABS()) helper here, so fetch the (bounded, indexed) rows and sum in JS — the
    // window is 24h of one admin's adjustments, which is tiny in practice.
    const rows = await this.db.adminAction.findMany({
      where: { adminId, action: 'balance_adjust', createdAt: { gte: new Date(sinceMs) } },
      select: { amountCents: true },
    });
    return rows.reduce((s: number, r: { amountCents: number | null }) => s + Math.abs(r.amountCents ?? 0), 0);
  }
}

export class PrismaGames implements GamesRepository {
  constructor(private readonly db: PrismaClient) {}

  async recordGame(g: NewGameRecord): Promise<void> {
    // Idempotent on the (matchId, index) unique key.
    await this.db.game.upsert({
      where: { matchId_index: { matchId: g.matchId, index: g.index } },
      create: { matchId: g.matchId, index: g.index, finishingOrder: [], serverSeed: g.serverSeed, serverSeedHash: g.serverSeedHash, clientSeed: g.clientSeed, nonce: g.nonce, revealed: false },
      update: {},
    });
  }
  async revealMatch(matchId: string): Promise<void> {
    await this.db.game.updateMany({ where: { matchId }, data: { revealed: true } });
  }
  async listByMatch(matchId: string): Promise<GameRecord[]> {
    const rows = await this.db.game.findMany({ where: { matchId }, orderBy: { index: 'asc' } });
    return rows.map((row: any) => ({
      matchId: row.matchId,
      index: row.index,
      serverSeed: row.serverSeed ?? '',
      serverSeedHash: row.serverSeedHash,
      clientSeed: row.clientSeed,
      nonce: row.nonce,
      revealed: row.revealed,
      createdAt: ms(row.createdAt),
    }));
  }
}

export class PrismaVerificationTokens implements VerificationTokenRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(r: NewVerificationToken): Promise<void> {
    await this.db.verificationToken.create({
      data: { userId: r.userId, type: r.type, tokenHash: r.tokenHash, expiresAt: new Date(r.expiresAt) },
    });
  }
  async findValidByHash(tokenHash: string, type: VerificationTokenType, nowMs: number): Promise<VerificationTokenRecord | null> {
    const row = await this.db.verificationToken.findUnique({ where: { tokenHash } });
    if (!row || row.type !== type || row.usedAt !== null || row.expiresAt.getTime() < nowMs) return null;
    return { id: row.id, userId: row.userId, type: row.type as VerificationTokenType, tokenHash: row.tokenHash, expiresAt: ms(row.expiresAt), usedAt: msOrNull(row.usedAt), createdAt: ms(row.createdAt) };
  }
  async consume(id: string, nowMs: number): Promise<void> {
    await this.db.verificationToken.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date(nowMs) } });
  }
  async invalidateUnconsumed(userId: string, type: VerificationTokenType, nowMs: number): Promise<number> {
    const res = await this.db.verificationToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date(nowMs) } });
    return res.count;
  }
  async deleteExpired(nowMs: number): Promise<number> {
    const res = await this.db.verificationToken.deleteMany({ where: { expiresAt: { lt: new Date(nowMs) } } });
    return res.count;
  }
}

function toSeason(row: any): Season {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    status: row.status as SeasonStatus,
    decayFactor: row.decayFactor,
    startedAt: ms(row.startedAt),
    endedAt: msOrNull(row.endedAt),
  };
}

function toUserSeason(row: any): UserSeason {
  return {
    userId: row.userId,
    seasonId: row.seasonId,
    rating: row.rating,
    peakRating: row.peakRating,
    games: row.games,
    wins: row.wins,
    updatedAt: ms(row.updatedAt),
  };
}

export class PrismaSeasonRepository implements SeasonRepository {
  constructor(private readonly db: PrismaClient) {}

  async createSeason(input: NewSeason): Promise<Season> {
    const row = await this.db.season.create({
      data: { number: input.number, name: input.name, decayFactor: input.decayFactor, startedAt: new Date(input.startedAt), status: 'active' },
    });
    return toSeason(row);
  }
  async archiveSeason(seasonId: string, endedAt: number): Promise<void> {
    await this.db.season.update({ where: { id: seasonId }, data: { status: 'archived', endedAt: new Date(endedAt) } }).catch(() => undefined);
  }
  async getActiveSeason(): Promise<Season | null> {
    const row = await this.db.season.findFirst({ where: { status: 'active' }, orderBy: { number: 'desc' } });
    return row ? toSeason(row) : null;
  }
  async getSeason(id: string): Promise<Season | null> {
    const row = await this.db.season.findUnique({ where: { id } });
    return row ? toSeason(row) : null;
  }
  async listSeasons(): Promise<Season[]> {
    return (await this.db.season.findMany({ orderBy: { number: 'desc' } })).map(toSeason);
  }

  async getUserSeason(userId: string, seasonId: string): Promise<UserSeason | null> {
    const row = await this.db.userSeason.findUnique({ where: { seasonId_userId: { seasonId, userId } } });
    return row ? toUserSeason(row) : null;
  }
  async upsertUserSeason(row: UserSeason): Promise<void> {
    await this.db.userSeason.upsert({
      where: { seasonId_userId: { seasonId: row.seasonId, userId: row.userId } },
      create: { userId: row.userId, seasonId: row.seasonId, rating: row.rating, peakRating: row.peakRating, games: row.games, wins: row.wins, updatedAt: new Date(row.updatedAt) },
      update: { rating: row.rating, peakRating: row.peakRating, games: row.games, wins: row.wins, updatedAt: new Date(row.updatedAt) },
    });
  }
  async listUserSeasons(seasonId: string): Promise<UserSeason[]> {
    return (await this.db.userSeason.findMany({ where: { seasonId } })).map(toUserSeason);
  }
  async topByRating(seasonId: string, limit: number): Promise<UserSeason[]> {
    const rows = await this.db.userSeason.findMany({
      where: { seasonId },
      orderBy: [{ rating: 'desc' }, { peakRating: 'desc' }, { userId: 'asc' }],
      take: Math.max(0, limit),
    });
    return rows.map(toUserSeason);
  }
}

export class PrismaMatchActions implements MatchActionsRepository {
  constructor(private readonly db: PrismaClient) {}

  async append(a: NewMatchAction): Promise<void> {
    // Idempotent on the (matchId, seq) primary key — a retried fire-and-forget
    // write never raises (skipDuplicates → ON CONFLICT DO NOTHING).
    await this.db.gameAction.createMany({
      data: [{
        matchId: a.matchId, seq: a.seq, gameIndex: a.gameIndex, seat: a.seat,
        type: a.type, cards: (a.cards ?? undefined) as any, createdAt: new Date(a.at),
      }],
      skipDuplicates: true,
    });
  }
  async listByMatch(matchId: string): Promise<MatchActionRecord[]> {
    const rows = await this.db.gameAction.findMany({ where: { matchId }, orderBy: { seq: 'asc' } });
    return rows.map((row: any) => ({
      matchId: row.matchId,
      seq: row.seq,
      gameIndex: row.gameIndex,
      seat: row.seat,
      type: row.type as MatchActionType,
      cards: (row.cards ?? null) as Card[] | null,
      at: ms(row.createdAt),
    }));
  }
  async deleteOlderThan(cutoffMs: number): Promise<number> {
    const res = await this.db.gameAction.deleteMany({ where: { createdAt: { lt: new Date(cutoffMs) } } });
    return res.count;
  }
}

function toTicket(row: any): SupportTicket {
  return {
    id: row.id,
    userId: row.userId,
    category: row.category as SupportCategory,
    subject: row.subject,
    message: row.message,
    status: row.status as SupportStatus,
    matchId: row.matchId ?? null,
    adminNote: row.adminNote ?? null,
    createdAt: ms(row.createdAt),
    resolvedAt: msOrNull(row.resolvedAt),
  };
}

export class PrismaSupport implements SupportRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(t: NewSupportTicket): Promise<SupportTicket> {
    const row = await this.db.supportTicket.create({
      data: { userId: t.userId, category: t.category, subject: t.subject, message: t.message, matchId: t.matchId ?? null },
    });
    return toTicket(row);
  }
  async get(id: string): Promise<SupportTicket | null> {
    const row = await this.db.supportTicket.findUnique({ where: { id } });
    return row ? toTicket(row) : null;
  }
  async listByUser(userId: string): Promise<SupportTicket[]> {
    return (await this.db.supportTicket.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })).map(toTicket);
  }
  async list(limit: number): Promise<SupportTicket[]> {
    return (await this.db.supportTicket.findMany({ orderBy: { createdAt: 'desc' }, take: Math.max(0, limit) })).map(toTicket);
  }
  async resolve(id: string, status: 'resolved' | 'closed', adminNote: string | null, atMs: number): Promise<SupportTicket | null> {
    const row = await this.db.supportTicket.update({ where: { id }, data: { status, adminNote, resolvedAt: new Date(atMs) } }).catch(() => null);
    return row ? toTicket(row) : null;
  }
}

export class PrismaSuspicion implements SuspicionRepository {
  constructor(private readonly db: PrismaClient) {}

  async add(f: NewSuspicionFlag): Promise<void> {
    await this.db.suspicionFlag.create({
      data: { userId: f.userId, type: f.type, severity: f.severity, detail: f.detail, matchId: f.matchId ?? null },
    });
  }
  async list(opts: { minSeverity?: number; limit?: number } = {}): Promise<SuspicionFlag[]> {
    const rows = await this.db.suspicionFlag.findMany({
      where: { severity: { gte: opts.minSeverity ?? 1 } },
      orderBy: { createdAt: 'desc' },
      take: Math.max(0, opts.limit ?? 200),
    });
    return rows.map((row: any) => ({
      id: row.id, userId: row.userId, type: row.type, severity: row.severity,
      detail: row.detail, matchId: row.matchId ?? null, reviewed: row.reviewed, createdAt: ms(row.createdAt),
    }));
  }
}

export class PrismaPushSubscriptions implements PushSubscriptionRepository {
  constructor(private readonly db: PrismaClient) {}

  async add(userId: string, sub: WebPushSubscription): Promise<void> {
    await this.db.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      update: { userId, p256dh: sub.p256dh, auth: sub.auth },
    });
  }
  async removeByEndpoint(endpoint: string, userId?: string): Promise<void> {
    // Scope to the owner when caller-initiated (authz — can't drop another user's device
    // by guessing the endpoint); endpoint-only for system gone-cleanup.
    await this.db.pushSubscription.deleteMany({ where: { endpoint, ...(userId ? { userId } : {}) } });
  }
  async listByUser(userId: string): Promise<PushSubscriptionRecord[]> {
    const rows = await this.db.pushSubscription.findMany({ where: { userId } });
    return rows.map((r: any) => ({ id: r.id, userId: r.userId, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, createdAt: ms(r.createdAt) }));
  }
}

export class PrismaChat implements ChatRepository {
  constructor(private readonly db: PrismaClient) {}

  async addMessage(m: { clubId: string; userId: string; username: string; text: string }): Promise<ChatMessageRecord> {
    const row = await this.db.chatMessage.create({ data: m });
    return { id: row.id, clubId: row.clubId, userId: row.userId, username: row.username, text: row.text, createdAt: ms(row.createdAt) };
  }
  async getMessage(id: string): Promise<ChatMessageRecord | null> {
    const row = await this.db.chatMessage.findUnique({ where: { id } });
    return row ? { id: row.id, clubId: row.clubId, userId: row.userId, username: row.username, text: row.text, createdAt: ms(row.createdAt) } : null;
  }
  async listByClub(clubId: string, limit: number): Promise<ChatMessageRecord[]> {
    const rows = await this.db.chatMessage.findMany({ where: { clubId }, orderBy: { createdAt: 'desc' }, take: Math.max(0, limit) });
    return rows.reverse().map((row: any) => ({ id: row.id, clubId: row.clubId, userId: row.userId, username: row.username, text: row.text, createdAt: ms(row.createdAt) }));
  }
  async addReport(r: { messageId: string; clubId: string; reporterId: string; reason: string }): Promise<void> {
    await this.db.chatReport.create({ data: r });
  }
  async listReports(limit: number): Promise<ChatReportRecord[]> {
    const rows = await this.db.chatReport.findMany({ orderBy: { createdAt: 'desc' }, take: Math.max(0, limit) });
    return rows.map((row: any) => ({ id: row.id, messageId: row.messageId, clubId: row.clubId, reporterId: row.reporterId, reason: row.reason, reviewed: row.reviewed, createdAt: ms(row.createdAt) }));
  }
  async setMute(userId: string, until: number, by: string, reason: string): Promise<void> {
    await this.db.userMute.upsert({
      where: { userId },
      create: { userId, until: new Date(until), by, reason },
      update: { until: new Date(until), by, reason },
    });
  }
  async clearMute(userId: string): Promise<void> {
    await this.db.userMute.deleteMany({ where: { userId } });
  }
  async muteUntil(userId: string): Promise<number | null> {
    const row = await this.db.userMute.findUnique({ where: { userId } });
    return row ? ms(row.until) : null;
  }
}

function toClub(row: any): Club {
  return { id: row.id, name: row.name, tag: row.tag, founderId: row.founderId, createdAt: ms(row.createdAt), private: !!row.private, joinCode: row.joinCode ?? null };
}
function toMember(row: any): ClubMember {
  return { userId: row.userId, clubId: row.clubId, role: row.role as ClubRole, joinedAt: ms(row.joinedAt) };
}

export class PrismaClubs implements ClubRepository {
  constructor(private readonly db: PrismaClient) {}

  async createClub(c: NewClub): Promise<Club> {
    const isPrivate = !!c.private;
    try {
      const row = await this.db.club.create({
        data: { name: c.name, tag: c.tag.toUpperCase(), founderId: c.founderId, private: isPrivate, joinCode: isPrivate ? genClubCode() : null, members: { create: { userId: c.founderId, role: 'founder' } } },
      });
      return toClub(row);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new DuplicateClubTagError();
      throw e;
    }
  }
  async getClub(id: string): Promise<Club | null> {
    const row = await this.db.club.findUnique({ where: { id } });
    return row ? toClub(row) : null;
  }
  async getByTag(tag: string): Promise<Club | null> {
    const row = await this.db.club.findUnique({ where: { tag: tag.toUpperCase() } });
    return row ? toClub(row) : null;
  }
  async getByCode(code: string): Promise<Club | null> {
    const up = code.trim().toUpperCase();
    if (!up) return null;
    const row = await this.db.club.findFirst({ where: { private: true, joinCode: up } });
    return row ? toClub(row) : null;
  }
  async listClubs(limit: number): Promise<Array<Club & { memberCount: number }>> {
    const rows = await this.db.club.findMany({
      where: { private: false }, // private clubs are not listed publicly
      orderBy: { members: { _count: 'desc' } },
      take: Math.max(0, limit),
      include: { _count: { select: { members: true } } },
    });
    return rows.map((r: any) => ({ ...toClub(r), memberCount: r._count.members }));
  }
  async deleteClub(id: string): Promise<void> {
    await this.db.clubMember.deleteMany({ where: { clubId: id } });
    await this.db.club.delete({ where: { id } }).catch(() => undefined);
  }
  async setFounder(clubId: string, founderId: string): Promise<void> {
    await this.db.club.update({ where: { id: clubId }, data: { founderId } }).catch(() => undefined);
  }
  async memberOf(userId: string): Promise<ClubMember | null> {
    const row = await this.db.clubMember.findUnique({ where: { userId } });
    return row ? toMember(row) : null;
  }
  async addMember(m: { userId: string; clubId: string; role: ClubRole }): Promise<ClubMember> {
    return toMember(await this.db.clubMember.create({ data: { userId: m.userId, clubId: m.clubId, role: m.role } }));
  }
  async removeMember(userId: string): Promise<void> {
    await this.db.clubMember.deleteMany({ where: { userId } });
  }
  async setRole(userId: string, role: ClubRole): Promise<void> {
    await this.db.clubMember.update({ where: { userId }, data: { role } }).catch(() => undefined);
  }
  async listMembers(clubId: string, limit?: number): Promise<ClubMember[]> {
    const rows = await this.db.clubMember.findMany({
      where: { clubId },
      // founder first, then oldest join — DB-ordered so a `take` returns the right page.
      orderBy: [{ role: 'desc' }, { joinedAt: 'asc' }], // 'founder' > 'member' lexically
      ...(limit != null ? { take: Math.max(0, limit) } : {}),
    });
    return rows
      .map(toMember)
      .sort((a, b) => (a.role === 'founder' ? -1 : b.role === 'founder' ? 1 : 0) || a.joinedAt - b.joinedAt);
  }
  async countMembers(clubId: string): Promise<number> {
    return this.db.clubMember.count({ where: { clubId } });
  }
}

/** Runs WalletService credit/debit inside one Postgres transaction (atomic). */
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly db: PrismaClient) {}

  transaction<T>(fn: (ctx: WalletTxContext) => Promise<T>): Promise<T> {
    return this.db.$transaction((tx) =>
      fn({
        users: new PrismaUserRepository(tx as unknown as PrismaClient),
        ledger: new PrismaLedger(tx as unknown as PrismaClient),
        matches: new PrismaMatchesRepository(tx as unknown as PrismaClient),
        withdrawals: new PrismaWithdrawals(tx as unknown as PrismaClient),
        tournaments: new PrismaTournaments(tx as unknown as PrismaClient),
        // admin-5: the AdminAction audit insert shares the tx so a balance mutation
        // can't commit without its audit row.
        audit: new PrismaAdminAudit(tx as unknown as PrismaClient),
        // deposit-cap fix: a per-user transaction-scoped advisory lock so concurrent
        // capped deposits serialize across instances (auto-released at commit/rollback).
        advisoryXactLock: async (key: string) => {
          await (tx as unknown as PrismaClient).$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        },
      }),
    );
  }
}

export interface PrismaStores {
  users: PrismaUserRepository;
  ledger: PrismaLedger;
  matches: PrismaMatchesRepository;
  withdrawals: PrismaWithdrawals;
  intents: PrismaDepositIntents;
  friends: PrismaFriends;
  refreshTokens: PrismaRefreshTokens;
  adminAudit: PrismaAdminAudit;
  games: PrismaGames;
  seasons: PrismaSeasonRepository;
  matchActions: PrismaMatchActions;
  support: PrismaSupport;
  suspicion: PrismaSuspicion;
  pushSubscriptions: PrismaPushSubscriptions;
  chat: PrismaChat;
  clubs: PrismaClubs;
  tournaments: PrismaTournaments;
  verificationTokens: PrismaVerificationTokens;
  uow: PrismaUnitOfWork;
}

export class PrismaTournaments implements TournamentRepository {
  constructor(private readonly db: PrismaClient) {}
  private map(row: any): Tournament {
    return {
      id: row.id, name: row.name, buyInCents: row.buyInCents, capacity: row.capacity,
      status: row.status, playerIds: (row.playerIds as string[]) ?? [], bracket: (row.bracket as BracketMatch[]) ?? [],
      prizePoolCents: row.prizePoolCents, rakeBps: row.rakeBps, winnerId: row.winnerId ?? null,
      pendingWinnerId: row.pendingWinnerId ?? null, reportedByAdminId: row.reportedByAdminId ?? null,
      clubId: row.clubId ?? null,
      createdAt: ms(row.createdAt),
    };
  }
  async create(t: Tournament): Promise<void> {
    await this.db.tournament.create({
      data: { id: t.id, name: t.name, buyInCents: t.buyInCents, capacity: t.capacity, status: t.status, playerIds: t.playerIds, bracket: t.bracket as any, prizePoolCents: t.prizePoolCents, rakeBps: t.rakeBps, winnerId: t.winnerId, pendingWinnerId: t.pendingWinnerId, reportedByAdminId: t.reportedByAdminId, clubId: t.clubId },
    });
  }
  async get(id: string): Promise<Tournament | null> {
    const row = await this.db.tournament.findUnique({ where: { id } });
    return row ? this.map(row) : null;
  }
  // GLOBAL only (clubId null) — club tournaments are listed via listByClub, never leaked here.
  async list(): Promise<Tournament[]> {
    const rows = await this.db.tournament.findMany({ where: { clubId: null }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r: any) => this.map(r));
  }
  async listByClub(clubId: string): Promise<Tournament[]> {
    const rows = await this.db.tournament.findMany({ where: { clubId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r: any) => this.map(r));
  }
  // EVERY tournament (global + club) — for sweepStale's stranded-money safety net.
  async listAll(): Promise<Tournament[]> {
    const rows = await this.db.tournament.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r: any) => this.map(r));
  }
  async save(t: Tournament): Promise<void> {
    await this.db.tournament.update({
      where: { id: t.id },
      data: { status: t.status, playerIds: t.playerIds, bracket: t.bracket as any, prizePoolCents: t.prizePoolCents, winnerId: t.winnerId, pendingWinnerId: t.pendingWinnerId, reportedByAdminId: t.reportedByAdminId },
    });
  }
}

export function createPrismaStores(db: PrismaClient): PrismaStores {
  return {
    users: new PrismaUserRepository(db),
    ledger: new PrismaLedger(db),
    matches: new PrismaMatchesRepository(db),
    withdrawals: new PrismaWithdrawals(db),
    intents: new PrismaDepositIntents(db),
    friends: new PrismaFriends(db),
    refreshTokens: new PrismaRefreshTokens(db),
    adminAudit: new PrismaAdminAudit(db),
    games: new PrismaGames(db),
    seasons: new PrismaSeasonRepository(db),
    matchActions: new PrismaMatchActions(db),
    support: new PrismaSupport(db),
    suspicion: new PrismaSuspicion(db),
    pushSubscriptions: new PrismaPushSubscriptions(db),
    chat: new PrismaChat(db),
    clubs: new PrismaClubs(db),
    tournaments: new PrismaTournaments(db),
    verificationTokens: new PrismaVerificationTokens(db),
    uow: new PrismaUnitOfWork(db),
  };
}
