import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBracket, parseWarPairings, parseStringArray } from './jsonValidators.ts';

test('parseStringArray: passes valid arrays, degrades anything malformed to []', () => {
  assert.deepEqual(parseStringArray(['a', 'b'], 'x'), ['a', 'b']);
  assert.deepEqual(parseStringArray([], 'x'), []);
  assert.deepEqual(parseStringArray(null, 'x'), []);
  assert.deepEqual(parseStringArray('nope', 'x'), []); // not an array
  assert.deepEqual(parseStringArray([1, 2], 'x'), []); // wrong element type
});

test('parseBracket: validates the BracketMatch shape, degrades malformed to []', () => {
  const ok = [{ round: 0, index: 1, aUserId: 'a', bUserId: null, winnerId: null }];
  assert.deepEqual(parseBracket(ok), ok);
  assert.deepEqual(parseBracket(null), []);
  assert.deepEqual(parseBracket([{ round: 'x', index: 0, aUserId: 'a', bUserId: 'b', winnerId: null }]), []); // bad type
  assert.deepEqual(parseBracket([{ index: 0 }]), []); // missing fields
});

test('parseWarPairings: validates the WarPairing shape, degrades malformed to []', () => {
  const ok = [{ aUserId: 'a', bUserId: 'b', winnerId: null }];
  assert.deepEqual(parseWarPairings(ok), ok);
  assert.deepEqual(parseWarPairings([{ aUserId: 'a' }]), []); // missing bUserId/winnerId
  assert.deepEqual(parseWarPairings('nope'), []);
});
