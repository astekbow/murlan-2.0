import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card } from './engine.ts';
import {
  identifyCombo, beats, validatePlay, buildDeck, deal, dealSizes,
} from './engine.ts';

// helpers to build cards quickly
type StdCard = Extract<Card, { kind: 'standard' }>;
const c = (rank: StdCard['rank'], suit: StdCard['suit']): Card => ({ kind: 'standard', rank, suit });
const BJ: Card = { kind: 'joker', color: 'black' };
const RJ: Card = { kind: 'joker', color: 'red' };

// beats helper that identifies both sides first
function B(cand: Card[], cur: Card[]): boolean {
  const a = identifyCombo(cand)!, b = identifyCombo(cur)!;
  return beats(a, b);
}

test('single power order (3 < … < K < A < 2 < BJ < RJ)', () => {
  assert.ok(B([c('4', 'S')], [c('3', 'H')]), '4 beats 3');
  assert.ok(B([c('2', 'S')], [c('K', 'H')]), '2 beats K');
  assert.ok(B([c('2', 'S')], [c('A', 'H')]), '2 beats A');
  assert.ok(B([BJ], [c('2', 'H')]), 'black joker beats 2');
  assert.ok(B([RJ], [BJ]), 'red joker beats black joker');
  assert.ok(!B([c('3', 'S')], [c('4', 'H')]), '3 does NOT beat 4');
});

test('pairs / triples', () => {
  assert.ok(B([c('4', 'S'), c('4', 'H')], [c('3', 'S'), c('3', 'H')]), 'pair of 4s beats pair of 3s');
  assert.equal(identifyCombo([BJ, RJ]), null, 'two jokers are NOT a valid pair');
  assert.equal(identifyCombo([c('4', 'S'), c('5', 'H')]), null, 'mixed pair invalid');
  assert.ok(B([c('5', 'S'), c('5', 'H'), c('5', 'D')], [c('4', 'S'), c('4', 'H'), c('4', 'D')]), 'triple 5s beats triple 4s');
  assert.ok(!B([c('2', 'S'), c('2', 'H')], [c('3', 'S'), c('3', 'H'), c('3', 'D')]), 'pair cannot beat a triple (category)');
});

test('bomb (four of a kind)', () => {
  const bomb5 = [c('5', 'S'), c('5', 'H'), c('5', 'D'), c('5', 'C')];
  const bomb6 = [c('6', 'S'), c('6', 'H'), c('6', 'D'), c('6', 'C')];
  assert.equal(identifyCombo(bomb5)?.type, 'bomb', 'four 5s is a bomb');
  assert.ok(B(bomb6, bomb5), 'four 6s beats four 5s');
  assert.ok(!B(bomb5, bomb6), 'four 5s does NOT beat four 6s');
  assert.ok(B(bomb5, [RJ]), 'bomb beats a single red joker');
  assert.ok(B(bomb5, [c('A', 'S'), c('A', 'H'), c('A', 'D')]), 'bomb beats a triple');
  assert.ok(B(bomb5, [c('2', 'S'), c('2', 'H')]), 'bomb beats a pair');
});

test('kolor (mixed-suit straight, length >= 5)', () => {
  const bomb5 = [c('5', 'S'), c('5', 'H'), c('5', 'D'), c('5', 'C')];
  const bomb6 = [c('6', 'S'), c('6', 'H'), c('6', 'D'), c('6', 'C')];
  const k3_7 = [c('3', 'S'), c('4', 'H'), c('5', 'D'), c('6', 'C'), c('7', 'S')];
  const k4_8 = [c('4', 'D'), c('5', 'C'), c('6', 'S'), c('7', 'H'), c('8', 'D')];
  const k10_A = [c('10', 'S'), c('J', 'H'), c('Q', 'D'), c('K', 'C'), c('A', 'S')];
  const kA_5 = [c('A', 'S'), c('2', 'H'), c('3', 'D'), c('4', 'C'), c('5', 'S')];
  const k3_8 = [c('3', 'S'), c('4', 'H'), c('5', 'D'), c('6', 'C'), c('7', 'S'), c('8', 'H')];
  assert.equal(identifyCombo(k3_7)?.type, 'kolor', '3->7 is a kolor');
  assert.ok(B(k4_8, k3_7), '4->8 beats 3->7 (same length, +1 rank)');
  assert.equal(identifyCombo(kA_5)?.type, 'kolor', 'A2345 is the lowest kolor');
  assert.equal(identifyCombo(k10_A)?.type, 'kolor', '10JQKA is a valid kolor (Ace high)');
  assert.ok(!B(k4_8, k10_A) && !B(k3_7, k10_A), 'no same-length kolor beats 10JQKA');
  assert.ok(!B(k3_8, k10_A), 'a LONGER kolor does NOT beat a shorter one (same length only)');
  assert.ok(!B(k10_A, k3_8), 'a SHORTER kolor does NOT beat a longer one');
  assert.equal(identifyCombo([c('J', 'S'), c('Q', 'H'), c('K', 'D'), c('A', 'C'), c('2', 'S')]), null, 'JQKA2 is NOT a valid straight');
  assert.ok(B(bomb6, k3_7), 'bomb beats a kolor');
  assert.ok(!B(k4_8, bomb5), 'kolor cannot beat a bomb');
});

