// ============================================================================
// MURLAN — Club War service (round-robin series, real-money OR free)
// ----------------------------------------------------------------------------
// register → ESCROW each buy-in into the pool → when both rosters fill, pair every
// A-player vs every B-player → the gateway runs each 1v1 + reports the winner →
// tally club wins → on the last pairing, SPLIT the pool (minus rake) among the
// WINNING club's roster, or REFUND everyone on a tie. Cancel refunds all.
//
// Pure logic + an abstract wallet interface (no realtime/io) → the money math is
// unit-tested in isolation. Mirrors tournamentService's guarantees: per-war
// serialization (no double-debit), escrow-before-roster, idempotent settle.
// ============================================================================

import { randomBytes } from 'node:crypto';
import type { ClubWar, ClubWarRepository, ClubWarStatus } from './clubWarRepository.ts';
import type { UnitOfWork, WalletTxContext } from '../money/unitOfWork.ts';

export class ClubWarError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ClubWarError';
  }
}

/** Minimal wallet the war needs (keeps it decoupled from WalletService). Only used when
 *  stakeCents > 0 (a free war moves no money). `payoutSplit` pays each winner their share
 *  AND records the house rake — atomically in prod (one tx) so a crash can't pay the prize
 *  but lose the rake. */
export interface ClubWarWallet {
  // `ctx` (when register opened an outer tx) → escrow on the SAME tx as the war-row write (audit M2).
  debit(userId: string, amountCents: number, reason: string, ctx?: WalletTxContext): Promise<void>;  // buy-in escrow
  credit(userId: string, amountCents: number, reason: string): Promise<void>; // refund
  payoutSplit(winners: Array<{ userId: string; amountCents: number }>, rakeCents: number, ref: string): Promise<void>;
}

const MAX_SIZE = 5; // roster cap per club → at most 25 pairings

