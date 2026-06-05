import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RATING, K_FACTOR, MIN_RATING, TIERS,
  tierFromRating, expectedScore, calculateNewRating, applyMatchRatings, softReset,
} from './ranking.ts';

test('expectedScore: equal ratings ⇒ 50%, big gap ⇒ near-certain', () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  assert.ok(expectedScore(2000, 1000) > 0.99); // 400 pts ≈ 10:1, 1000 pts ≈ overwhelming
  assert.ok(expectedScore(1000, 2000) < 0.01);
});

test('calculateNewRating: even result swings ±K/2', () => {
  assert.equal(calculateNewRating(1000, 1000, true), 1000 + K_FACTOR / 2);  // +16
  assert.equal(calculateNewRating(1000, 1000, false), 1000 - K_FACTOR / 2); // -16
});

test('calculateNewRating: beating a stronger opponent gains MORE than beating an equal one', () => {
  const gainVsEqual = calculateNewRating(1000, 1000, true) - 1000;
  const gainVsStrong = calculateNewRating(1000, 1600, true) - 1000;
  assert.ok(gainVsStrong > gainVsEqual);
  // Symmetrically, a favourite losing to an underdog drops a lot.
  const lossAsFavourite = 1600 - calculateNewRating(1600, 1000, false);
  assert.ok(lossAsFavourite > K_FACTOR / 2);
});

test('calculateNewRating: never drops below the floor', () => {
  assert.equal(calculateNewRating(MIN_RATING, 3000, false), MIN_RATING);
  assert.ok(calculateNewRating(10, 3000, false) >= MIN_RATING);
});

test('applyMatchRatings: 1v1 is a clean zero-sum at equal ratings', () => {
  const [a, b] = applyMatchRatings([{ rating: 1000, won: true }, { rating: 1000, won: false }]);
  assert.equal(a, 1016);
  assert.equal(b, 984);
});

test('applyMatchRatings: 3-player table scores each vs the mean of the others', () => {
  const out = applyMatchRatings([
    { rating: 1000, won: true },
    { rating: 1000, won: false },
    { rating: 1000, won: false },
  ]);
  assert.equal(out[0]! > 1000, true);  // winner climbs
  assert.equal(out[1]! < 1000, true);  // losers fall
  assert.equal(out[2]! < 1000, true);
  assert.equal(out[1], out[2]);        // equal losers fall equally
});

test('applyMatchRatings: fewer than 2 players is a no-op (rating needs an opponent)', () => {
  assert.deepEqual(applyMatchRatings([{ rating: 1234, won: true }]), [1234]);
  assert.deepEqual(applyMatchRatings([]), []);
});

test('tierFromRating: boundaries map to the expected tier', () => {
  assert.equal(tierFromRating(0).key, 'bronze');
  assert.equal(tierFromRating(DEFAULT_RATING).key, 'bronze'); // default 1000 starts in Bronze
  assert.equal(tierFromRating(1199).key, 'bronze');
  assert.equal(tierFromRating(1200).key, 'silver');
  assert.equal(tierFromRating(1500).key, 'gold');
  assert.equal(tierFromRating(1800).key, 'platinum');
  assert.equal(tierFromRating(2100).key, 'diamond');
  assert.equal(tierFromRating(2499).key, 'diamond');
  assert.equal(tierFromRating(2500).key, 'master');
  assert.equal(tierFromRating(99999).key, 'master');
});

test('TIERS: ascending, contiguous, bronze starts at 0', () => {
  assert.equal(TIERS[0]!.min, 0);
  for (let i = 1; i < TIERS.length; i += 1) assert.ok(TIERS[i]!.min > TIERS[i - 1]!.min);
});

test('softReset: pulls a peak toward the default; clamps decay to [0,1]', () => {
  assert.equal(softReset(2000, 0.5), 1500);     // halfway between 2000 and 1000
  assert.equal(softReset(2000, 1), 2000);       // full carry
  assert.equal(softReset(2000, 0), DEFAULT_RATING); // full reset
  assert.equal(softReset(2000, 2), 2000);       // decay clamped to 1
  assert.equal(softReset(500, -1), DEFAULT_RATING); // decay clamped to 0
});
