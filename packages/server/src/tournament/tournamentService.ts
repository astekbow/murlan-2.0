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

export type TournamentStatus = 'registering' | 'running' | 'finished' | 'cancelled';

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
  createdAt: number;
}

/** Minimal wallet capability the tournament needs (keeps it decoupled from WalletService). */
export interface TournamentWallet {
  debit(userId: string, amountCents: number, reason: string): Promise<void>;  // buy-in escrow
  credit(userId: string, amountCents: number, reason: string): Promise<void>; // refund
  recordRake(amountCents: number, ref: string): Promise<void>;                // house cut (non-payout)
  // Pay the champion AND record the house rake ATOMICALLY (one DB transaction in prod),
  // so a crash between them can't credit the prize but lose the rake — which would
  // break the per-tournament ledger invariant sum(in) == sum(out).
  payoutChampion(winnerId: string, prizeCents: number, rakeCents: number, ref: string): Promise<void>;
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
  ) {}

  async list(): Promise<Tournament[]> { return this.repo.list(); }
  async get(id: string): Promise<Tournament | null> { return this.repo.get(id); }

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
      createdAt: this.now(),
    };
    await this.repo.create(t);
    return t;
  }

  /** Register a player; escrows their buy-in. Auto-starts when the bracket fills.
   *  Serialized per tournament (no concurrent double-debit), and the escrow is
   *  rolled back if persisting the registration fails (no trapped buy-in). */
  async register(tournamentId: string, userId: string): Promise<Tournament> {
    return this.withLock(tournamentId, async () => {
      const t = await this.repo.get(tournamentId);
      if (!t) throw new TournamentError('not_found', 'Turneu nuk u gjet.');
      if (t.status !== 'registering') throw new TournamentError('closed', 'Regjistrimi është mbyllur.');
      // Dupe + capacity are checked BEFORE the debit (and under the lock), so a
      // retry/concurrent call can never escrow a second buy-in for the same player.
      if (t.playerIds.includes(userId)) throw new TournamentError('already_in', 'Je tashmë i regjistruar.');
      if (t.playerIds.length >= t.capacity) throw new TournamentError('full', 'Turneu është plot.');
      // ESCROW first — if the debit fails (insufficient funds), the player is NOT added.
      if (t.buyInCents > 0) await this.wallet.debit(userId, t.buyInCents, `tournament buy-in:${t.id}:${userId}`);
      try {
        t.playerIds.push(userId);
        t.prizePoolCents += t.buyInCents;
        if (t.playerIds.length === t.capacity) this.seedBracket(t);
        await this.repo.save(t);
      } catch (e) {
        // Persisting the registration failed AFTER the escrow debit — roll the
        // buy-in back so it isn't trapped (distinct ref from a later cancel-refund).
        if (t.buyInCents > 0) await this.wallet.credit(userId, t.buyInCents, `tournament buyin-rollback:${t.id}:${userId}`).catch(() => undefined);
        throw e;
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

  /** Record a pairing's winner (called by the gateway when the match ends), then
   *  advance the bracket — building the next round, or finishing + paying out. */
  async reportResult(tournamentId: string, round: number, index: number, winnerId: string): Promise<Tournament> {
    return this.withLock(tournamentId, async () => {
      const t = await this.repo.get(tournamentId);
      if (!t) throw new TournamentError('not_found', 'Turneu nuk u gjet.');
      if (t.status !== 'running') throw new TournamentError('not_running', 'Turneu nuk është aktiv.');
      const m = t.bracket.find((x) => x.round === round && x.index === index);
      if (!m) throw new TournamentError('no_match', 'Ndeshja nuk ekziston.');
      if (m.winnerId) throw new TournamentError('already_decided', 'Ndeshja është vendosur tashmë.');
      if (winnerId !== m.aUserId && winnerId !== m.bUserId) throw new TournamentError('bad_winner', 'Fituesi nuk është në këtë ndeshje.');
      m.winnerId = winnerId;

      const roundMatches = t.bracket.filter((x) => x.round === round).sort((a, b) => a.index - b.index);
      if (roundMatches.every((x) => x.winnerId)) {
        if (roundMatches.length === 1) {
          await this.finish(t, roundMatches[0]!.winnerId!); // final decided → champion
        } else {
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
      }
      await this.repo.save(t);
      return t;
    });
  }

  private async finish(t: Tournament, winnerId: string): Promise<void> {
    t.winnerId = winnerId;
    t.status = 'finished';
    const rake = Math.floor((t.prizePoolCents * t.rakeBps) / 10000);
    const prize = t.prizePoolCents - rake;
    // Prize + rake in ONE atomic op — a crash between them would leave the ledger short
    // by `rake` (breaking the per-tournament conservation invariant).
    await this.wallet.payoutChampion(winnerId, prize, rake, t.id);
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
      await this.repo.save(t);
      return t;
    });
  }

  /**
   * Safety net for stranded money (audit 2026-06-08, finding C4): tournaments are
   * advanced manually by an admin and have no realtime auto-run, so a forgotten /
   * disputed / crashed one can sit in 'registering' or 'running' holding escrowed
   * buy-ins forever. This refunds + voids any such tournament older than `maxAgeMs`.
   * Idempotent (per-player refund refs) and lock-guarded so it never double-refunds
   * or races a concurrent report/cancel. Returns the ids it voided. Wired into the
   * periodic money sweep (app.ts).
   */
  async sweepStale(maxAgeMs: number): Promise<string[]> {
    const cutoff = this.now() - maxAgeMs;
    const all = await this.repo.list();
    const voided: string[] = [];
    for (const snap of all) {
      if (snap.status !== 'registering' && snap.status !== 'running') continue;
      if (snap.createdAt > cutoff) continue;
      await this.withLock(snap.id, async () => {
        const t = await this.repo.get(snap.id); // re-read under the lock
        if (!t || (t.status !== 'registering' && t.status !== 'running')) return;
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
