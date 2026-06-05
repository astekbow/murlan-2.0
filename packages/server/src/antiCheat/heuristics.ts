// ============================================================================
// MURLAN — Anti-collusion / anti-bot heuristics (pure)
// ----------------------------------------------------------------------------
// Cheap signals that flag a player/match for MANUAL admin review — never an
// automatic action (false positives are expected; a human decides). Pure
// functions over data we already persist (the move-log + cumulative stats), so
// they're exhaustively unit-testable. Heuristics, not proof.
// ============================================================================

import type { MatchActionRecord } from '../realtime/matchActions.ts';

export interface SeatTimingFlag {
  seat: number;
  type: 'bot_timing';
  severity: number; // 1 low · 2 medium · 3 high
  detail: string;
}

export interface TimingOpts {
  minMoves?: number;  // need enough samples to judge
  fastMs?: number;    // median response below this is "inhumanly fast"
  cvFloor?: number;   // coefficient-of-variation below this is "robotically consistent"
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Flag seats whose move responses look bot-like. "Response time" for a move is
 * the gap since the PREVIOUS logged move (≈ how fast the seat acted once it was
 * their turn). A bot responds consistently near-instantly: a low median response
 * OR an implausibly low coefficient of variation (stdev/mean) over many moves.
 */
export function moveTimingFlags(actions: readonly MatchActionRecord[], opts: TimingOpts = {}): SeatTimingFlag[] {
  const minMoves = opts.minMoves ?? 8;
  const fastMs = opts.fastMs ?? 300;
  const cvFloor = opts.cvFloor ?? 0.06;

  const ordered = [...actions].sort((a, b) => a.seq - b.seq);
  const bySeat = new Map<number, number[]>();
  for (let i = 1; i < ordered.length; i += 1) {
    const cur = ordered[i]!;
    const dt = cur.at - ordered[i - 1]!.at;
    if (dt < 0) continue; // out-of-order timestamp — skip
    let arr = bySeat.get(cur.seat);
    if (!arr) { arr = []; bySeat.set(cur.seat, arr); }
    arr.push(dt);
  }

  const flags: SeatTimingFlag[] = [];
  for (const [seat, times] of bySeat) {
    if (times.length < minMoves) continue;
    const med = median(times);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

    if (med <= fastMs) {
      flags.push({ seat, type: 'bot_timing', severity: med <= fastMs / 2 ? 3 : 2, detail: `mesatarja e përgjigjes ${Math.round(med)}ms mbi ${times.length} lëvizje (tepër e shpejtë)` });
    } else if (cv <= cvFloor) {
      flags.push({ seat, type: 'bot_timing', severity: 2, detail: `koha e përgjigjes tepër konstante (CV ${cv.toFixed(3)}) mbi ${times.length} lëvizje` });
    }
  }
  return flags;
}

// ---------- Collusion (multi-player) ----------------------------------------
// Collusion is the dominant fraud vector in real-money card games and is invisible
// to single-player signals. These read a WINDOW of recent staked matches (each a
// list of seats with who-won + team) and look for two patterns between a pair of
// distinct players, EXCLUDING teammates (who are meant to be together / win
// together): (1) repeat co-seating far above chance; (2) a directional chip-dump
// where one consistently loses to the other. Review-only, never auto-action.

export interface CollusionSeat {
  userId: string;
  won: boolean;
  team: number | null; // 2v2 team; null in 1v1 / 1v1v1
}
export interface PastMatch { seats: CollusionSeat[] }

export interface CollusionFlag {
  userId: string;       // the implicated player this flag is filed against
  partnerId: string;    // the other player in the pair
  type: 'collusion_pairing' | 'chip_dump';
  severity: number;     // 1 low · 2 medium · 3 high
  count: number;        // co-seatings (pairing) or directional losses (chip_dump)
}

export interface CollusionOpts {
  pairThreshold?: number; // co-seatings within the window that trip a pairing flag
  dumpThreshold?: number; // one-directional losses that trip a chip-dump flag
}

/**
 * Collusion flags implicated by the MOST RECENT match (the last element of
 * `window`), comparing each non-teammate pair against the whole window. Fires a
 * flag only at the exact crossing of a threshold (count === threshold) so a pair
 * is flagged once, not on every subsequent shared match. Pure + unit-testable.
 */
export function collusionFlags(window: readonly PastMatch[], opts: CollusionOpts = {}): CollusionFlag[] {
  const pairThreshold = opts.pairThreshold ?? 3;
  const dumpThreshold = opts.dumpThreshold ?? 3;
  if (window.length === 0) return [];
  const current = window[window.length - 1]!;
  const flags: CollusionFlag[] = [];
  const sameTeam = (a: CollusionSeat, b: CollusionSeat) => a.team !== null && a.team === b.team;

  const seats = current.seats;
  for (let i = 0; i < seats.length; i += 1) {
    for (let j = i + 1; j < seats.length; j += 1) {
      const a = seats[i]!, b = seats[j]!;
      if (sameTeam(a, b)) continue; // teammates are meant to be together
      let coSeat = 0, aBeatsB = 0, bBeatsA = 0;
      for (const m of window) {
        const sa = m.seats.find((s) => s.userId === a.userId);
        const sb = m.seats.find((s) => s.userId === b.userId);
        if (!sa || !sb || sameTeam(sa, sb)) continue; // ignore matches where they were teammates
        coSeat += 1;
        if (sa.won && !sb.won) aBeatsB += 1;
        if (sb.won && !sa.won) bBeatsA += 1;
      }
      if (coSeat === pairThreshold) {
        flags.push({ userId: a.userId, partnerId: b.userId, type: 'collusion_pairing', severity: 2, count: coSeat });
        flags.push({ userId: b.userId, partnerId: a.userId, type: 'collusion_pairing', severity: 2, count: coSeat });
      }
      // Directional chip-dump: one side keeps losing to the other (the other never
      // loses to them). Fires at the crossing; flags the dumper high, beneficiary medium.
      const hi = Math.max(aBeatsB, bBeatsA), lo = Math.min(aBeatsB, bBeatsA);
      if (hi === dumpThreshold && lo === 0) {
        const [winner, loser] = aBeatsB > bBeatsA ? [a, b] : [b, a];
        flags.push({ userId: loser.userId, partnerId: winner.userId, type: 'chip_dump', severity: 3, count: hi });
        flags.push({ userId: winner.userId, partnerId: loser.userId, type: 'chip_dump', severity: 2, count: hi });
      }
    }
  }
  return flags;
}

/**
 * Flag an implausibly high win rate over a large sample (smurf / bot / collusion
 * beneficiary). Returns the severity + detail, or null if nothing notable.
 */
export function winRateFlag(
  gamesPlayed: number,
  wins: number,
  opts: { minGames?: number; highRate?: number } = {},
): { type: 'win_rate'; severity: number; detail: string } | null {
  const minGames = opts.minGames ?? 30;
  const highRate = opts.highRate ?? 0.85;
  if (gamesPlayed < minGames) return null;
  const rate = wins / gamesPlayed;
  if (rate < highRate) return null;
  return {
    type: 'win_rate',
    severity: rate >= 0.95 ? 3 : 2,
    detail: `${Math.round(rate * 100)}% fitore mbi ${gamesPlayed} lojëra`,
  };
}
