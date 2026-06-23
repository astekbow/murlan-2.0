// ============================================================================
// MURLAN — Wallet service (Phase 6)
// ----------------------------------------------------------------------------
// The ONE place balances change. Every mutation updates the user's stored
// balance AND appends a ledger row, keeping them reconcilable. Crypto/PayPal
// webhooks and admin top-ups all funnel through credit() — crediting is
// idempotent on providerRef so a retried webhook never double-credits.
// ============================================================================

import type { UserRepository } from '../auth/userRepository.ts';
import type { LedgerRepository, Transaction, TransactionType } from './ledger.ts';
import type { UnitOfWork, WalletTxContext } from './unitOfWork.ts';
import { depositsToday } from '../compliance/responsibleGaming.ts';

/** Synthetic account that accumulates the house rake (ledger-only, no balance). */
export const HOUSE_ACCOUNT_ID = '__house__';

/**
 * Sanity cap on any single movement. Kept BELOW the Postgres `int4` max
 * (2,147,483,647 cents ≈ $21.47M) so a valid app-level amount can never overflow
 * the `Int` money columns (balanceCents/amountCents/potCents/…). $20,000,000 is far
 * above any real stake/pot yet safely under the column ceiling. (If stakes ever need
 * to exceed this, migrate the money columns to BigInt first, then raise this.)
 */
export const MAX_AMOUNT_CENTS = 2_000_000_000; // $20,000,000 (< int4 max)

export class InsufficientFundsError extends Error {
  constructor(public readonly userId: string, public readonly neededCents: number, public readonly availableCents: number) {
    super(`insufficient funds for ${userId}: need ${neededCents}, have ${availableCents}`);
    this.name = 'InsufficientFundsError';
  }
}

/** A deposit credit that would push today's deposits over the player's daily cap. */
export class DepositCapExceededError extends Error {
  constructor(public readonly userId: string, public readonly usedCents: number, public readonly amountCents: number, public readonly capCents: number) {
    super(`deposit cap exceeded for ${userId}: ${usedCents}+${amountCents} > ${capCents}`);
    this.name = 'DepositCapExceededError';
  }
}

export interface CreditOptions {
  type: TransactionType;
  reason?: string;
  providerRef?: string | null;
  matchId?: string | null;
  currency?: string;
  /**
   * Responsible-gaming daily DEPOSIT cap (cents), enforced ATOMICALLY here: the
   * day's deposits are summed from the in-transaction ledger and the credit is
   * rejected (DepositCapExceededError, nothing appended) if it would exceed the cap.
   * Capped deposits are also serialized per user so concurrent webhooks can't both
   * pass (single-instance). Only meaningful with a `providerRef` (the deposit path).
   */
  depositCapCents?: number | null;
}
export interface DebitOptions {
  type: TransactionType;
  reason?: string;
  matchId?: string | null;
  currency?: string;
}

export interface MoveResult {
  transaction: Transaction;
  balanceCents: number;
  idempotent: boolean;
}

export class WalletService {
  constructor(
    private readonly users: UserRepository,
    private readonly ledger: LedgerRepository,
    private readonly uow?: UnitOfWork,
    // True when this instance is bound to an OUTER transaction (via bind()): each
    // op then runs directly on the bound repos with no new transaction, so the
    // caller can compose many movements into one atomic unit.
    private readonly txBound = false,
  ) {}

  /**
   * A wallet bound to an existing transaction context. Every credit/debit/rake
   * runs on the bound repos inside the caller's transaction — letting MoneyService
   * pay all winners + book rake + flip the match status atomically.
   */
  bind(ctx: WalletTxContext): WalletService {
    return new WalletService(ctx.users, ctx.ledger, undefined, true);
  }

