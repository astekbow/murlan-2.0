// ============================================================================
// MURLAN — Match money settlement (Phase 6)
// ----------------------------------------------------------------------------
// Escrow each player's stake into a pot at match start; pay the winning side
// (pot − rake) and record the house rake at match end; refund on cancel. Every
// movement goes through WalletService (ledger + balance). Idempotent per match.
//
// ATOMICITY: each of escrow()/settle()/refund() performs MULTIPLE wallet
// movements PLUS a match-status write. They run inside ONE UnitOfWork
// transaction (Prisma → all writes commit or roll back together), so a
// mid-operation crash/error can never leave a partially-settled match (some
// winners paid, others not, status still 'active'). The in-memory stores are
// synchronously atomic and run directly. The per-match conservation invariant
// (WalletService.matchLedgerSums() == 0 for a closed match) guards against drift.
//
// CRASH RECOVERY: all live match/room/timer state is in-memory. If the process
// dies after escrow but before settlement, the DB match row stays 'active' with
// stakes debited. recoverOrphanedMatches() (run at boot + periodically) refunds
// every 'active' match that no live room still owns.
// ============================================================================

import type { MatchType } from '@murlan/shared';
import { WalletService, InsufficientFundsError } from './walletService.ts';
import type { MatchesRepository, MatchPlayer } from './matchesRepository.ts';
import type { UnitOfWork } from './unitOfWork.ts';
import { computeSettlement, potCents, type Settlement } from './settlement.ts';

export interface EscrowResult {
  ok: boolean;
  potCents: number;
  code?: string;
  message?: string;
  insufficientUserIds?: string[];
}

export class MoneyService {
  // Synchronous claim set: prevents two overlapping settle/refund calls for the
  // same match (e.g. a room:leave forfeit racing a timer forfeit) from both
  // passing the async status check before either commits. Claimed BEFORE any
  // await; released in a finally. (The Prisma impl would instead rely on a
  // row-level lock / transaction.)
  private inFlight = new Set<string>();

  constructor(
    private readonly wallet: WalletService,
    private readonly matches: MatchesRepository,
    // When provided (Prisma), escrow/settle/refund each run in ONE transaction:
    // the bound wallet pays + the bound matches repo flips status, atomically.
    private readonly uow?: UnitOfWork,
  ) {}

  /**
   * Run `fn` with a wallet + matches repo that share one transaction. With a UoW
   * (Prisma) all writes inside commit/roll back together; without one (in-memory)
   * the synchronous repos are already atomic, so run directly.
   */
  private runAtomic<T>(fn: (wallet: WalletService, matches: MatchesRepository) => Promise<T>): Promise<T> {
    if (this.uow) return this.uow.transaction((ctx) => fn(this.wallet.bind(ctx), ctx.matches));
    return fn(this.wallet, this.matches);
  }

  /**
   * Debit each player's stake into the pot. Pre-checks all balances first so a
   * partial debit can never happen. Idempotent: re-escrowing an existing match
   * returns its pot without debiting again. A zero stake is a free match.
   */
  async escrow(input: {
    matchId: string;
    type: MatchType;
    stakeCents: number;
    rakeBps: number;
    players: MatchPlayer[];
  }): Promise<EscrowResult> {
    const { matchId, type, stakeCents, rakeBps, players } = input;

    if (this.inFlight.has(matchId)) {
      return { ok: false, potCents: potCents(stakeCents, players.length), code: 'busy', message: 'Escrow tashmë në proces.' };
    }
    this.inFlight.add(matchId);
    try {
      return await this.escrowLocked(matchId, type, stakeCents, rakeBps, players);
    } finally {
      this.inFlight.delete(matchId);
    }
  }

  private async escrowLocked(
    matchId: string,
    type: MatchType,
    stakeCents: number,
    rakeBps: number,
    players: MatchPlayer[],
  ): Promise<EscrowResult> {
    const existing = await this.matches.find(matchId);
    if (existing) return { ok: true, potCents: existing.potCents };

    const pot = potCents(stakeCents, players.length);

    // Advisory pre-check first (nice UX, and avoids opening a transaction we then
    // can't fund): report everyone who can't afford the stake.
    if (stakeCents > 0) {
      const insufficient: string[] = [];
      for (const p of players) {
        if ((await this.wallet.getBalance(p.userId)) < stakeCents) insufficient.push(p.userId);
      }
      if (insufficient.length > 0) {
        return { ok: false, potCents: pot, code: 'insufficient_funds', message: 'Bilanc i pamjaftueshëm për bastin.', insufficientUserIds: insufficient };
      }
    }

    // Create the match row + debit every stake in ONE transaction. The ledger's
    // matchId is a FK to matches.id, so the row must exist before any stake row.
    // If a debit fails (a balance dropped since the pre-check), throwing rolls
    // back the create AND every prior debit — the attempt nets to exactly zero
    // (a retry gets a fresh matchId). A zero-stake free match just creates its row.
    try {
      await this.runAtomic(async (wallet, matches) => {
        await matches.create({ id: matchId, type, stakeCents, rakeBps, potCents: pot, players });
        if (stakeCents > 0) {
          for (const p of players) {
            await wallet.debit(p.userId, stakeCents, { type: 'bet', matchId, reason: 'stake' });
          }
        }
      });
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        return { ok: false, potCents: pot, code: 'insufficient_funds', message: 'Bilanc i pamjaftueshëm për bastin.', insufficientUserIds: [e.userId] };
      }
      throw e;
    }

