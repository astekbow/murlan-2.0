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
  credit(userId: string, amountCents: number, reason: string): Promise<void>; // prize / refund
  recordRake(amountCents: number, ref: string): Promise<void>;                // house cut
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

  /** Register a player; escrows their buy-in. Auto-starts when the bracket fills. */
  async register(tournamentId: string, userId: string): Promise<Tournament> {
    const t = await this.repo.get(tournamentId);
    if (!t) throw new TournamentError('not_found', 'Turneu nuk u gjet.');
    if (t.status !== 'registering') throw new TournamentError('closed', 'Regjistrimi është mbyllur.');
    if (t.playerIds.includes(userId)) throw new TournamentError('already_in', 'Je tashmë i regjistruar.');
    if (t.playerIds.length >= t.capacity) throw new TournamentError('full', 'Turneu është plot.');
    // ESCROW first — if the debit fails (insufficient funds), the player is NOT added.
    if (t.buyInCents > 0) await this.wallet.debit(userId, t.buyInCents, `tournament buy-in:${t.id}`);
    t.playerIds.push(userId);
    t.prizePoolCents += t.buyInCents;
    if (t.playerIds.length === t.capacity) this.seedBracket(t);
    await this.repo.save(t);
    return t;
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
  }

  private async finish(t: Tournament, winnerId: string): Promise<void> {
    t.winnerId = winnerId;
    t.status = 'finished';
    const rake = Math.floor((t.prizePoolCents * t.rakeBps) / 10000);
    const prize = t.prizePoolCents - rake;
    if (prize > 0) await this.wallet.credit(winnerId, prize, `tournament prize:${t.id}`);
    if (rake > 0) await this.wallet.recordRake(rake, `tournament-rake:${t.id}`);
  }

  /** Cancel a still-registering tournament and REFUND every escrowed buy-in. */
  async cancel(tournamentId: string): Promise<Tournament> {
    const t = await this.repo.get(tournamentId);
    if (!t) throw new TournamentError('not_found', 'Turneu nuk u gjet.');
    if (t.status !== 'registering') throw new TournamentError('not_cancellable', 'Vetëm turne në regjistrim mund të anulohen.');
    if (t.buyInCents > 0) for (const uid of t.playerIds) await this.wallet.credit(uid, t.buyInCents, `tournament refund:${t.id}`);
    t.status = 'cancelled';
    t.prizePoolCents = 0;
    await this.repo.save(t);
    return t;
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
