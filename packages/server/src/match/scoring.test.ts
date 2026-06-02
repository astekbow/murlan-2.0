import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card } from '@murlan/engine';
import {
  gamePoints, teamTotals, evaluateMatch, strongestIndexByPower,
  isReturnEligible, eligibleReturnCards, playersForType, DEFAULT_TEAMS,
} from './scoring.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });
const BJ: Card = { kind: 'joker', color: 'black' };
const RJ: Card = { kind: 'joker', color: 'red' };

// ---- gamePoints -------------------------------------------------------------
test('playersForType maps room types to player counts', () => {
  assert.equal(playersForType('1v1'), 2);
  assert.equal(playersForType('1v1v1'), 3);
  assert.equal(playersForType('2v2'), 4);
});

test('1v1 points: winner +1, loser 0', () => {
  assert.deepEqual(gamePoints('1v1', [0, 1]), [1, 0]);
  assert.deepEqual(gamePoints('1v1', [1, 0]), [0, 1]);
});

test('1v1v1 points: 2 / 1 / 0 by place', () => {
  // finishing order seats: 2nd seat first, then seat0, then seat1
  assert.deepEqual(gamePoints('1v1v1', [2, 0, 1]), [1, 0, 2]);
});

test('2v2 points: 3 / 2 / 1 / 0 by place', () => {
  // 1st=seat2, 2nd=seat0, 3rd=seat3, 4th=seat1
  assert.deepEqual(gamePoints('2v2', [2, 0, 3, 1]), [2, 0, 3, 1]);
});

test('gamePoints rejects a finishing order of the wrong length', () => {
  assert.throws(() => gamePoints('2v2', [0, 1, 2]));
});

// ---- team totals ------------------------------------------------------------
test('2v2 team totals sum each team (seats 0&2 vs 1&3)', () => {
  // points: seat0=2, seat1=0, seat2=3, seat3=1 -> team0 (0,2)=5, team1 (1,3)=1
  assert.deepEqual(teamTotals([2, 0, 3, 1], DEFAULT_TEAMS), [5, 1]);
});

// ---- match evaluation (target / tie extension) ------------------------------
test('match won by a unique leader at or above target', () => {
  const r = evaluateMatch([21, 18], 21);
  assert.equal(r.over, true);
  assert.equal(r.winnerSide, 0);
  assert.equal(r.extended, false);
});

test('22 vs 21 at target 21: unique max 22 wins (even though 21 ≥ target)', () => {
  const r = evaluateMatch([22, 21], 21);
  assert.equal(r.over, true);
  assert.equal(r.winnerSide, 0);
});

test('21-21 tie at target 21 extends the target by 10', () => {
  const r = evaluateMatch([21, 21], 21);
  assert.equal(r.over, false);
  assert.equal(r.extended, true);
  assert.equal(r.newTarget, 31);
});

test('20-20 tie (= target − 1) extends the target by 10', () => {
  const r = evaluateMatch([20, 20], 21);
  assert.equal(r.extended, true);
  assert.equal(r.newTarget, 31);
});

test('below target keeps playing, no extension', () => {
  const r = evaluateMatch([20, 19], 21);
  assert.equal(r.over, false);
  assert.equal(r.extended, false);
  assert.equal(r.newTarget, 21);
});

test('1v1v1: two leaders tied ≥ target − 1 extends; lone trailing side ignored', () => {
  const r = evaluateMatch([21, 21, 5], 21);
  assert.equal(r.extended, true);
  assert.equal(r.newTarget, 31);
});

test('1v1v1: unique leader ≥ target wins even with others present', () => {
  const r = evaluateMatch([23, 21, 5], 21);
  assert.equal(r.over, true);
  assert.equal(r.winnerSide, 0);
});

// ---- strongest card (POWER order) ------------------------------------------
test('strongest by power: red joker tops everything', () => {
  const hand = [c('2', 'S'), RJ, BJ, c('A', 'H')];
  assert.equal(strongestIndexByPower(hand), 1); // RJ
});

test('strongest by power: 2 outranks Ace and King', () => {
  const hand = [c('K', 'S'), c('A', 'H'), c('2', 'D'), c('7', 'C')];
  assert.equal(strongestIndexByPower(hand), 2); // the 2
});

// ---- return-eligible cards (rank 3–10) -------------------------------------
test('return eligibility: only standard cards of rank 3–10', () => {
  assert.equal(isReturnEligible(c('3', 'S')), true);
  assert.equal(isReturnEligible(c('10', 'H')), true);
  assert.equal(isReturnEligible(c('J', 'S')), false);
  assert.equal(isReturnEligible(c('2', 'S')), false);
  assert.equal(isReturnEligible(c('A', 'S')), false);
  assert.equal(isReturnEligible(RJ), false);
});

test('eligibleReturnCards filters a hand to its 3–10 cards', () => {
  const hand = [c('3', 'S'), c('J', 'H'), c('9', 'D'), c('2', 'C'), RJ, c('10', 'S')];
  const elig = eligibleReturnCards(hand);
  assert.deepEqual(elig.map((x) => (x.kind === 'standard' ? x.rank : 'J')), ['3', '9', '10']);
});
