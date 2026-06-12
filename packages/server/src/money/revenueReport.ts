// Pure revenue-reporting aggregation over the house rake ledger. No I/O — the
// caller fetches the rake rows + a matchId→type map and passes them in, so this
// is trivially unit-testable. One 'rake' row is booked per settled match, so a
// row's count == one match.

export interface RakeRow {
  amountCents: number;       // signed in the ledger; we use the magnitude
  matchId: string | null;
  createdAt: number;         // epoch ms
}

export interface RevenueBreakdown {
  totalRakeCents: number;
  rakeCount: number;
  byDay: Array<{ date: string; rakeCents: number; matchCount: number }>;  // UTC YYYY-MM-DD, newest first
  byType: Array<{ type: string; rakeCents: number; matchCount: number }>; // largest first
}

/** UTC calendar day (YYYY-MM-DD) for an epoch-ms timestamp. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Bucket rake rows by UTC day and by match type. `typeById` maps a matchId to its
 * match type ('1v1' | '1v1v1' | '2v2'); a row whose match type is unknown (no
 * matchId, or match not loaded) is bucketed under 'unknown'. `maxDays` caps the
 * byDay series to the most recent N days (default 30) — the totals are unaffected.
 */
export function revenueBreakdown(rows: RakeRow[], typeById: Map<string, string>, opts: { maxDays?: number } = {}): RevenueBreakdown {
  const maxDays = opts.maxDays ?? 30;
  const dayMap = new Map<string, { rakeCents: number; matchCount: number }>();
  const typeMap = new Map<string, { rakeCents: number; matchCount: number }>();
  let totalRakeCents = 0;

  for (const r of rows) {
    const cents = Math.abs(r.amountCents);
    totalRakeCents += cents;

    const day = utcDay(r.createdAt);
    const d = dayMap.get(day) ?? { rakeCents: 0, matchCount: 0 };
    d.rakeCents += cents; d.matchCount += 1;
    dayMap.set(day, d);

    const type = (r.matchId && typeById.get(r.matchId)) || 'unknown';
    const ty = typeMap.get(type) ?? { rakeCents: 0, matchCount: 0 };
    ty.rakeCents += cents; ty.matchCount += 1;
    typeMap.set(type, ty);
  }

  const byDay = [...dayMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)) // newest first
    .slice(0, maxDays);

  const byType = [...typeMap.entries()]
    .map(([type, v]) => ({ type, ...v }))
    .sort((a, b) => b.rakeCents - a.rakeCents);

  return { totalRakeCents, rakeCount: rows.length, byDay, byType };
}
