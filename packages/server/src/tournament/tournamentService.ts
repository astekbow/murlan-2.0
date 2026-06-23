// ============================================================================
// MURLAN — Tournaments (single-elimination, real-money buy-ins)
// ----------------------------------------------------------------------------
// register → ESCROW each buy-in (real wallet debit into the pot) → seed a single-
// elimination bracket when full → run each pairing as a match (the gateway reports
// the winner) → advance → pay the pool MINUS the house rake to the champion.
//
// This module is PURE logic + a money interface (no realtime/io), so the money
// math + bracket advancement are unit-tested in isolation. The gateway wires the
// realtime match-running on top and calls reportResult(). Tournaments are persisted
// (see the repository) so escrowed buy-ins survive a restart.
// ============================================================================

import { randomBytes } from 'node:crypto';
// Type-only (erased at runtime → no import cycle with unitOfWork, which imports our
// TournamentRepository value). Lets escrow + the tournament-row write share one tx.
import type { UnitOfWork, WalletTxContext } from '../money/unitOfWork.ts';

export type TournamentStatus = 'registering' | 'running' | 'awaiting_confirmation' | 'finished' | 'cancelled';

export interface BracketMatch {
  round: number;            // 0 = first round
  index: number;            // position within the round
  aUserId: string | null;
  bUserId: string | null;
  winnerId: string | null;
}

export interface Tournament {
  id: string;
  name: string;
  buyInCents: number;
  capacity: number;         // 2 | 4 | 8
  status: TournamentStatus;
  playerIds: string[];
  bracket: BracketMatch[];
  prizePoolCents: number;   // sum of escrowed buy-ins
  rakeBps: number;          // house cut applied to the pool at payout
  winnerId: string | null;
  // Dual-control: when the final is reported under four-eyes, the champion is parked
  // here (status 'awaiting_confirmation') until a SECOND, distinct admin confirms. Both
  // null otherwise. (Off by default — see TournamentService `dualControl`.)
  pendingWinnerId: string | null;
  reportedByAdminId: string | null;
  createdAt: number;
}

/** Minimal wallet capability the tournament needs (keeps it decoupled from WalletService).
 *  The optional `ctx` lets the service compose the money move into an OUTER transaction
 *  it opened (so escrow/payout commit together with the tournament-row write); when
 *  omitted, the adapter runs the move on its own (its usual single-op path). */
export interface TournamentWallet {
  debit(userId: string, amountCents: number, reason: string, ctx?: WalletTxContext): Promise<void>;  // buy-in escrow
  credit(userId: string, amountCents: number, reason: string): Promise<void>; // refund
  recordRake(amountCents: number, ref: string): Promise<void>;                // house cut (non-payout)
  // Pay the champion AND record the house rake ATOMICALLY (one DB transaction in prod),
  // so a crash between them can't credit the prize but lose the rake — which would
  // break the per-tournament ledger invariant sum(in) == sum(out).
  payoutChampion(winnerId: string, prizeCents: number, rakeCents: number, ref: string, ctx?: WalletTxContext): Promise<void>;
}

export interface TournamentRepository {
  create(t: Tournament): Promise<void>;
  get(id: string): Promise<Tournament | null>;
  list(): Promise<Tournament[]>;
  save(t: Tournament): Promise<void>;
}

export class TournamentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TournamentError';
  }
}

const VALID_CAPACITIES = new Set([2, 4, 8]);

export class TournamentService {
  constructor(
    private readonly repo: TournamentRepository,
    private readonly wallet: TournamentWallet,
    private readonly rakeBps: number,
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => `trn_${randomBytes(6).toString('hex')}`,
    // Present in prod (Prisma): wraps escrow/payout + the tournament-row write in ONE
    // transaction. Absent in-memory (single-threaded → the saga path below is enough).
    private readonly uow?: UnitOfWork,
    // Four-eyes on the champion payout: when true, reporting a PAID final parks the
    // champion (status 'awaiting_confirmation') until a SECOND, distinct admin confirms.
    // Default false — a solo operator has no second admin (it would block every payout);
    // the audit trail + admin-account security are the controls there. Turn on once
    // multiple admins/staff exist.
    private readonly dualControl: boolean = false,
  ) {}