export class ClubWarService {
  // Serialize register/report/cancel per war so concurrent calls can't double-debit or
  // corrupt the pool/score (mirrors tournamentService.withLock + WalletService.serialize).
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repo: ClubWarRepository,
    private readonly rakeBps: number,
    private readonly wallet?: ClubWarWallet, // required only for paid wars
    // Present in prod (Prisma): wraps the buy-in escrow + the war-row write in ONE $transaction
    // (audit M2). Absent in-memory (single-threaded) → the compensating-refund fallback is used.
    private readonly uow?: UnitOfWork,
  ) {}

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(id, run.catch(() => undefined));
    try { return await run; } finally { if (this.locks.get(id) === run.catch(() => undefined)) { /* noop */ } }
  }

  /** Create a war: clubA (challenger) vs clubB, `size` players per side, free (0) or buy-in. */
  async create(clubAId: string, clubBId: string, stakeCents: number, size: number): Promise<ClubWar> {
    if (clubAId === clubBId) throw new ClubWarError('same_club', 'Një klub s’luan kundër vetes.');
    if (stakeCents < 0) throw new ClubWarError('bad_stake', 'Bast i pavlefshëm.');
    if (stakeCents > 0 && !this.wallet) throw new ClubWarError('no_wallet', 'Bastet s’janë aktive.');
    const n = Math.floor(size);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SIZE) throw new ClubWarError('bad_size', `Madhësia duhet 1–${MAX_SIZE}.`);
    const war: ClubWar = {
      id: `war_${randomBytes(8).toString('hex')}`,
      clubAId, clubBId, status: 'registering', stakeCents: Math.floor(stakeCents), rakeBps: this.rakeBps,
      size: n, rosterA: [], rosterB: [], pairings: [], scoreA: 0, scoreB: 0,
      prizePoolCents: 0, winnerClubId: null, createdAt: Date.now(),
    };
    return this.repo.create(war);
  }

  /** Register a player on a side; escrows their buy-in. Auto-starts when BOTH rosters fill. */
  async register(warId: string, userId: string, side: 'A' | 'B'): Promise<ClubWar> {
    return this.withLock(warId, async () => {
      const w = await this.repo.get(warId);
      if (!w) throw new ClubWarError('not_found', 'Lufta nuk u gjet.');
      if (w.status !== 'registering') throw new ClubWarError('closed', 'Regjistrimi është mbyllur.');
      if (w.rosterA.includes(userId) || w.rosterB.includes(userId)) throw new ClubWarError('already', 'Je regjistruar tashmë.');
      const roster = side === 'A' ? w.rosterA : w.rosterB;
      if (roster.length >= w.size) throw new ClubWarError('full', 'Skuadra është plot.');
      const buyInRef = `clubwar:${w.id}:buyin:${userId}`;
      // Seat the player + grow the pool, and (when full) generate pairings. Mutates `w` in place;
      // `w` is re-read from the repo on every call, so a rolled-back tx leaves no stale state.
      const seat = () => {
        roster.push(userId);
        w.prizePoolCents += w.stakeCents;
        if (w.rosterA.length >= w.size && w.rosterB.length >= w.size) this.begin(w);
      };
      if (this.uow && w.stakeCents > 0) {
        // ATOMIC (audit M2): the escrow debit + the war-row write commit (or roll back) together. If
        // the debit fails (insufficient funds) the row write never runs; if the row write fails the
        // debit rolls back — never a trapped buy-in. Mirrors tournamentService's uow path (SCH-3).
        await this.uow.transaction(async (ctx) => {
          await this.wallet!.debit(userId, w.stakeCents, buyInRef, ctx);
          seat();
          await ctx.clubWars.save(w);
        });
      } else {
        // No uow (in-memory/single-threaded) or a free war: escrow BEFORE seating (a failed debit →
        // insufficient funds → no seat), then persist with a COMPENSATING REFUND if the persist
        // throws — so a debited player is never left unseated with a trapped buy-in.
        if (w.stakeCents > 0) await this.wallet!.debit(userId, w.stakeCents, buyInRef);
        try {
          seat();
          await this.repo.save(w);
        } catch (e) {
          if (w.stakeCents > 0) await this.wallet!.credit(userId, w.stakeCents, `clubwar:${w.id}:buyin-rollback:${userId}`).catch(() => undefined);
          throw e;
        }
      }
      return w;
    });
  }

  /** Founder force-starts with the current rosters (≥1 each), before both fill. */
  async start(warId: string): Promise<ClubWar> {
    return this.withLock(warId, async () => {
      const w = await this.repo.get(warId);
      if (!w) throw new ClubWarError('not_found', 'Lufta nuk u gjet.');
      if (w.status !== 'registering') throw new ClubWarError('not_registering', 'Lufta s’është në regjistrim.');
      if (w.rosterA.length === 0 || w.rosterB.length === 0) throw new ClubWarError('empty_side', 'Të dy klubet duhet të kenë lojtarë.');
      this.begin(w);
      await this.repo.save(w);
      return w;
    });
  }

  /** Generate the round-robin pairings (every A vs every B) and flip to running. */
  private begin(w: ClubWar): void {
    w.pairings = [];
    for (const a of w.rosterA) for (const b of w.rosterB) w.pairings.push({ aUserId: a, bUserId: b, winnerId: null });
    w.status = 'running';
  }

  /** Record a pairing's winner (the gateway reports it from the 1v1 result), tally the
   *  club score, and SETTLE when every pairing is decided. Idempotent per pairing. */
  async reportResult(warId: string, aUserId: string, bUserId: string, winnerId: string): Promise<ClubWar> {
    return this.withLock(warId, async () => {
      const w = await this.repo.get(warId);
      if (!w) throw new ClubWarError('not_found', 'Lufta nuk u gjet.');
      if (w.status !== 'running') throw new ClubWarError('not_running', 'Lufta s’është aktive.');
      const p = w.pairings.find((x) => x.aUserId === aUserId && x.bUserId === bUserId);
      if (!p) throw new ClubWarError('no_pairing', 'Çifti nuk ekziston.');
      if (p.winnerId) return w; // already decided → idempotent no-op
      if (winnerId !== aUserId && winnerId !== bUserId) throw new ClubWarError('bad_winner', 'Fituesi s’është në këtë çift.');
      p.winnerId = winnerId;
      if (winnerId === aUserId) w.scoreA += 1; else w.scoreB += 1;
      if (w.pairings.every((x) => x.winnerId)) {
        // ORDER MATTERS (money safety). Decide the winner → persist the ALL-DECIDED 'running' state →
        // pay out → only THEN flip to 'finished'. Rationale (audit 2026-07-05): the OLD order (persist
        // 'finished' BEFORE the payout) meant a payout failure left the war durably 'finished' but
        // UNPAID — and the sweep only re-drives 'registering'/'running' wars, so the escrowed pool was
        // stranded with NO recovery path. With this order, a payout failure/crash leaves the row
        // 'running' with every pairing decided IN DB — exactly the state sweepStaleWars re-drives
        // (idempotent payoutSettled). A 'finished' war is therefore ALWAYS a paid war. Anti-double-pay
        // still holds: cancel() is 'registering'-only (rejects a 'running' all-decided war), and the
        // sweep's refund branch fires only for a war that is NOT all-decided — which this state never is.
        this.decideWinner(w); // winnerClubId in memory (needed by the payout); status stays 'running'
        await this.repo.save(w); // (1) persist the final pairing decision + winner, still 'running'
        await this.payoutSettled(w); // (2) move the money (idempotent providerRefs → safe to re-run)
        w.status = 'finished'; // (3) flip to finished ONLY after a successful payout
        await this.repo.save(w); // (3b) persist 'finished'
      } else {
        await this.repo.save(w);
      }
      return w;
    });
  }

  /** Compute the winning club (pure, no money, NO status change): higher score wins; equal → tie (null).
   *  The caller flips status to 'finished' only AFTER payoutSettled succeeds, so a 'finished' war is
   *  always a PAID war (audit 2026-07-05) and a failed payout stays recoverable by the sweep. */
  private decideWinner(w: ClubWar): void {
    w.winnerClubId = w.scoreA > w.scoreB ? w.clubAId : w.scoreB > w.scoreA ? w.clubBId : null;
  }

  /** Move the money for an already-decided war. Tie → refund all; else split pool minus rake.
   *  All credits use idempotent providerRefs, so this is safe to re-run (sweep/retry). */
  private async payoutSettled(w: ClubWar): Promise<void> {
    if (w.stakeCents === 0 || w.prizePoolCents === 0) return; // free war — nothing to settle
    if (!w.winnerClubId) {
      // Tie → refund every participant their buy-in (no rake on a void result).
      await this.refundAll(w);
      return;
    }
    const winners = w.winnerClubId === w.clubAId ? w.rosterA : w.rosterB;
    let rake = Math.floor((w.prizePoolCents * w.rakeBps) / 10000);
    const prize = w.prizePoolCents - rake;
    const per = Math.floor(prize / winners.length);
    rake += prize - per * winners.length; // integer remainder → house (keeps cents exact)
    await this.wallet!.payoutSplit(winners.map((userId) => ({ userId, amountCents: per })), rake, `clubwar:${w.id}:payout`);
  }

  /**
   * Cancel a war (challenger founder) — refunds all escrowed buy-ins. ONLY before play starts.
   * Once 'running', cancel is forbidden: it would (a) let a losing side void an adverse result and
   * (b) race the settle() payout into a double-pay (refund + prize). A war stuck 'running' after a
   * crash is recovered by sweepStaleWars(), NOT by user cancel.
   */
  async cancel(warId: string): Promise<ClubWar> {
    return this.withLock(warId, async () => {
      const w = await this.repo.get(warId);
      if (!w) throw new ClubWarError('not_found', 'Lufta nuk u gjet.');
      if (w.status !== 'registering') throw new ClubWarError('not_cancellable', 'Lufta nuk anulohet pasi ka filluar.');
      await this.refundAll(w);
      w.status = 'cancelled';
      await this.repo.save(w);
      return w;
    });
  }

  private async refundAll(w: ClubWar): Promise<void> {
    if (w.stakeCents === 0) return;
    // Per-user ref so each refund is idempotent on its own (a shared ref would collide and
    // only refund the first player). Distinct from the buy-in/payout refs.
    for (const userId of [...w.rosterA, ...w.rosterB]) {
      await this.wallet!.credit(userId, w.stakeCents, `clubwar:${w.id}:refund:${userId}`);
    }
  }

  /**
   * Recover money stranded in abandoned/stuck wars (cancel is now registering-only, so a war that
   * never starts — or crashes mid-settle — can't be cleared by a user). Idempotent + safe:
   *  • registering, or running with any UNPLAYED pairing → no payout has happened (settle only runs
   *    when EVERY pairing is decided) → void + refundAll (per-user idempotent refs).
   *  • running with ALL pairings decided → it should have settled but the save/payout was interrupted
   *    → finish it (decide + save + idempotent payout). NEVER refund these (winners may already hold the prize).
   * Returns the swept war ids.
   */
  async sweepStaleWars(maxAgeMs: number): Promise<string[]> {
    const cutoff = Date.now() - maxAgeMs;
    const active = await this.repo.listActive();
    const swept: string[] = [];
    for (const snap of active) {
      if (snap.createdAt > cutoff) continue;
      await this.withLock(snap.id, async () => {
        const w = await this.repo.get(snap.id); // re-read under the lock
        if (!w || (w.status !== 'registering' && w.status !== 'running')) return;
        if (w.status === 'running' && w.pairings.length > 0 && w.pairings.every((p) => p.winnerId)) {
          // The war reached the all-decided state but its settle was interrupted (payout failed/crashed
          // mid-report, or a prior sweep pass). Re-drive the payout (idempotent providerRefs), then flip
          // to 'finished' — persisting 'finished' only AFTER a successful payout keeps a failed retry
          // 'running' so the NEXT sweep re-drives it (no more finished-but-unpaid stranded escrow).
          this.decideWinner(w);
          await this.payoutSettled(w); // idempotent — safe even if a prior settle partially ran
          w.status = 'finished';
          await this.repo.save(w);
        } else {
          await this.refundAll(w);
          w.status = 'cancelled';
          await this.repo.save(w);
        }
        swept.push(w.id);
      });
    }
    return swept;
  }

  get(warId: string): Promise<ClubWar | null> { return this.repo.get(warId); }
  listForClub(clubId: string, limit = 20): Promise<ClubWar[]> { return this.repo.listForClub(clubId, limit); }
}

export type { ClubWar, ClubWarStatus };
