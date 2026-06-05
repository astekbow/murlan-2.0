// ============================================================================
// MURLAN — mobile haptics (tactile feedback)
// ----------------------------------------------------------------------------
// Thin wrapper over the Vibration API. No-op where unsupported (desktop / iOS
// Safari) and DISABLED under prefers-reduced-motion (vibration is motion). Purely
// presentational — never touches game/money state. Durations are short so play
// stays snappy. The gating decision is a pure function so it's unit-tested.
// ============================================================================

/** Pure gate: vibrate only when the device supports it AND motion isn't reduced. */
export function shouldVibrate(hasVibrate: boolean, reducedMotion: boolean): boolean {
  return hasVibrate && !reducedMotion;
}

function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function buzz(pattern: number | number[]): void {
  if (!shouldVibrate(canVibrate(), reducedMotion())) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* some browsers throw if not in a user-gesture context — ignore */
  }
}

export const haptics = {
  tap: () => buzz(10),              // a card played / selected
  turn: () => buzz(25),             // your turn begins
  win: () => buzz([40, 60, 90]),    // match won — a little celebration
  lose: () => buzz(30),             // match lost — a single soft tick
  bomb: () => buzz([0, 70, 40, 140]), // a bomb lands — a strong double-hit
};