  async list(): Promise<Tournament[]> { return this.repo.list(); }
  async get(id: string): Promise<Tournament | null> { return this.repo.get(id); }

  // ----- Recorded engine outcomes (result reconciliation, admin-4) ------------
  // The SELF-RUNNING gateway records the ACTUAL engine winner of each tournament
  // pairing here as the match concludes. A later MANUAL admin /report for the same
  // pairing is then reconciled against it: a report that CONTRADICTS the recorded
  // engine outcome is REJECTED. This blocks an over-scoped/compromised admin from
  // hand-picking a loser as the "winner" on a pairing the engine already decided.
  // Keyed `tournamentId:round:index` → winnerUserId. Bounded by bracket size; cleared
  // when the tournament finishes/cancels via clearRecordedOutcomes().
  private readonly recordedOutcomes = new Map<string, string>();
  private static outcomeKey(tournamentId: string, round: number, index: number): string {
    return `${tournamentId}:${round}:${index}`;
  }
  /** Record the engine-decided winner of a tournament pairing (called by the gateway
   *  as the live match ends, BEFORE it auto-reports). Idempotent; last write wins. */
  recordRoomOutcome(tournamentId: string, round: number, index: number, winnerUserId: string): void {
    this.recordedOutcomes.set(TournamentService.outcomeKey(tournamentId, round, index), winnerUserId);
  }
  /** The recorded engine winner for a pairing, or undefined if none was recorded. */
  recordedOutcome(tournamentId: string, round: number, index: number): string | undefined {
    return this.recordedOutcomes.get(TournamentService.outcomeKey(tournamentId, round, index));
  }
  private clearRecordedOutcomes(tournamentId: string): void {
    for (const k of this.recordedOutcomes.keys()) if (k.startsWith(`${tournamentId}:`)) this.recordedOutcomes.delete(k);
  }

