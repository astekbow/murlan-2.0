// ============================================================================
// MURLAN — Prisma/PostgreSQL repository adapters (spec §11)
// ----------------------------------------------------------------------------
// Implement the SAME repository interfaces the services use, so swapping in
// Postgres requires no change to AuthService/WalletService/MoneyService/etc.
// `balanceCents` adjustments are conditional single-statement updates (no
// overdraw race). NOTE: WalletService.credit/debit perform two repo writes
// (ledger row + balance); in production those should be wrapped in one
// prisma.$transaction — a documented follow-up (see moneyService.ts header).
// ============================================================================

import type { PrismaClient } from '@prisma/client';
import { type User, type NewUser, type UserRepository, type ComplianceUpdate, type KycStatus, type RewardsPatch, DuplicateUserError } from '../auth/userRepository.ts';
import {
  type LedgerRepository, type Transaction, type NewTransaction, type TransactionType, type TransactionStatus,
  DuplicateProviderRefError,
} from '../money/ledger.ts';
import type { MatchesRepository, MatchRecord, NewMatch, MatchStatus } from '../money/matchesRepository.ts';
import type { WithdrawalRepository, WithdrawalRecord, WithdrawalStatus } from '../money/withdrawals.ts';
import type { DepositIntentRepository, DepositIntentRecord } from '../money/depositIntents.ts';
import type { UnitOfWork, WalletTxContext } from '../money/unitOfWork.ts';
import type { FriendsRepository, Friendship } from '../social/friendsRepository.ts';
import type { RefreshTokenRepository, RefreshTokenRecord, NewRefreshToken } from '../auth/refreshTokens.ts';
import type { AdminAuditRepository, AdminActionRecord, NewAdminAction, AdminActionType } from '../auth/adminAudit.ts';
import type { GamesRepository, GameRecord, NewGameRecord } from '../fair/gamesRepository.ts';
import type { VerificationTokenRepository, VerificationTokenRecord, NewVerificationToken, VerificationTokenType } from '../auth/verificationTokens.ts';
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
    balanceCents: row.balanceCents,
    createdAt: ms(row.createdAt),
    tokenVersion: row.tokenVersion ?? 0,
    emailVerified: row.emailVerified ?? false,
    kycStatus: row.kycStatus as KycStatus,
    dateOfBirth: row.dateOfBirth,
    country: row.country,
    selfExcludedUntil: msOrNull(row.selfExcludedUntil),
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

  async updateCompliance(id: string, patch: ComplianceUpdate): Promise<User | null> {
    const data: Record<string, unknown> = {};
    if (patch.kycStatus !== undefined) data.kycStatus = patch.kycStatus;
    if (patch.dateOfBirth !== undefined) data.dateOfBirth = patch.dateOfBirth;
    if (patch.country !== undefined) data.country = patch.country;
    if (patch.selfExcludedUntil !== undefined) data.selfExcludedUntil = patch.selfExcludedUntil ? new Date(patch.selfExcludedUntil) : null;
    const row = await this.db.user.update({ where: { id }, data }).catch(() => null);
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

  async setEmailVerified(id: string, verified: boolean): Promise<void> {
    await this.db.user.update({ where: { id }, data: { emailVerified: verified } }).catch(() => undefined);
  }
  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.db.user.update({ where: { id }, data: { passwordHash } }).catch(() => undefined);
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
    if (!accept) { await this.db.friendship.delete({ where: { id } }).catch(() => undefined); return null; }
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
  async listByUser(userId: string): Promise<Transaction[]> {
    return (await this.db.transaction.findMany({ where: { userId } })).map(toTx);
  }
  async all(): Promise<Transaction[]> {
    return (await this.db.transaction.findMany()).map(toTx);
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
  async markSettled(id: string, winnerSeats: number[]): Promise<void> {
    // winnerSide is a representative seat; full winner set is derivable from match_players + finishingOrder.
    await this.db.match.update({ where: { id }, data: { status: 'settled', winnerSide: winnerSeats[0] ?? null, endedAt: new Date() } });
  }
  async markCancelled(id: string): Promise<void> {
    await this.db.match.update({ where: { id }, data: { status: 'cancelled', endedAt: new Date() } });
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
  };
}

export class PrismaWithdrawals implements WithdrawalRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(r: Omit<WithdrawalRecord, 'id' | 'status' | 'createdAt' | 'resolvedAt'>): Promise<WithdrawalRecord> {
    const row = await this.db.withdrawal.create({ data: { userId: r.userId, amountCents: r.amountCents, destination: r.destination } });
    return toWithdrawal(row);
  }
  async find(id: string): Promise<WithdrawalRecord | null> {
    const row = await this.db.withdrawal.findUnique({ where: { id } });
    return row ? toWithdrawal(row) : null;
  }
  async setStatusIfPending(id: string, status: WithdrawalStatus): Promise<WithdrawalRecord | null> {
    // Atomic compare-and-set: only a 'pending' row transitions. count===0 means
    // it was already resolved (lost the race) → null.
    const res = await this.db.withdrawal.updateMany({ where: { id, status: 'pending' }, data: { status, resolvedAt: new Date() } });
    if (res.count === 0) return null;
    const row = await this.db.withdrawal.findUnique({ where: { id } });
    return row ? toWithdrawal(row) : null;
  }
  async listPending(): Promise<WithdrawalRecord[]> {
    return (await this.db.withdrawal.findMany({ where: { status: 'pending' } })).map(toWithdrawal);
  }
  async listByUser(userId: string): Promise<WithdrawalRecord[]> {
    return (await this.db.withdrawal.findMany({ where: { userId } })).map(toWithdrawal);
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
  async revokeFamily(family: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { family }, data: { revoked: true } });
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
  verificationTokens: PrismaVerificationTokens;
  uow: PrismaUnitOfWork;
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
    verificationTokens: new PrismaVerificationTokens(db),
    uow: new PrismaUnitOfWork(db),
  };
}
