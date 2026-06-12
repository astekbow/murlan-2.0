import { test } from 'vitest';
import assert from 'node:assert/strict';
import { formatDuration } from './realityCheck.ts';

test('formatDuration: minutes, hours, and combined', () => {
  assert.equal(formatDuration(0), '0 min');
  assert.equal(formatDuration(30 * 60_000), '30 min');
  assert.equal(formatDuration(60 * 60_000), '1 orë');
  assert.equal(formatDuration(65 * 60_000), '1 orë 5 min');
  assert.equal(formatDuration(125 * 60_000), '2 orë 5 min');
  assert.equal(formatDuration(-5000), '0 min'); // clamps negatives
});
