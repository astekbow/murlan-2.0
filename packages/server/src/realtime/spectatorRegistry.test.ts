import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectatorRegistry } from './spectatorRegistry.ts';

test('add/remove/count: tracks per-room by key and drops the entry at zero', () => {
  const r = new SpectatorRegistry(3);
  assert.equal(r.count('a'), 0);
  r.add('a', 's1', 'Ana'); r.add('a', 's2', 'Bob');
  assert.equal(r.count('a'), 2);
  r.remove('a', 's1');
  assert.equal(r.count('a'), 1);
  r.remove('a', 's2');
  assert.equal(r.count('a'), 0); // entry dropped
  r.remove('a', 's2'); // removing an unknown key is safe (stays 0)
  assert.equal(r.count('a'), 0);
});

test('add is idempotent by key (a re-watch does not double-count)', () => {
  const r = new SpectatorRegistry();
  r.add('a', 's1', 'Ana'); r.add('a', 's1', 'Ana');
  assert.equal(r.count('a'), 1);
});

test('names: returns the watching usernames', () => {
  const r = new SpectatorRegistry();
  r.add('a', 's1', 'Ana'); r.add('a', 's2', 'Bob');
  assert.deepEqual(r.names('a'), ['Ana', 'Bob']);
  assert.deepEqual(r.names('empty'), []);
});

test('isFull: enforces the cap', () => {
  const r = new SpectatorRegistry(2);
  assert.equal(r.isFull('a'), false);
  r.add('a', 's1', 'Ana');
  assert.equal(r.isFull('a'), false);
  r.add('a', 's2', 'Bob');
  assert.equal(r.isFull('a'), true); // at cap
});

test('clear: forgets the room entirely', () => {
  const r = new SpectatorRegistry();
  r.add('a', 's1', 'Ana'); r.add('a', 's2', 'Bob');
  r.clear('a');
  assert.equal(r.count('a'), 0);
});

test('rooms are independent', () => {
  const r = new SpectatorRegistry();
  r.add('a', 's1', 'Ana'); r.add('b', 's2', 'Bob'); r.add('b', 's3', 'Cy');
  assert.equal(r.count('a'), 1);
  assert.equal(r.count('b'), 2);
});