test('kolor +1 rule: beaten ONLY by the immediate next run (same length, top exactly +1)', () => {
  const k3_7 = [c('3', 'S'), c('4', 'H'), c('5', 'D'), c('6', 'C'), c('7', 'S')];
  const k4_8 = [c('4', 'D'), c('5', 'C'), c('6', 'S'), c('7', 'H'), c('8', 'D')];
  const kA_5 = [c('A', 'S'), c('2', 'H'), c('3', 'D'), c('4', 'C'), c('5', 'S')];
  const k5_9 = [c('5', 'S'), c('6', 'H'), c('7', 'D'), c('8', 'C'), c('9', 'S')];
  const k8_Q = [c('8', 'S'), c('9', 'H'), c('10', 'D'), c('J', 'C'), c('Q', 'S')];
  const k23456 = [c('2', 'S'), c('3', 'H'), c('4', 'D'), c('5', 'C'), c('6', 'S')];
  const k4_Q = [c('4', 'S'), c('5', 'H'), c('6', 'D'), c('7', 'C'), c('8', 'S'), c('9', 'H'), c('10', 'D'), c('J', 'C'), c('Q', 'S')];
  const k5_K = [c('5', 'D'), c('6', 'C'), c('7', 'S'), c('8', 'H'), c('9', 'D'), c('10', 'C'), c('J', 'S'), c('Q', 'H'), c('K', 'D')];
  const k6_A = [c('6', 'D'), c('7', 'C'), c('8', 'S'), c('9', 'H'), c('10', 'D'), c('J', 'C'), c('Q', 'S'), c('K', 'H'), c('A', 'D')];
  assert.ok(!B(k5_9, k3_7), '5->9 does NOT beat 3->7 (gap of 2)');
  assert.ok(!B(k8_Q, k3_7), '8->Q does NOT beat 3->7 (unrelated higher run)');
  assert.ok(B(k5_9, k4_8), '5->9 beats 4->8 (+1)');
  assert.ok(!B(k4_8, k4_8), '4->8 does NOT beat 4->8 (not higher)');
  assert.ok(B(k23456, kA_5), '23456 beats A2345 (+1)');
  assert.ok(!B(k3_7, kA_5), '3->7 does NOT beat A2345 (gap of 2)');
  assert.ok(B(k5_K, k4_Q), 'long run: 5->K beats 4->Q (+1)');
  assert.ok(!B(k6_A, k4_Q), 'long run: 6->A does NOT beat 4->Q (gap of 2)');
  assert.ok(!B(k6_A, k4_Q) && B(k5_K, k4_Q), 'long run: a same-length non-adjacent higher run never beats');
});

test('flush (same-suit straight) — strongest', () => {
  const bomb6 = [c('6', 'S'), c('6', 'H'), c('6', 'D'), c('6', 'C')];
  const k10_A = [c('10', 'S'), c('J', 'H'), c('Q', 'D'), c('K', 'C'), c('A', 'S')];
  const f3_7 = [c('3', 'S'), c('4', 'S'), c('5', 'S'), c('6', 'S'), c('7', 'S')];
  const f4_8 = [c('4', 'H'), c('5', 'H'), c('6', 'H'), c('7', 'H'), c('8', 'H')];
  const f3_8 = [c('3', 'D'), c('4', 'D'), c('5', 'D'), c('6', 'D'), c('7', 'D'), c('8', 'D')];
  assert.equal(identifyCombo(f3_7)?.type, 'flush', '3->7 same suit is a flush, not kolor');
  assert.ok(B(f4_8, f3_7), 'flush 4->8 beats flush 3->7');
  assert.ok(B(f3_7, bomb6), 'flush beats a bomb (always)');
  assert.ok(B(f3_7, [c('2', 'S'), c('2', 'H'), c('2', 'D'), c('2', 'C')]), 'even the smallest flush beats the biggest bomb');
  assert.ok(B(f3_7, k10_A), 'flush beats a kolor');
  assert.ok(!B(bomb6, f3_7), 'bomb does NOT beat a flush');
  assert.ok(!B(f3_8, f4_8), 'a longer flush does NOT beat a shorter flush (same length only)');
  assert.ok(!B(f4_8, f3_8), 'a shorter flush does NOT beat a longer flush');
  assert.ok(B(f3_7, [RJ]), 'flush beats red joker');
});

test('validatePlay (leading vs responding)', () => {
  const k3_7 = [c('3', 'S'), c('4', 'H'), c('5', 'D'), c('6', 'C'), c('7', 'S')];
  const bomb5 = [c('5', 'S'), c('5', 'H'), c('5', 'D'), c('5', 'C')];
  assert.equal(validatePlay(k3_7, null).ok, true, 'any valid combo may lead');
  assert.equal(validatePlay([c('3', 'S'), c('5', 'H')], null).ok, false, 'invalid combo rejected when leading');
  assert.equal(validatePlay([c('3', 'S')], identifyCombo([c('5', 'H')])).ok, false, 'weaker single rejected vs current');
  assert.equal(validatePlay(bomb5, identifyCombo([c('A', 'S')])).ok, true, 'bomb accepted over a single');
});

test('deck & dealing', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 54, 'deck has 54 cards');
  assert.equal(deck.filter((x) => x.kind === 'joker').length, 2, 'deck has 2 jokers');
  assert.equal(new Set(deck.map((x) => (x.kind === 'joker' ? `J${x.color}` : `${x.rank}${x.suit}`))).size, 54, 'no duplicate cards');
  assert.deepEqual(dealSizes(2), [18, 18], '2-player deal = 18/18');
  assert.equal(54 - dealSizes(2).reduce((a, b) => a + b, 0), 18, '2-player deal leaves 18 undealt');
  assert.deepEqual(dealSizes(3), [18, 18, 18], '3-player deal = 18/18/18');
  assert.deepEqual(dealSizes(4), [14, 14, 13, 13], '4-player deal = 14/14/13/13');
  let seed = 12345;
  const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const hands = deal(4, rng);
  assert.equal(hands.flat().length, 54, '4-player deal uses all 54 cards');
});