  // Serialize mutating ops PER tournament (single-instance) so two concurrent
  // register/report/cancel/sweep calls can't race a read-modify-write on the same
  // row (e.g. two registrations both passing the dupe/capacity check before either
  // saves → double-debit / corrupt pool). Mirrors WalletService.serializeDeposit.
  // Multi-instance needs a DB row-lock / optimistic version — documented follow-up.
  private readonly locks = new Map<string, Promise<unknown>>();
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run after prev settles (success OR failure)
    this.locks.set(id, next.catch(() => undefined)); // a rejection must not break the chain
    return next;
  }

  async create(name: string, buyInCents: number, capacity: number): Promise<Tournament> {
    if (!VALID_CAPACITIES.has(capacity)) throw new TournamentError('bad_capacity', 'Kapaciteti duhet të jetë 2, 4 ose 8.');
    if (!Number.isInteger(buyInCents) || buyInCents < 0) throw new TournamentError('bad_buyin', 'Pjesëmarrja e pavlefshme.');
    const t: Tournament = {
      id: this.newId(),
      name: name.trim().slice(0, 40) || 'Turne',
      buyInCents,
      capacity,
      status: 'registering',
      playerIds: [],
      bracket: [],
      prizePoolCents: 0,
      rakeBps: this.rakeBps,
      winnerId: null,
      pendingWinnerId: null,
      reportedByAdminId: null,
      createdAt: this.now(),
    };
    await this.repo.create(t);
    return t;
  }

  /** Register a player; escrows their buy-in. Auto-starts when the bracket fills.
   *  Serialized per tournament (no concurrent double-debit). The escrow debit and the
   *  registration-row write are ATOMIC in prod (one tx, SCH-3) — so a failure can't
   *  leave a debited player with no registration (trapped buy-in). Without a uow
   *  (in-memory/single-threaded) it falls back to escrow-then-save with a compensating
   *  refund if the save fails. */
  async register(tournamentId: string, userId: string): Promise<Tournament> {
    return this.withLock(tournamentId, async () => {
      const t = await this.repo.get(tournamentId);
      if (!t) throw new TournamentError('not_found', 'Turneu nuk u gjet.');
      if (t.status !== 'registering') throw new TournamentError('closed', 'Regjistrimi është mbyllur.');
      // Dupe + capacity are checked BEFORE the debit (and under the lock), so a
      // retry/concurrent call can never escrow a second buy-in for the same player.
      if (t.playerIds.includes(userId)) throw new TournamentError('already_in', 'Je tashmë i regjistruar.');
      if (t.playerIds.length >= t.capacity) throw new TournamentError('full', 'Turneu është plot.');

      // Add the player to the (local) tournament + seed the bracket if this fills it.
      const apply = () => {
        t.playerIds.push(userId);
        t.prizePoolCents += t.buyInCents;
        if (t.playerIds.length === t.capacity) this.seedBracket(t);
      };
      const buyInRef = `tournament buy-in:${t.id}:${userId}`;

      if (this.uow && t.buyInCents > 0) {
        // ATOMIC: escrow debit + the row write commit (or roll back) together. If the
        // debit fails (insufficient funds) the row write never runs; if the row write
        // fails the debit rolls back — never a trapped buy-in.
        await this.uow.transaction(async (ctx) => {
          await this.wallet.debit(userId, t.buyInCents, buyInRef, ctx);
          apply();
          await ctx.tournaments.save(t);
        });
      } else {
        // No uow (in-memory/single-threaded) or a free entry: escrow then persist, with
        // a compensating refund if the persist throws (distinct ref from a cancel-refund).
        if (t.buyInCents > 0) await this.wallet.debit(userId, t.buyInCents, buyInRef);
        try {
          apply();
          await this.repo.save(t);
        } catch (e) {
          if (t.buyInCents > 0) await this.wallet.credit(userId, t.buyInCents, `tournament buyin-rollback:${t.id}:${userId}`).catch(() => undefined);
          throw e;
        }
      }
      return t;
    });
  }

  private seedBracket(t: Tournament): void {
    const matches: BracketMatch[] = [];
    for (let i = 0; i < t.capacity; i += 2) {
      matches.push({ round: 0, index: i / 2, aUserId: t.playerIds[i]!, bUserId: t.playerIds[i + 1]!, winnerId: null });
    }
    t.bracket = matches;
    t.status = 'running';
  }

  /** Record a pairing's winner (admin-reported), then advance the bracket — building the
   *  next round, or finishing + paying out. With dual-control ON, reporting a PAID final
   *  PARKS the champion (status 'awaiting_confirmation') for a second admin instead of
   *  paying immediately; pass `adminId` so the confirmer can be required to differ. */
  async reportResult(tournamentId: string, round: number, index: number, winnerId: string, adminId?: string, opts?: { autoFinalize?: boolean }): Promise<Tournament> {
    return this.withLock(tournamentId, async () => {
      const t = await this.repo.get(tournamentId);
      if (!t) throw new TournamentError('not_found', 'Turneu nuk u gjet.');
      if (t.status !== 'running') throw new TournamentError('not_running', 'Turneu nuk është aktiv.');
      const m = t.bracket.find((x) => x.round === round && x.index === index);
      if (!m) throw new TournamentError('no_match', 'Ndeshja nuk ekziston.');
      if (m.winnerId) throw new TournamentError('already_decided', 'Ndeshja është vendosur tashmë.');
      if (winnerId !== m.aUserId && winnerId !== m.bUserId) throw new TournamentError('bad_winner', 'Fituesi nuk është në këtë ndeshje.');
      // Result reconciliation (admin-4): a MANUAL admin report must NOT contradict the
      // engine outcome the gateway already recorded for this pairing. The trusted
      // self-running path (autoFinalize) is exempt — it IS the source of that outcome.
      // If no engine outcome was recorded (a genuinely stuck/disputed pairing), the
      // admin override proceeds as before.
      if (!opts?.autoFinalize) {
        const recorded = this.recordedOutcome(tournamentId, round, index);
        if (recorded && recorded !== winnerId) {
          throw new TournamentError('result_conflict', 'Fituesi i raportuar bie ndesh me rezultatin e regjistruar të ndeshjes.');
        }
      }
      m.winnerId = winnerId;

      const roundMatches = t.bracket.filter((x) => x.round === round).sort((a, b) => a.index - b.index);
      if (roundMatches.every((x) => x.winnerId)) {
        if (roundMatches.length === 1) {
          const champion = roundMatches[0]!.winnerId!;
          // `autoFinalize` (the SELF-RUNNING gateway path) bypasses four-eyes: a
          // self-running final has NO admin in the loop to confirm, so parking it would
          // strand the pool forever. Four-eyes still applies to the manual /report route.
          if (this.dualControl && t.buyInCents > 0 && !opts?.autoFinalize) {
            // Four-eyes: park the champion for a SECOND admin to confirm; no money moves
            // yet. The final-match winnerId is already set + persisted below, so the
            // bracket is intact; only the payout waits. (Free finals skip this — no money.)
            t.status = 'awaiting_confirmation';
            t.pendingWinnerId = champion;
            t.reportedByAdminId = adminId ?? null;
            await this.repo.save(t);
            return t;
          }
          // Final decided → pay the champion AND persist the finished status ATOMICALLY
          // (see finish()), then return. We must NOT fall through to the trailing save:
          // finish() already persisted, and a second (non-tx) save could land AFTER the
          // payout, re-opening the very "paid but row still 'running'" window we close.
          await this.finish(t, champion);
          return t;
        }
        for (let i = 0; i < roundMatches.length; i += 2) {
          t.bracket.push({
            round: round + 1,
            index: i / 2,
            aUserId: roundMatches[i]!.winnerId!,
            bUserId: roundMatches[i + 1]!.winnerId!,
            winnerId: null,
          });
        }
      }
      await this.repo.save(t);
      return t;
    });
  }

  /** Dual-control: a SECOND, distinct admin confirms a parked champion → pays out. Only
   *  valid while 'awaiting_confirmation'; the confirmer must differ from the admin who
   *  reported the final (four-eyes). The payout is atomic via finish(). */
  async confirmChampion(tournamentId: string, confirmingAdminId: string): Promise<Tournament> {
    return this.withLock(tournamentId, async () => {
      const t = await this.repo.get(tournamentId);
      if (!t) throw new TournamentError('not_found', 'Turneu nuk u gjet.');
      if (t.status !== 'awaiting_confirmation' || !t.pendingWinnerId) {
        throw new TournamentError('not_awaiting', 'Turneu nuk është në pritje konfirmimi.');
      }
      if (t.reportedByAdminId && t.reportedByAdminId === confirmingAdminId) {
        throw new TournamentError('same_admin', 'Një administrator i DYTË duhet ta konfirmojë pagesën.');
      }
      const champion = t.pendingWinnerId;
      t.pendingWinnerId = null;
      t.reportedByAdminId = null;
      await this.finish(t, champion); // atomic payout + status=finished
      return t;
    });
  }

  /** Finish + pay the champion. The prize+rake payout AND the finished-status row write
   *  commit (or roll back) in ONE transaction in prod (SCH-3) — closing the window where
   *  a payout commits but the row stays 'running', which a later stale-sweep would wrongly
   *  refund (double-pay). Prize + rake are themselves atomic via payoutChampion. */
  private async finish(t: Tournament, winnerId: string): Promise<void> {
    t.winnerId = winnerId;
    t.status = 'finished';
    this.clearRecordedOutcomes(t.id); // bracket done — drop its recorded pairing outcomes
    const rake = Math.floor((t.prizePoolCents * t.rakeBps) / 10000);
    const prize = t.prizePoolCents - rake;
    if (this.uow) {
      await this.uow.transaction(async (ctx) => {
        await this.wallet.payoutChampion(winnerId, prize, rake, t.id, ctx);
        await ctx.tournaments.save(t);
      });
    } else {
      // In-memory/single-threaded: sequential is enough (no real rollback available).
      await this.wallet.payoutChampion(winnerId, prize, rake, t.id);
      await this.repo.save(t);
    }
  }

  /** Cancel a tournament and REFUND every escrowed buy-in. Works while REGISTERING
   *  or RUNNING (admin force-void of an abandoned/disputed bracket) — only a
   *  finished/already-cancelled tournament is off-limits. Until a champion is paid
   *  (which only happens at finish), the whole pool is still escrowed, so refunding
   *  every player exactly returns it. Refund refs are idempotent + lock-guarded, so
   *  this can't race a concurrent report or double-refund. */
  async cancel(tournamentId: string): Promise<Tournament> {
    return this.withLock(tournamentId, async () => {
      const t = await this.repo.get(tournamentId);
      if (!t) throw new TournamentError('not_found', 'Turneu nuk u gjet.');
      if (t.status === 'finished' || t.status === 'cancelled') {
        throw new TournamentError('not_cancellable', 'Turneu ka përfunduar ose është anuluar tashmë.');
      }
      if (t.buyInCents > 0) for (const uid of t.playerIds) await this.wallet.credit(uid, t.buyInCents, `tournament refund:${t.id}:${uid}`);
      t.status = 'cancelled';
      t.prizePoolCents = 0;
      this.clearRecordedOutcomes(t.id);
      await this.repo.save(t);
      return t;
    });
  }

  /**
   * Safety net for stranded money (audit 2026-06-08, finding C4): tournaments are
   * advanced manually by an admin and have no realtime auto-run, so a forgotten /
   * disputed / crashed one can sit in 'registering', 'running', or 'awaiting_confirmation'
   * holding escrowed buy-ins forever. This refunds + voids any such tournament older than
   * `maxAgeMs` (a parked-but-never-confirmed champion is voided → all buy-ins refunded, the
   * conservative outcome). Idempotent (per-player refund refs) and lock-guarded so it never
   * double-refunds or races a concurrent report/confirm/cancel. Returns the ids it voided.
   */
  private static readonly SWEEPABLE: ReadonlySet<TournamentStatus> = new Set(['registering', 'running', 'awaiting_confirmation']);
  async sweepStale(maxAgeMs: number): Promise<string[]> {
    const cutoff = this.now() - maxAgeMs;
    const all = await this.repo.list();
    const voided: string[] = [];
    for (const snap of all) {
      if (!TournamentService.SWEEPABLE.has(snap.status)) continue;
      if (snap.createdAt > cutoff) continue;
      await this.withLock(snap.id, async () => {
        const t = await this.repo.get(snap.id); // re-read under the lock
        if (!t || !TournamentService.SWEEPABLE.has(t.status)) return;
        if (t.buyInCents > 0) for (const uid of t.playerIds) await this.wallet.credit(uid, t.buyInCents, `tournament refund:${t.id}:${uid}`);
        t.status = 'cancelled';
        t.prizePoolCents = 0;
        await this.repo.save(t);
        voided.push(t.id);
      });
    }
    return voided;
  }
}

/** In-memory tournament store (used in dev/tests; Prisma mirrors it in prod). Clones
 *  on read/write so callers never mutate stored state by reference. */
export class InMemoryTournamentRepository implements TournamentRepository {
  private map = new Map<string, Tournament>();
  async create(t: Tournament): Promise<void> { this.map.set(t.id, structuredClone(t)); }
  async get(id: string): Promise<Tournament | null> { const t = this.map.get(id); return t ? structuredClone(t) : null; }
  async list(): Promise<Tournament[]> { return [...this.map.values()].map((t) => structuredClone(t)); }
  async save(t: Tournament): Promise<void> { this.map.set(t.id, structuredClone(t)); }
}
