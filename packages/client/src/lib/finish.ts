// Detecting the moment a player "goes out" (empties their hand), used purely for
// presentation — a brief slow-mo emphasis on the pile when someone finishes a
// game. The server's `finishingOrder` is the source of truth: a seat going out is
// a seat newly appended to it. Pure (no React/DOM) so it can be unit-tested.

/**
 * The seat that *just* went out, given the previous and next `finishingOrder`
 * snapshots — i.e. the seat newly appended since `prev`. Returns `null` when the
 * order didn't grow (no new finisher), which is the common case on every other
 * broadcast. If more than one seat is appended at once (defensive — the engine
 * finishes one at a time), the most-recent finisher is returned.
 */
export function wentOutSeat(prev: readonly number[], next: readonly number[]): number | null {
  if (next.length <= prev.length) return null;
  const seat = next[next.length - 1];
  return seat ?? null;
}
