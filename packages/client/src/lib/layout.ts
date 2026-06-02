// Pure seat-positioning so the local player is always at the BOTTOM and the
// table rotates around them. Mirrors the spec's seat layouts (§10).

export type SeatPosition = 'bottom' | 'top' | 'left' | 'right' | 'top-left' | 'top-right';

/**
 * Where to draw `seat` given that `mySeat` sits at the bottom.
 *   2p (1v1):   me bottom, opponent top.
 *   3p (1v1v1): me bottom, next-in-turn top-right, last top-left.
 *   4p (2v2):   me bottom, right opponent, partner top (opposite), left opponent.
 */
export function seatPosition(numPlayers: number, mySeat: number, seat: number): SeatPosition {
  const offset = (((seat - mySeat) % numPlayers) + numPlayers) % numPlayers;
  if (numPlayers === 2) return offset === 0 ? 'bottom' : 'top';
  if (numPlayers === 3) return offset === 0 ? 'bottom' : offset === 1 ? 'top-right' : 'top-left';
  return (['bottom', 'right', 'top', 'left'] as const)[offset] ?? 'bottom';
}

/** Tailwind absolute-position classes for each seat slot on the felt. */
export const POSITION_CLASSES: Record<SeatPosition, string> = {
  bottom: 'bottom-2 left-1/2 -translate-x-1/2',
  top: 'top-2 left-1/2 -translate-x-1/2',
  left: 'left-2 top-1/2 -translate-y-1/2',
  right: 'right-2 top-1/2 -translate-y-1/2',
  'top-left': 'top-2 left-2',
  'top-right': 'top-2 right-2',
};
