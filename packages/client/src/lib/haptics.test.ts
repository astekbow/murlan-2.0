import { test } from 'vitest';
import assert from 'node:assert/strict';
import { shouldVibrate, haptics } from './haptics.ts';

test('shouldVibrate: only when supported AND motion is not reduced', () => {
  assert.equal(shouldVibrate(true, false), true);
  assert.equal(shouldVibrate(true, true), false);  // reduced motion → no vibration
  assert.equal(shouldVibrate(false, false), false); // unsupported device
  assert.equal(shouldVibrate(false, true), false);
});

test('haptics calls are safe no-ops where the Vibration API is absent (Node)', () => {
  // node:test runs with no navigator.vibrate / window — every cue must no-op cleanly.
  assert.doesNotThrow(() => { haptics.tap(); haptics.turn(); haptics.win(); haptics.lose(); haptics.bomb(); });
});
