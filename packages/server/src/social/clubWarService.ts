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
  debit(userId: string, amountCents: number, reason: string): Promise<void>;  // buy-in escrow
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
      // Escrow the buy-in BEFORE seating (a failed debit → insufficient funds → no seat). Then
      // persist, with a COMPENSATING REFUND if the persist throws — so a debited player is never
      // left unseated with a trapped buy-in (mirrors tournamentService's non-uow path).
      const buyInRef = `clubwar:${w.id}:buyin:${userId}`;
      if (w.stakeCents > 0) await this.wallet!.debit(userId, w.stakeCents, buyInRef);
      try {
        roster.push(userId);
        w.prizePoolCents += w.stakeCents;
        if (w.rosterA.length >= w.size && w.rosterB.length >= w.size) this.begin(w);
        await this.repo.save(w);
      } catch (e) {
        if (w.stakeCents > 0) await this.wallet!.credit(userId, w.stakeCents, `clubwar:${w.id}:buyin-rollback:${userId}`).catch(() => undefined);
        throw e;
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
        // ORDER MATTERS (money safety): mark the war 'finished' + persist BEFORE moving any money.
        // If the payout then fails, the row is already 'finished' (so cancel() — which only acts on
        // 'registering' — can never refund an already-paid war = no double-pay). The payout uses
        // idempotent providerRefs, so a sweep/retry can safely re-run it. A crash BEFORE save just
        // leaves the last pairing decided in-memory only; the next report re-decides + re-saves.
        this.decideOutcome(w);
        await this.repo.save(w);
        await this.payoutSettled(w);
      } else {
        await this.repo.save(w);
      }
      return w;
    });
  }

  /** Decide the winning club (pure, no money): higher score wins; equal → tie (null). */
  private decideOutcome(w: ClubWar): void {
    w.status = 'finished';
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
          this.decideOutcome(w);
          await this.repo.save(w);
          await this.payoutSettled(w); // idempotent — safe even if a prior settle partially ran
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
