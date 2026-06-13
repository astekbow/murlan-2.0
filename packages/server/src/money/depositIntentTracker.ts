// Lightweight in-memory deposit intents — a player declares "I'm about to deposit
// ~$X" before sending. Two purposes:
//   1) Reduce the TxID claim-race: a player must have an OPEN intent to claim a
//      TxID, so a stranger can't drive-by-claim a deposit they see on the explorer.
//   2) Attribution: the unclaimed-deposit watcher matches an arrived deposit to an
//      open intent BY AMOUNT to suggest WHO it likely belongs to.
// In-memory (reset on restart): an interrupted deposit just re-clicks "start" — the
// funds are safe on-chain and the watcher still surfaces anything stuck.

export interface DepositIntent {
  userId: string;
  amountCents: number;
  createdAt: number;
}

export class DepositIntentTracker {
  private readonly byUser = new Map<string, DepositIntent>(); // latest intent per user

  constructor(private readonly now: () => number = () => Date.now(), private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  open(userId: string, amountCents: number): void {
    this.prune();
    this.byUser.set(userId, { userId, amountCents: Math.max(0, Math.round(amountCents) || 0), createdAt: this.now() });
  }

  hasOpen(userId: string): boolean {
    const i = this.byUser.get(userId);
    return !!i && this.now() - i.createdAt <= this.ttlMs;
  }

  consume(userId: string): void {
    this.byUser.delete(userId);
  }

  /** Open intents whose declared amount is within `tolCents` of `amountCents`. */
  matchByAmount(amountCents: number, tolCents = 0): DepositIntent[] {
    this.prune();
    return [...this.byUser.values()].filter((i) => i.amountCents > 0 && Math.abs(i.amountCents - amountCents) <= tolCents);
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.byUser) if (v.createdAt < cutoff) this.byUser.delete(k);
  }
}
