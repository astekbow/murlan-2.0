import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Card } from '@murlan/engine';
import { identifyCombo } from '@murlan/engine';
import { toggleCard, selectedCards, evaluateSelection } from './selection.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });

test('toggleCard adds then removes an id', () => {
  assert.deepEqual(toggleCard([], '3S'), ['3S']);
  assert.deepEqual(toggleCard(['3S', '4S'], '3S'), ['4S']);
});

test('selectedCards resolves ids back to hand cards in hand order', () => {
  const hand = [c('3', 'S'), c('4', 'H'), c('5', 'D')];
  assert.deepEqual(selectedCards(hand, ['5D', '3S']).map((x) => (x.kind === 'standard' ? x.rank : 'J')), ['3', '5']);
});

test('evaluateSelection: empty selection is not playable but has no error', () => {
  const r = evaluateSelection([], null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, null);
});

test('evaluateSelection mirrors the engine when leading', () => {
  assert.equal(evaluateSelection([c('3', 'S'), c('3', 'H')], null).ok, true);   // a pair leads fine
  assert.equal(evaluateSelection([c('3', 'S'), c('4', 'H')], null).ok, false);  // mixed pair invalid
});

test('evaluateSelection mirrors the engine when responding to a pile', () => {
  const pile = identifyCombo([c('5', 'S')]);
  assert.equal(evaluateSelection([c('7', 'H')], pile).ok, true);   // 7 beats 5
  assert.equal(evaluateSelection([c('4', 'H')], pile).ok, false);  // 4 cannot beat 5
});
