// ============================================================================
// MURLAN — Bot state & timers
// ----------------------------------------------------------------------------
// Extracted from the gateway god-object (audit M5/ARCH-1). Owns ONLY the bot
// bookkeeping: which rooms are bot-driven + at what difficulty (tiers), the pending
// per-room bot-move timer, the per-user ranked "no human → vs-bot fallback" timer,
// and the bot's per-game card-counting memory. The DECISION + PLAY logic (driveBot,
// formRankedVsBots) stays in the gateway — it reads the live room/match and applies
// moves. This is a behavior-preserving state lift: the gateway keeps its bot methods,
// delegating storage + timer lifecycle here. Verified by the realtime flow tests.
// ============================================================================

import type { Card } from '@murlan/engine';
import type { BotTier } from '../bot/botDecision.ts';

export class BotDriver {
  private readonly tiers = new Map<string, BotTier>(); // roomId → difficulty (presence ⇒ bot room)
  private readonly moveTimers = new Map<string, ReturnType<typeof setTimeout>>(); // roomId → pending bot move
  private readonly rankedFillTimers = new Map<string, ReturnType<typeof setTimeout>>(); // userId → vs-bot fallback
  private readonly seen = new Map<string, Card[]>(); // roomId → cards played this game (card-counting)

  // --- tiers (a tracked tier marks the room as bot-driven) ------------------
  setTier(roomId: string, tier: BotTier): void {
    this.tiers.set(roomId, tier);
  }
  /** The room's bot difficulty; 'hard' (the strong brain) when untracked — matches prior default. */
  tier(roomId: string): BotTier {
    return this.tiers.get(roomId) ?? 'hard';
  }
  hasTier(roomId: string): boolean {
    return this.tiers.has(roomId);
  }

  // --- per-room bot-move timer (replaces any pending one; auto-clears on fire) ---
  scheduleMove(roomId: string, delayMs: number, run: () => void): void {
    const prev = this.moveTimers.get(roomId);
    if (prev) clearTimeout(prev);
    this.moveTimers.set(roomId, setTimeout(() => { this.moveTimers.delete(roomId); run(); }, delayMs));
  }
  cancelMove(roomId: string): void {
    const t = this.moveTimers.get(roomId);
    if (t) { clearTimeout(t); this.moveTimers.delete(roomId); }
  }

  // --- per-user ranked solo-queue → vs-bot fallback timer (idempotent arm) ----
  armRankedFill(userId: string, delayMs: number, run: () => void): void {
    this.cancelRankedFill(userId); // never stack two timers for a user
    this.rankedFillTimers.set(userId, setTimeout(() => { this.rankedFillTimers.delete(userId); run(); }, delayMs));
  }
  cancelRankedFill(userId: string): void {
    const t = this.rankedFillTimers.get(userId);
    if (t) { clearTimeout(t); this.rankedFillTimers.delete(userId); }
  }

  // --- bot card-counting memory (cards seen this game) -----------------------
  seenCards(roomId: string): Card[] {
    return this.seen.get(roomId) ?? [];
  }
  appendSeen(roomId: string, cards: readonly Card[]): void {
    const arr = this.seen.get(roomId) ?? [];
    arr.push(...cards);
    this.seen.set(roomId, arr);
  }
  resetSeen(roomId: string): void {
    this.seen.set(roomId, []);
  }

  /** Drop a room's bot state (tier + pending move timer + card memory) on teardown. */
  teardown(roomId: string): void {
    this.cancelMove(roomId);
    this.tiers.delete(roomId);
    this.seen.delete(roomId);
  }
}
