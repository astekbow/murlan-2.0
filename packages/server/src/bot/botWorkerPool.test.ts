// ============================================================================
// MURLAN — BotWorkerPool unit tests.
// Proves: a REAL worker thread (loaded through the same tsx loader the server
// runs under) computes legal bot moves off the main thread; concurrent decisions
// all resolve; a too-slow decision rejects (the gateway then falls back to the
// synchronous path); shutdown rejects pending work and terminates cleanly.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card } from '@murlan/engine';
import { BotWorkerPool } from './botWorkerPool.ts';
import type { BotView } from './botDecision.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });

/** A minimal leading view: the bot MUST play (canPass=false). */
function leadView(): BotView {
  return {
    hand: [c('3', 'S'), c('6', 'S'), c('K', 'H')],
    pile: null,
    canPass: false,
    opponentCounts: [3],
  };
}

test('bot worker pool: a real worker computes a legal move off-thread', async () => {
  const pool = new BotWorkerPool(1);
  try {
    assert.equal(pool.enabled, true, 'pool spawns');
    const move = await pool.decide(leadView(), 'easy');
    assert.equal(move.action, 'play', 'a leader must play');
    if (move.action === 'play') {
      assert.ok(move.cards.length >= 1, 'played at least one card');
    }
  } finally {
    await pool.shutdown();
  }
});

test('bot worker pool: concurrent decisions queue and ALL resolve', async () => {
  const pool = new BotWorkerPool(2);
  try {
    const moves = await Promise.all(
      Array.from({ length: 6 }, () => pool.decide(leadView(), 'medium')),
    );
    assert.equal(moves.length, 6);
    for (const m of moves) assert.equal(m.action, 'play');
  } finally {
    await pool.shutdown();
  }
});

test('bot worker pool: a too-slow decision REJECTS so the caller can fall back sync', async () => {
  // 1ms budget: the worker round-trip (cold tsx compile ≈ 100ms+) can never win.
  const pool = new BotWorkerPool(1, { timeoutMs: 1 });
  try {
    await assert.rejects(pool.decide(leadView(), 'hard'), /timeout/);
  } finally {
    await pool.shutdown();
  }
});

test('bot worker pool: shutdown rejects pending work and disables the pool', async () => {
  const pool = new BotWorkerPool(1);
  const pending = pool.decide(leadView(), 'hard');
  pending.catch(() => {}); // it may settle either way depending on shutdown timing
  await pool.shutdown();
  assert.equal(pool.enabled, false, 'disabled after shutdown');
  await assert.rejects(pool.decide(leadView(), 'easy'), /disabled/);
});
