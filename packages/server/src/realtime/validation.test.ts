import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card } from '@murlan/engine';
import {
  isValidCard,
  isCardArray,
  isMatchType,
  isTeam,
  isValidStake,
  isNonEmptyString,
  MAX_STAKE_CENTS,
} from './validation.ts';

// The untrusted-input boundary: these predicates are what stop a malformed socket
// payload from reaching (and throwing inside) the engine. Exercised here directly.

test('isValidCard accepts well-formed standard cards and jokers', () => {
  assert.equal(isValidCard({ kind: 'standard', rank: '3', suit: 'S' } satisfies Card), true);
  assert.equal(isValidCard({ kind: 'standard', rank: '10', suit: 'D' } satisfies Card), true);
  assert.equal(isValidCard({ kind: 'joker', color: 'black' } satisfies Card), true);
  assert.equal(isValidCard({ kind: 'joker', color: 'red' } satisfies Card), true);
});

test('isValidCard rejects malformed / hostile values', () => {
  assert.equal(isValidCard(null), false);
  assert.equal(isValidCard(undefined), false);
  assert.equal(isValidCard('3S'), false);
  assert.equal(isValidCard(42), false);
  assert.equal(isValidCard({}), false);
  assert.equal(isValidCard({ kind: 'standard', rank: '1', suit: 'S' }), false); // bad rank
  assert.equal(isValidCard({ kind: 'standard', rank: '3', suit: 'X' }), false); // bad suit
  assert.equal(isValidCard({ kind: 'standard', rank: '3' }), false); // missing suit
  assert.equal(isValidCard({ kind: 'joker', color: 'blue' }), false); // bad color
  assert.equal(isValidCard({ kind: 'wat', rank: '3', suit: 'S' }), false); // bad kind
});

test('isCardArray requires a non-empty array of valid cards, bounded by the deck', () => {
  assert.equal(isCardArray([{ kind: 'standard', rank: '3', suit: 'S' }]), true);
  assert.equal(isCardArray([]), false); // empty
  assert.equal(isCardArray('nope'), false);
  assert.equal(isCardArray([{ kind: 'standard', rank: '3', suit: 'S' }, null]), false); // one bad element
  assert.equal(isCardArray(Array.from({ length: 55 }, () => ({ kind: 'joker', color: 'red' }))), false); // > 54
});

test('isMatchType only accepts the three real types', () => {
  for (const t of ['1v1', '1v1v1', '2v2']) assert.equal(isMatchType(t), true);
  for (const t of ['', '4v4', 'toString', 0, null, undefined]) assert.equal(isMatchType(t as unknown), false);
});

test('isTeam accepts 0, 1, or undefined only', () => {
  assert.equal(isTeam(0), true);
  assert.equal(isTeam(1), true);
  assert.equal(isTeam(undefined), true);
  assert.equal(isTeam(2), false);
  assert.equal(isTeam('0' as unknown), false);
  assert.equal(isTeam(null), false);
});

test('isValidStake accepts integer cents within [0, MAX] and rejects junk', () => {
  assert.equal(isValidStake(0), true);
  assert.equal(isValidStake(500), true);
  assert.equal(isValidStake(MAX_STAKE_CENTS), true);
  assert.equal(isValidStake(-1), false);
  assert.equal(isValidStake(1.5), false);
  assert.equal(isValidStake(MAX_STAKE_CENTS + 1), false);
  assert.equal(isValidStake('5' as unknown), false);
  assert.equal(isValidStake(NaN), false);
});

test('isNonEmptyString bounds length to a sane max', () => {
  assert.equal(isNonEmptyString('room_1'), true);
  assert.equal(isNonEmptyString(''), false);
  assert.equal(isNonEmptyString('x'.repeat(201)), false);
  assert.equal(isNonEmptyString(123 as unknown), false);
});
