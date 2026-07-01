import test from 'node:test';
import assert from 'node:assert/strict';
import { BotDriver } from './botDriver.ts';
import type { Card } from '@murlan/engine';

const card = (rank: number): Card => ({ kind: 'standard', rank, suit: 'spades' } as unknown as Card);

test('tiers: setTier/tier/hasTier with a hard default', () => {
  const d = new BotDriver();
  assert.equal(d.hasTier('r'), false);
  assert.equal(d.tier('r'), 'hard'); // default when untracked
  d.setTier('r', 'easy');
  assert.equal(d.hasTier('r'), true);
  assert.equal(d.tier('r'), 'easy');
});

test('tiers: a per-SEAT override beats the room tier; teardown clears both', () => {
  const d = new BotDriver();
  d.setTier('r', 'medium');
  d.setSeatTier('r', 1, 'easy');
  assert.equal(d.tier('r', 1), 'easy');   // seat override wins (free-table mix)
  assert.equal(d.tier('r', 0), 'medium'); // no override on this seat → room tier
  assert.equal(d.tier('r'), 'medium');    // no seat given → room tier
  d.teardown('r');
  assert.equal(d.tier('r', 1), 'hard');   // cleared → strong default
});

test('scheduleMove: runs after the delay; cancelMove + reschedule cancel the prior timer', async () => {
  const d = new BotDriver();
  const ran: string[] = [];
  d.scheduleMove('r', 5, () => ran.push('first'));
  d.scheduleMove('r', 5, () => ran.push('second')); // replaces the first
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(ran, ['second']); // only the latest fired

  d.scheduleMove('r', 30, () => ran.push('cancelled'));
  d.cancelMove('r');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ran, ['second']); // the cancelled one never fired
});

test('armRankedFill: idempotent per user; cancel stops it', async () => {
  const d = new BotDriver();
  const ran: string[] = [];
  d.armRankedFill('u', 5, () => ran.push('a'));
  d.armRankedFill('u', 5, () => ran.push('b')); // re-arm replaces
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(ran, ['b']);
  d.armRankedFill('u', 30, () => ran.push('c'));
  d.cancelRankedFill('u');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ran, ['b']);
});

test('seen cards: append accumulates, reset clears, teardown drops everything', () => {
  const d = new BotDriver();
  assert.deepEqual(d.seenCards('r'), []);
  d.appendSeen('r', [card(3), card(4)]);
  d.appendSeen('r', [card(5)]);
  assert.equal(d.seenCards('r').length, 3);
  d.resetSeen('r');
  assert.deepEqual(d.seenCards('r'), []);
  d.setTier('r', 'hard');
  d.appendSeen('r', [card(3)]);
  d.teardown('r');
  assert.equal(d.hasTier('r'), false);
  assert.deepEqual(d.seenCards('r'), []);
});
