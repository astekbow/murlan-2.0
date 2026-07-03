// Pure seat-positioning so the local player is always at the BOTTOM and the
// table rotates around them. Mirrors the spec's seat layouts (§10).

export type SeatPosition = 'bottom' | 'top' | 'left' | 'right' | 'top-left' | 'top-right';

/**
 * Where to draw `seat` given that `mySeat` sits at the bottom. Play passes
 * CLOCKWISE (the next player to act — offset 1 — sits to the LEFT), matching how
 * Murlan is played at a physical table.
 *   2p (1v1):   me bottom, opponent top.
 *   3p (1v1v1): me bottom, next-in-turn top-left, last top-right (clockwise).
 *   4p (2v2):   me bottom, next opponent left, partner top (opposite), last opponent right.
 */
export function seatPosition(numPlayers: number, mySeat: number, seat: number): SeatPosition {
  const offset = (((seat - mySeat) % numPlayers) + numPlayers) % numPlayers;
  if (numPlayers === 2) return offset === 0 ? 'bottom' : 'top';
  if (numPlayers === 3) return offset === 0 ? 'bottom' : offset === 1 ? 'top-left' : 'top-right';
  return (['bottom', 'left', 'top', 'right'] as const)[offset] ?? 'bottom';
}

/** Where a PLAYED card is thrown FROM (px offset from its final centred spot on the pile), by the
 *  thrower's seat slot. The card flies from here to (0,0) while spinning like a disk (see
 *  `cardthrow` in index.css). The local player (bottom) throws from further down — their hand is at
 *  the screen edge — so their card visibly travels up into the centre. */
export const THROW_ORIGIN: Record<SeatPosition, { x: number; y: number }> = {
  bottom: { x: 0, y: 132 },
  top: { x: 0, y: -104 },
  left: { x: -132, y: 8 },
  right: { x: 132, y: 8 },
  'top-left': { x: -112, y: -72 },
  'top-right': { x: 112, y: -72 },
};

/** Tailwind absolute-position classes for each seat slot on the felt. */
export const POSITION_CLASSES: Record<SeatPosition, string> = {
  bottom: 'bottom-2 left-1/2 -translate-x-1/2',
  top: 'top-2 left-1/2 -translate-x-1/2',
  left: 'left-2 top-1/2 -translate-y-1/2',
  right: 'right-2 top-1/2 -translate-y-1/2',
  'top-left': 'top-2 left-2',
  'top-right': 'top-2 right-2',
};
