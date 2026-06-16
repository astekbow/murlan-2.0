// ============================================================================
// MURLAN — auto-credit deposit poller (no manual TxID needed)
// ----------------------------------------------------------------------------
// Each player has a UNIQUE watch-only TRON deposit address, so an on-chain USDT
// transfer ALREADY identifies the player — the manual TxID step is only a fallback
// now. This watches the addresses of players who are ACTIVELY depositing (they just
// opened the deposit screen) and auto-credits new transfers, idempotently on the
// TxID (a transfer credits at most once, even across cycles/restarts).
//
// SCALE: we poll only the WATCHED set (active depositors within a short TTL), not
// every assigned address — so idle cost is zero and TronGrid requests stay
// proportional to people depositing right now, not total users. Single-instance
// (in-memory registry), like the wallet/tournament locks; multi-instance would back
// the registry with Redis (documented follow-up).
// ============================================================================

const DEFAULT_WATCH_MS = 30 * 60 * 1000; // watch an address for 30 min after the deposit screen is opened

/** Tracks which player addresses to actively poll. Populated when a player opens the
 *  deposit screen (GET /deposit/address); entries expire after `ttlMs`. */
export class DepositWatchRegistry {
  private readonly map = new Map<string, { userId: string; until: number }>(); // key: address
  constructor(
    private readonly ttlMs: number = DEFAULT_WATCH_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Mark a player's address as actively-watched (refreshes the TTL on each call). */
  markWatching(address: string | null | undefined, userId: string): void {
    if (!address) return;
    this.map.set(address, { userId, until: this.now() + this.ttlMs });
    // Opportunistic prune so the map can't grow unbounded even if active() is never
    // called (e.g. the poller is disabled but the deposit screen is still opened).
    if (this.map.size > 5000) this.prune();
  }

  /** Drop every expired entry. */
  private prune(): void {
    const now = this.now();
    for (const [address, v] of this.map) if (v.until < now) this.map.delete(address);
  }

  /** The currently-watched {address,userId} pairs; prunes expired entries as a side effect. */
  active(): Array<{ address: string; userId: string }> {
    const now = this.now();
    const out: Array<{ address: string; userId: string }> = [];
    for (const [address, v] of this.map) {
      if (v.until < now) { this.map.delete(address); continue; }
      out.push({ address, userId: v.userId });
    }
    return out;
  }

  get size(): number { return this.map.size; }
}

/** Outcome of attempting to credit one on-chain transfer.
 *  - credited  : a fresh credit was applied
 *  - replay    : already credited (idempotent no-op)
 *  - over_cap  : exceeds the player's self-imposed daily deposit cap → NOT credited
 *  - blocked   : account frozen/banned OR non-compliant (self-excluded/KYC/geo) → NOT credited
 *  (over_cap + blocked: the funds arrived on-chain but can't be auto-credited → alert + leave.) */
export type CreditOutcome = 'credited' | 'replay' | 'over_cap' | 'blocked';

export interface DepositPollDeps {
  watched: Array<{ address: string; userId: string }>;
  listIncoming: (address: string) => Promise<Array<{ txId: string; amountCents: number; from: string }>>;
  // Credit the owning player idempotently on txId — applying the SAME gates as the manual
  // route (account-state + compliance + daily cap). Returns the outcome (see CreditOutcome).
  credit: (userId: string, amountCents: number, txId: string) => Promise<CreditOutcome>;
  minCents: number;               // skip transfers below this (matches the manual route's min)
  alertedSkipped: Set<string>;    // txIds already alerted as not-credited (over_cap/blocked) → ping once
  notify?: (text: string) => Promise<void>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * One auto-credit cycle. For each actively-watched address: list incoming USDT
 * transfers and credit the owning player. Idempotent on txId (the credit fn dedups via
 * its providerRef), so re-seeing a transfer across cycles never double-credits. Errors
 * are isolated PER ADDRESS / PER TRANSFER — one failure never blocks the rest, and the
 * function never throws. Returns the count of FRESH credits applied this cycle.
 */
export async function pollDepositsOnce(deps: DepositPollDeps): Promise<number> {
  let fresh = 0;
  for (const { address, userId } of deps.watched) {
    let transfers: Array<{ txId: string; amountCents: number; from: string }>;
    try {
      transfers = await deps.listIncoming(address);
    } catch {
      continue; // a single address's read failure must not block the others
    }
    for (const tr of transfers) {
      if (tr.amountCents < deps.minCents) continue; // below min → leave it (manual/operator)
      let outcome: CreditOutcome;
      try {
        outcome = await deps.credit(userId, tr.amountCents, tr.txId);
      } catch (err) {
        // A credit error (e.g. the user was deleted, or a transient DB blip) must not block
        // the batch — but DON'T swallow it: the funds arrived on-chain, so surface it so a
        // stuck deposit is visible/recoverable (it retries next cycle, idempotent).
        deps.log?.('auto-credit FAILED for an on-chain deposit (retries next cycle)', { userId, amountCents: tr.amountCents, txId: tr.txId, err: String(err) });
        continue;
      }
      if (outcome === 'credited') {
        fresh += 1;
        deps.log?.('auto-credited USDT-TRC20 deposit', { userId, amountCents: tr.amountCents, txId: tr.txId });
        if (deps.notify) await deps.notify(`💰 Auto-depozitë USDT $${(tr.amountCents / 100).toFixed(2)} → ${userId} (tx ${tr.txId.slice(0, 10)}…)`).catch(() => undefined);
      } else if ((outcome === 'over_cap' || outcome === 'blocked') && !deps.alertedSkipped.has(tr.txId)) {
        // Funds arrived on-chain but can't be auto-credited — over the self-imposed daily
        // cap, or the account is frozen / non-compliant. Don't credit; ping the operator
        // ONCE to resolve manually. Bound the dedupe set so it can't grow forever.
        deps.alertedSkipped.add(tr.txId);
        if (deps.alertedSkipped.size > 10_000) {
          for (const k of deps.alertedSkipped) { deps.alertedSkipped.delete(k); if (deps.alertedSkipped.size <= 8_000) break; }
        }
        const reason = outcome === 'over_cap' ? 'mbi kufirin ditor' : 'llogari e bllokuar/jo-konforme';
        if (deps.notify) await deps.notify(`⚠️ Depozitë USDT PA kredituar (${reason}): $${(tr.amountCents / 100).toFixed(2)} → ${userId} (tx ${tr.txId.slice(0, 10)}…). Shqyrtoje manualisht.`).catch(() => undefined);
      }
    }
  }
  return fresh;
}
