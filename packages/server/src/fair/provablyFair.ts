// ============================================================================
// MURLAN — Provably-fair shuffle service (Phase 7, spec §8)
// ----------------------------------------------------------------------------
// Commit–reveal: before a match the server commits hash(serverSeed); each game
// is dealt deterministically from (serverSeed, clientSeed, nonce). After the
// match serverSeed is revealed so any player can recompute every deal and check
// it against the committed hash. Seeds + nonces are retained for auditing.
// ============================================================================

import { createHash, randomBytes } from 'node:crypto';
import type { Card } from '@murlan/engine';
import { deal as engineDeal } from '@murlan/engine';
import { hmacRng } from './prng.ts';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface GameSeedRecord {
  index: number; // game index in the match
  nonce: number; // PRNG nonce used for this game's deal
}

export interface FairShuffle {
  serverSeed: string;       // SECRET until reveal
  serverSeedHash: string;   // the public commitment
  clientSeed: string;
  numPlayers: 2 | 3 | 4;
  games: GameSeedRecord[];
  /** Deterministic dealer: each call deals the next game (nonce = game index). */
  deal: () => Card[][];
  /** What is sent to clients up-front (no serverSeed). */
  commitment: () => { serverSeedHash: string; clientSeed: string };
  /** What is published after the match so clients can verify. */
  reveal: () => { serverSeed: string; serverSeedHash: string; clientSeed: string; numPlayers: 2 | 3 | 4; gameCount: number };
}

/** Generate a serverSeed + its commitment. Call this BEFORE collecting any
 *  clientSeed for the match, then pass `serverSeed` into createFairShuffle —
 *  this is what makes grinding the deal impossible (the seed is fixed first). */
export function generateServerSeed(): { serverSeed: string; serverSeedHash: string } {
  const serverSeed = randomBytes(32).toString('hex');
  return { serverSeed, serverSeedHash: sha256Hex(serverSeed) };
}

/**
 * Create a fair shuffle for a match. `serverSeed` SHOULD be a value committed
 * (via its hash) before clientSeeds were collected; if omitted one is generated
 * (only safe when no clientSeed influence is in play). A clientSeed may be
 * supplied (combined from players) or one is generated.
 */
export function createFairShuffle(numPlayers: 2 | 3 | 4, clientSeed?: string, serverSeed?: string): FairShuffle {
  const seedSrv = serverSeed && serverSeed.length > 0 ? serverSeed : randomBytes(32).toString('hex');
  const serverSeedHash = sha256Hex(seedSrv);
  const seed = clientSeed && clientSeed.length > 0 ? clientSeed : randomBytes(16).toString('hex');
  const games: GameSeedRecord[] = [];

  return {
    serverSeed: seedSrv,
    serverSeedHash,
    clientSeed: seed,
    numPlayers,
    games,
    deal() {
      const nonce = games.length;
      const hands = engineDeal(numPlayers, hmacRng(seedSrv, seed, nonce));
      games.push({ index: nonce, nonce });
      return hands;
    },
    commitment() {
      return { serverSeedHash, clientSeed: seed };
    },
    reveal() {
      return { serverSeed: seedSrv, serverSeedHash, clientSeed: seed, numPlayers, gameCount: games.length };
    },
  };
}

/**
 * Recompute a single game's deal from revealed seeds — what a player/auditor
 * runs to verify the deal was not manipulated.
 */
export function verifyDeal(serverSeed: string, clientSeed: string, nonce: number, numPlayers: 2 | 3 | 4): Card[][] {
  return engineDeal(numPlayers, hmacRng(serverSeed, clientSeed, nonce));
}

/** Verify a revealed serverSeed matches the committed hash. */
export function verifyCommitment(serverSeed: string, serverSeedHash: string): boolean {
  return sha256Hex(serverSeed) === serverSeedHash;
}

/** Combine players' submitted client seeds into one reproducible room seed. */
export function combineClientSeeds(seeds: string[]): string {
  const usable = seeds.filter((s) => typeof s === 'string' && s.length > 0).sort();
  return usable.length > 0 ? sha256Hex(usable.join('|')) : randomBytes(16).toString('hex');
}
