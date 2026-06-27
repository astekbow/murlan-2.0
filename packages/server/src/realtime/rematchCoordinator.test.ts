import test from 'node:test';
import assert from 'node:assert/strict';
import { RematchCoordinator } from './rematchCoordinator.ts';

test('open: seeds accepts (bots), sets a deadline, and returns the live offer', () => {
  const c = new RematchCoordinator();
  assert.equal(c.has('r1'), false);
  const offer = c.open('r1', 10_000, ['bot_a', 'bot_b'], () => {});
  assert.equal(c.has('r1'), true);
  assert.deepEqual([...offer.users].sort(), ['bot_a', 'bot_b']);
  assert.ok(offer.deadline > 0);
  // the returned offer is the live object — the gateway adds the human directly
  offer.users.add('human');
  assert.equal(c.get('r1')!.users.has('human'), true);
  c.clear('r1');
});

test('clear: drops the offer and is idempotent', () => {
  const c = new RematchCoordinator();
  c.open('r1', 10_000, [], () => {});
  c.clear('r1');
  assert.equal(c.has('r1'), false);
  c.clear('r1'); // no throw on a second clear
  assert.equal(c.get('r1'), undefined);
});

test('the expiry timer fires onTimeout (and clear cancels it)', async () => {
  const fired: string[] = [];
  const c = new RematchCoordinator();
  c.open('r1', 5, [], () => fired.push('r1'));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fired, ['r1']);

  // A cleared offer's timer must NOT fire.
  c.open('r2', 30, [], () => fired.push('r2'));
  c.clear('r2');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fired, ['r1']); // r2 never fired
});