    return { ok: true, potCents: pot };
  }

  /**
   * Pay the winning side (pot − rake) and book the house rake. Idempotent: only
   * an 'active' match settles. Returns the settlement, or null if already closed.
   */
  async settle(input: { matchId: string; winnerSeats: number[] }): Promise<Settlement | null> {
    if (this.inFlight.has(input.matchId)) return null; // a concurrent settle/refund is running
    this.inFlight.add(input.matchId);
    try {
      const record = await this.matches.find(input.matchId);
      if (!record || record.status !== 'active') return null;

      const seatToUser = new Map(record.players.map((p) => [p.seat, p.userId]));
      const winnerSeats = input.winnerSeats.filter((s) => seatToUser.has(s));
      if (winnerSeats.length === 0) return null;

      const settlement = computeSettlement({ potCents: record.potCents, rakeBps: record.rakeBps, winnerSeats });

      // Pay all winners + book rake + flip status to 'settled' atomically. A
      // crash/error mid-way rolls EVERYTHING back (status stays 'active'), and a
      // retry re-runs cleanly — deterministic providerRefs make each credit
      // at-most-once, so no winner is ever double-paid.
      await this.runAtomic(async (wallet, matches) => {
        if (record.potCents > 0) {
          for (const payout of settlement.payouts) {
            const userId = seatToUser.get(payout.seat)!;
            if (payout.amountCents > 0) {
              await wallet.credit(userId, payout.amountCents, {
                type: 'payout', matchId: record.id, reason: 'winnings',
                providerRef: `payout:${record.id}:${payout.seat}`,
              });
            }
          }
          if (settlement.rakeCents > 0) await wallet.recordRake(settlement.rakeCents, { matchId: record.id, providerRef: `rake:${record.id}` });
        }
        await matches.markSettled(record.id, winnerSeats);
      });
      return settlement;
    } finally {
      this.inFlight.delete(input.matchId);
    }
  }

  /** Return every player's stake (no rake) and cancel the match. Idempotent. */
  async refund(matchId: string): Promise<void> {
    if (this.inFlight.has(matchId)) return;
    this.inFlight.add(matchId);
    try {
      const record = await this.matches.find(matchId);
      if (!record || record.status !== 'active') return;
      // Refund all stakes + cancel the match atomically (deterministic
      // providerRefs keep each refund at-most-once across retries).
      await this.runAtomic(async (wallet, matches) => {
        if (record.stakeCents > 0) {
          for (const p of record.players) {
            await wallet.credit(p.userId, record.stakeCents, {
              type: 'payout', matchId: record.id, reason: 'refund',
              providerRef: `refund:${record.id}:${p.seat}`,
            });
          }
        }
        await matches.markCancelled(record.id);
      });
    } finally {
      this.inFlight.delete(matchId);
    }
  }

  /**
   * Crash recovery: refund every 'active' match the live server no longer owns.
   * At boot `liveMatchIds` is empty, so all active rows (orphaned by a crash) are
   * refunded; run periodically, pass the currently-live match ids so in-progress
   * matches are left alone. refund() is idempotent, so this is safe to repeat.
   * Returns the ids it refunded.
   */
  async recoverOrphanedMatches(liveMatchIds: ReadonlySet<string> = new Set()): Promise<string[]> {
    const active = await this.matches.listActive();
    const refunded: string[] = [];
    for (const m of active) {
      if (liveMatchIds.has(m.id)) continue;
      await this.refund(m.id);
      refunded.push(m.id);
    }
    return refunded;
  }
}

/**
 * Who collects the pot when `abandonerSeat` forfeits mid-match.
 *   1v1   → the other player.
 *   2v2   → the opposing team (the two seats not on the abandoner's team).
 *   1v1v1 → the two remaining players split the pot (no single "opponent").
 */
export function forfeitWinners(
  type: MatchType,
  players: MatchPlayer[],
  abandonerSeat: number,
  teams: [number[], number[]],
): number[] {
  const seats = players.map((p) => p.seat);
  if (type === '2v2') {
    const abandonerTeam = teams[0].includes(abandonerSeat) ? 0 : 1;
    return teams[abandonerTeam === 0 ? 1 : 0].filter((s) => seats.includes(s));
  }
  return seats.filter((s) => s !== abandonerSeat);
}
