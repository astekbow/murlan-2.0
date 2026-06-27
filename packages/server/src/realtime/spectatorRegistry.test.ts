import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectatorRegistry } from './spectatorRegistry.ts';

test('add/remove/count: tracks per-room and drops the entry at zero', () => {
  const r = new SpectatorRegistry(3);
  assert.equal(r.count('a'), 0);
  r.add('a'); r.add('a');
  assert.equal(r.count('a'), 2);
  r.remove('a');
  assert.equal(r.count('a'), 1);
  r.remove('a');
  assert.equal(r.count('a'), 0); // entry dropped
  r.remove('a'); // underflow is safe (stays 0)
  assert.equal(r.count('a'), 0);
});

test('isFull: enforces the cap', () => {
  const r = new SpectatorRegistry(2);
  assert.equal(r.isFull('a'), false);
  r.add('a');
  assert.equal(r.isFull('a'), false);
  r.add('a');
  assert.equal(r.isFull('a'), true); // at cap
});

test('clear: forgets the room entirely', () => {
  const r = new SpectatorRegistry();
  r.add('a'); r.add('a');
  r.clear('a');
  assert.equal(r.count('a'), 0);
});

test('rooms are independent', () => {
  const r = new SpectatorRegistry();
  r.add('a'); r.add('b'); r.add('b');
  assert.equal(r.count('a'), 1);
  assert.equal(r.count('b'), 2);
});
