// ============================================================================
// MURLAN — zod validators for safety-relevant JSON columns (audit L4)
// ----------------------------------------------------------------------------
// Postgres jsonb columns (tournament bracket/playerIds, club-war roster/pairings)
// were read back with a blind `as T` cast — a corrupted or schema-drifted row would
// flow untyped straight into the money/match logic. These read-side validators use
// safeParse + a safe fallback so a bad row NEVER throws inside a mapper (which would
// break a whole list/settle read); instead it degrades to [] and logs, surfacing the
// bad row without taking the path down. Writes are unchanged (the services produce
// well-formed objects); this hardens the trust boundary on READ.
// ============================================================================

import { log } from '../logger.ts';
import { z } from 'zod';
import type { BracketMatch } from '../tournament/tournamentService.ts';
import type { WarPairing } from '../social/clubWarRepository.ts';

const BracketSchema = z.array(
  z.object({
    round: z.number(),
    index: z.number(),
    aUserId: z.string().nullable(),
    bUserId: z.string().nullable(),
    winnerId: z.string().nullable(),
  }),
);

const WarPairingsSchema = z.array(
  z.object({
    aUserId: z.string(),
    bUserId: z.string(),
    winnerId: z.string().nullable(),
  }),
);

const StringArraySchema = z.array(z.string());

function logBad(label: string, issues: unknown): void {
  log.error(`[jsonValidators] malformed ${label} JSON in a DB row — degrading to [] (row needs cleanup)`, issues);
}

/** Validate a tournament bracket read from jsonb; [] (and a log) on malformed/legacy data. */
export function parseBracket(raw: unknown): BracketMatch[] {
  if (raw == null) return [];
  const r = BracketSchema.safeParse(raw);
  if (r.success) return r.data;
  logBad('tournament.bracket', r.error.issues);
  return [];
}

/** Validate club-war pairings read from jsonb; [] (and a log) on malformed data. */
export function parseWarPairings(raw: unknown): WarPairing[] {
  if (raw == null) return [];
  const r = WarPairingsSchema.safeParse(raw);
  if (r.success) return r.data;
  logBad('clubwar.pairings', r.error.issues);
  return [];
}

/** Validate a string[] jsonb column (rosters, playerIds); [] (and a log) on malformed data. */
export function parseStringArray(raw: unknown, label: string): string[] {
  if (raw == null) return [];
  const r = StringArraySchema.safeParse(raw);
  if (r.success) return r.data;
  logBad(label, r.error.issues);
  return [];
}
