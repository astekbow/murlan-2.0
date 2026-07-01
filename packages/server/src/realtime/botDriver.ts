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
  // Per-ROOM tier (practice = the player's chosen difficulty; ranked fill = hard). Plus an
  // optional per-SEAT override so a single room can hold a MIX of difficulties (free-table fill
  // gives each ghost its own level → varied opponents instead of an all-hard wall).
  private readonly seatTiers = new Map<string, Map<number, BotTier>>(); // roomId → seat → tier

  setTier(roomId: string, tier: BotTier): void {
    this.tiers.set(roomId, tier);
  }
  /** Override ONE seat's difficulty (used to mix tiers when filling a free table). */
  setSeatTier(roomId: string, seat: number, tier: BotTier): void {
    const m = this.seatTiers.get(roomId) ?? new Map<number, BotTier>();
    m.set(seat, tier);
    this.seatTiers.set(roomId, m);
  }
  /** A bot's difficulty: the seat override if set, else the room tier, else 'hard' (strong default). */
  tier(roomId: string, seat?: number): BotTier {
    if (seat != null) {
      const s = this.seatTiers.get(roomId)?.get(seat);
      if (s) return s;
    }
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
    this.seatTiers.delete(roomId);
    this.seen.delete(roomId);
  }
}