  // Per-user serialization for CAPPED deposits: chains each capped deposit for a
  // user after the previous one so two concurrent webhooks can't both read a stale
  // "deposits today" and both pass the cap. Single-instance only — multi-instance
  // needs a DB row-lock / SERIALIZABLE deposit tx (documented follow-up, gated on a
  // real payment provider). Uncapped credits (refunds, payouts, rake) skip this.
  private readonly depositChain = new Map<string, Promise<unknown>>();
  private serializeDeposit<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.depositChain.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run after prev settles, success or failure
    this.depositChain.set(userId, next.catch(() => undefined)); // a rejection must not break the chain
    return next;
  }

  async getBalance(userId: string): Promise<number> {
    const user = await this.users.findById(userId);
    return user?.balanceCents ?? 0;
  }

  /**
   * Run a two-write money op atomically: when bound to an outer transaction, run
   * directly on its repos (no nested tx); else inside our own UnitOfWork
   * transaction (Prisma → both writes commit/roll back together); else directly
   * against the already-atomic in-memory repos.
   */
  private run<T>(fn: (users: UserRepository, ledger: LedgerRepository) => Promise<T>): Promise<T> {
    if (this.txBound) return fn(this.users, this.ledger);
    return this.uow ? this.uow.transaction(({ users, ledger }) => fn(users, ledger)) : fn(this.users, this.ledger);
  }

  /** Run a multi-step money op with a wallet bound to one transaction, so e.g. a transfer's
   *  debit + credit commit or roll back together (Prisma $transaction — no half transfer). */
  private runTx<T>(fn: (w: WalletService) => Promise<T>): Promise<T> {
    if (this.txBound) return fn(this);
    return this.uow ? this.uow.transaction((ctx) => fn(this.bind(ctx))) : fn(this);
  }

  /**
   * Add funds. The ledger row is appended FIRST: its UNIQUE providerRef is the
   * atomic idempotency gate, so a duplicate/concurrent webhook never
   * double-credits — a collision is caught and returned as an idempotent replay.
   * (Production: append + balance update belong in one DB transaction.)
   */
  async credit(userId: string, amountCents: number, opts: CreditOptions): Promise<MoveResult> {
    this.assertAmount(amountCents);
    const doCredit = () => this.run(async (users, ledger) => {
      const balanceOf = async () => (await users.findById(userId))?.balanceCents ?? 0;
      const user = await users.findById(userId);
      if (!user) throw new Error(`user ${userId} not found`);

      // --- Idempotent path: a providerRef makes this credit at-most-once. The
      // insert never raises on a duplicate (ON CONFLICT DO NOTHING), so it can't
      // abort an enclosing Postgres transaction. created=false => replay.
      if (opts.providerRef) {
        // Responsible-gaming deposit cap, enforced ATOMICALLY here (inside the same
        // transaction as the balance write) and BEFORE the append, so a rejected
        // deposit leaves NO ledger row. The current providerRef is excluded from the
        // sum so a retried webhook (its row already present) isn't double-counted —
        // a legitimate replay still falls through to the idempotent return below.
        if (opts.depositCapCents != null) {
          const used = depositsToday(await ledger.listByUser(userId), Date.now(), opts.providerRef);
          if (used + amountCents > opts.depositCapCents) {
            throw new DepositCapExceededError(userId, used, amountCents, opts.depositCapCents);
          }
        }
        const { transaction, created } = await ledger.appendIdempotent({
          userId, type: opts.type, amountCents, currency: opts.currency,
          providerRef: opts.providerRef, matchId: opts.matchId ?? null, reason: opts.reason ?? null,
        });
        if (!created) return { transaction, balanceCents: await balanceOf(), idempotent: true };
        const balanceCents = await users.adjustBalance(userId, amountCents);
        if (balanceCents === null) throw new Error(`failed to apply credit for ${userId}`); // UoW rolls back the insert
        return { transaction, balanceCents, idempotent: false };
      }

      // --- No providerRef: a plain (non-deduplicated) credit, e.g. a refund line.
      const transaction = await ledger.append({
        userId, type: opts.type, amountCents, currency: opts.currency,
        matchId: opts.matchId ?? null, reason: opts.reason ?? null,
      });
      const balanceCents = await users.adjustBalance(userId, amountCents);
      if (balanceCents === null) {
        // In a UoW (or bound to an outer tx) the throw rolls the append back;
        // standalone in-memory, compensate so the ledger still reconciles (only
        // reachable if the account vanished).
        if (!this.uow && !this.txBound) {
          await ledger.append({
            userId, type: opts.type, amountCents: -amountCents, currency: opts.currency,
            matchId: opts.matchId ?? null, reason: `reversal: balance update failed (${transaction.id})`,
          }).catch(() => undefined);
        }
        throw new Error(`failed to apply credit for ${userId}`);
      }
      return { transaction, balanceCents, idempotent: false };
    });
    // Capped deposits run one-at-a-time per user (close the concurrent-webhook race
    // single-instance); everything else (refunds, payouts, rake) credits directly.
    return opts.depositCapCents != null ? this.serializeDeposit(userId, doCredit) : doCredit();
  }

  /**
   * Remove funds, refusing to overdraw. `adjustBalance` is the atomic
   * check-and-decrement; a failed ledger append rolls the balance back (or, in a
   * UoW, the whole transaction rolls back).
   */
  async debit(userId: string, amountCents: number, opts: DebitOptions): Promise<MoveResult> {
    this.assertAmount(amountCents);
    return this.run(async (users, ledger) => {
      const balanceCents = await users.adjustBalance(userId, -amountCents);
      if (balanceCents === null) {
        throw new InsufficientFundsError(userId, amountCents, (await users.findById(userId))?.balanceCents ?? 0);
      }
      try {
        const transaction = await ledger.append({
          userId,
          type: opts.type,
          amountCents: -amountCents,
          currency: opts.currency,
          matchId: opts.matchId ?? null,
          reason: opts.reason ?? null,
        });
        return { transaction, balanceCents, idempotent: false };
      } catch (e) {
        if (!this.uow && !this.txBound) await users.adjustBalance(userId, amountCents); // compensate (a tx rolls back)
        throw e;
      }
    });
  }

  /**
   * Move balance from one player to another ATOMICALLY: debit the sender + credit the
   * receiver in ONE transaction, so it can never half-complete (no money created or lost).
   * Bounds + sufficient-funds are enforced by debit() (throws InsufficientFundsError); a
   * non-existent receiver makes credit() throw and the whole transfer rolls back.
   * POLICY (friends-only, account-state, limits) is the CALLER's responsibility — not here.
   */
  async transfer(
    fromUserId: string,
    toUserId: string,
    amountCents: number,
    opts?: { reason?: string },
  ): Promise<{ balanceCents: number; outTx: Transaction; inTx: Transaction }> {
    this.assertAmount(amountCents);
    if (fromUserId === toUserId) throw new Error('cannot transfer to self');
    return this.runTx(async (w) => {
      const out = await w.debit(fromUserId, amountCents, { type: 'transfer_out', reason: opts?.reason ?? `transfer to ${toUserId}` });
      const credited = await w.credit(toUserId, amountCents, { type: 'transfer_in', reason: `transfer from ${fromUserId}` });
      return { balanceCents: out.balanceCents, outTx: out.transaction, inTx: credited.transaction };
    });
  }

  private assertAmount(amountCents: number): void {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error('amount must be a positive integer (cents)');
    }
    if (amountCents > MAX_AMOUNT_CENTS) {
      throw new Error('amount exceeds the maximum allowed');
    }
  }

  /** Record the house rake (ledger only — the house has no stored balance).
   *  Idempotent when a providerRef is given (a settle retry won't double-book);
   *  routed through the UnitOfWork so it shares the configured transaction. */
  async recordRake(amountCents: number, opts: { matchId?: string | null; reason?: string; providerRef?: string }): Promise<Transaction> {
    if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error('rake must be a non-negative integer');
    return this.run(async (_users, ledger) => {
      if (opts.providerRef) {
        const { transaction } = await ledger.appendIdempotent({
          userId: HOUSE_ACCOUNT_ID, type: 'rake', amountCents,
          matchId: opts.matchId ?? null, reason: opts.reason ?? 'rake', providerRef: opts.providerRef,
        });
        return transaction;
      }
      return ledger.append({ userId: HOUSE_ACCOUNT_ID, type: 'rake', amountCents, matchId: opts.matchId ?? null, reason: opts.reason ?? 'rake' });
    });
  }

  /** Admin manual top-up / deduction. Routes through the same credit/debit path. */
  async adminAdjust(userId: string, deltaCents: number, reason: string): Promise<MoveResult> {
    if (!Number.isInteger(deltaCents) || deltaCents === 0) throw new Error('adjustment must be a non-zero integer');
    return deltaCents > 0
      ? this.credit(userId, deltaCents, { type: 'admin_adjust', reason })
      : this.debit(userId, -deltaCents, { type: 'admin_adjust', reason });
  }

  listTransactions(userId: string): Promise<Transaction[]> {
    return this.ledger.listByUser(userId);
  }

  /** Verify every real user's stored balance equals the sum of their ledger rows. */
  async reconcile(): Promise<{ ok: boolean; mismatches: Array<{ userId: string; balanceCents: number; ledgerSum: number }> }> {
    const all = await this.ledger.all();
    const sums = new Map<string, number>();
    for (const tx of all) sums.set(tx.userId, (sums.get(tx.userId) ?? 0) + tx.amountCents);

    const mismatches: Array<{ userId: string; balanceCents: number; ledgerSum: number }> = [];
    for (const [userId, ledgerSum] of sums) {
      if (userId === HOUSE_ACCOUNT_ID) continue; // house is ledger-only
      const balanceCents = await this.getBalance(userId);
      if (balanceCents !== ledgerSum) mismatches.push({ userId, balanceCents, ledgerSum });
    }
    return { ok: mismatches.length === 0, mismatches };
  }

  /**
   * Sum every ledger row grouped by matchId. A fully-resolved match (settled or
   * refunded) must sum to exactly 0: bets in === payouts + rake out. A non-zero
   * sum for a closed match means the rake/payout split lost or minted money.
   */
  async matchLedgerSums(): Promise<Map<string, number>> {
    const all = await this.ledger.all();
    const sums = new Map<string, number>();
    for (const tx of all) {
      if (!tx.matchId) continue;
      sums.set(tx.matchId, (sums.get(tx.matchId) ?? 0) + tx.amountCents);
    }
    return sums;
  }
}
