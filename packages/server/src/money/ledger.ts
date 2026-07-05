// ============================================================================
// MURLAN — Money ledger (Phase 6)
// ----------------------------------------------------------------------------
// The immutable transactions ledger. Every balance change writes one row here;
// the sum of a user's ledger rows must always equal their stored balance
// (WalletService.reconcile verifies this). All amounts are integer USD cents,
// signed: credits positive, debits negative. NEVER floating point.
// ============================================================================

export type TransactionType =
  | 'deposit'
  | 'withdrawal'
  | 'bet'         // stake debited into a match pot
  | 'payout'      // winnings credited from a pot
  | 'rake'        // house cut (recorded against the house account)
  | 'purchase'    // cosmetic bought from the shop with wallet balance
  | 'transfer_out' // balance SENT to another player (debit on the sender)
  | 'transfer_in'  // balance RECEIVED from another player (credit on the receiver)
  | 'admin_adjust';

export type TransactionStatus = 'pending' | 'completed' | 'failed';

export interface Transaction {
  id: string;
  userId: string;
  type: TransactionType;
  amountCents: number;        // signed
  currency: string;           // 'USD'
  status: TransactionStatus;
  providerRef: string | null; // external id; UNIQUE when present (idempotency)
  matchId: string | null;
  reason: string | null;
  createdAt: number;          // epoch ms
}

export interface NewTransaction {
  userId: string;
  type: TransactionType;
  amountCents: number;
  currency?: string;
  status?: TransactionStatus;
  providerRef?: string | null;
  matchId?: string | null;
  reason?: string | null;
}

export class DuplicateProviderRefError extends Error {
  constructor(public readonly providerRef: string) {
    super(`transaction with providerRef ${providerRef} already exists`);
    this.name = 'DuplicateProviderRefError';
  }
}

export interface LedgerRepository {
  append(tx: NewTransaction): Promise<Transaction>;
  /**
   * Insert a row whose providerRef must be unique. If a row with that
   * providerRef already exists, return it WITHOUT inserting and with
   * created=false — no error, so it never aborts an enclosing DB transaction
   * (this is the idempotency primitive for credits/rake on Postgres).
   */
  appendIdempotent(tx: NewTransaction & { providerRef: string }): Promise<{ transaction: Transaction; created: boolean }>;
  findByProviderRef(ref: string): Promise<Transaction | null>;
  /**
   * A user's ledger rows. With NO opts this returns EVERY row (unchanged behavior —
   * the reconcile/RG/VIP aggregates depend on a complete scan). With `opts` it returns
   * a bounded, newest-first page for display lists (HTTP transaction history / export):
   *   • take   — max rows (the caller clamps to a sane ceiling),
   *   • cursor — a transaction id; rows strictly OLDER than it are returned (keyset).
   */
  listByUser(userId: string, opts?: LedgerPageOpts): Promise<Transaction[]>;
  all(): Promise<Transaction[]>;
  /**
   * OPTIONAL DB aggregate: the sum of |amountCents| for a user's rows of a given type
   * (e.g. the HOUSE account's 'rake' total — money-23), computed in the DB instead of a
   * whole-table JS scan. Returns the absolute-value sum. When unimplemented, callers
   * fall back to summing listByUser(). (db-6)
   */
  sumByUserAndType?(userId: string, type: TransactionType): Promise<number>;
  /**
   * OPTIONAL DB aggregate (db-6 / dos-2): the SIGNED sum of amountCents for a user's rows
   * whose type is in `types` and whose createdAt >= `sinceMs`. Used by the responsible-
   * gaming hot paths (deposit/loss caps + rg-status) so they don't JS-scan the whole
   * ledger. When unimplemented, callers fall back to listByUser() + the pure summations.
   */
  sumByUserTypesSince?(userId: string, types: TransactionType[], sinceMs: number): Promise<number>;
  /**
   * OPTIONAL DB aggregate (dos-3): COUNT of a user's rows of a given type (e.g. the HOUSE
   * account's 'rake' row count for the revenue view) — a DB COUNT instead of loading every
   * row into JS. When unimplemented, callers fall back to listByUser().length.
   */
  countByUserAndType?(userId: string, type: TransactionType): Promise<number>;
  /**
   * OPTIONAL bounded query (dos-3): a user's rows of a given type with createdAt >= sinceMs,
   * newest-first. Bounds the revenue-breakdown load to a time window instead of the whole
   * (unbounded, ever-growing) house ledger. When unimplemented, callers fall back to
   * listByUser() + a JS filter.
   */
  listByUserTypeSince?(userId: string, type: TransactionType, sinceMs: number): Promise<Transaction[]>;
  /**
   * OPTIONAL DB aggregate (db-1 / perf-1): the signed sum of amountCents GROUPED BY userId,
   * for the reconcile invariant, computed with a single SQL GROUP BY instead of loading the
   * entire ledger into JS. When unimplemented, callers fall back to summing all().
   */
  sumsByUser?(): Promise<Map<string, number>>;
  /**
   * OPTIONAL DB aggregate (db-1 / perf-1): the signed sum of amountCents GROUPED BY matchId
   * (rows with a matchId only), for the per-match conservation check. When unimplemented,
   * callers fall back to summing all().
   */
  sumsByMatch?(): Promise<Map<string, number>>;
}

/** Bounded, keyset-paginated read options for a user's ledger (display lists only). */
export interface LedgerPageOpts {
  take: number;          // max rows to return
  cursor?: string | null; // a transaction id; return rows strictly older than it
}

/** In-memory ledger for tests and single-instance dev (Prisma-backed in prod). */
export class InMemoryLedger implements LedgerRepository {
  private rows: Transaction[] = [];
  private byProviderRef = new Map<string, string>(); // ref -> tx id
  private seq = 0;

  async append(tx: NewTransaction): Promise<Transaction> {
    if (tx.providerRef && this.byProviderRef.has(tx.providerRef)) {
      throw new DuplicateProviderRefError(tx.providerRef);
    }
    this.seq += 1;
    const row: Transaction = {
      id: `tx_${this.seq}`,
      userId: tx.userId,
      type: tx.type,
      amountCents: tx.amountCents,
      currency: tx.currency ?? 'USD',
      status: tx.status ?? 'completed',
      providerRef: tx.providerRef ?? null,
      matchId: tx.matchId ?? null,
      reason: tx.reason ?? null,
      createdAt: Date.now(),
    };
    this.rows.push(row);
    if (row.providerRef) this.byProviderRef.set(row.providerRef, row.id);
    return { ...row };
  }

  async appendIdempotent(tx: NewTransaction & { providerRef: string }): Promise<{ transaction: Transaction; created: boolean }> {
    const existingId = this.byProviderRef.get(tx.providerRef);
    if (existingId) {
      const existing = this.rows.find((r) => r.id === existingId)!;
      return { transaction: { ...existing }, created: false };
    }
    return { transaction: await this.append(tx), created: true };
  }

  async findByProviderRef(ref: string): Promise<Transaction | null> {
    const id = this.byProviderRef.get(ref);
    return id ? this.rows.find((r) => r.id === id) ?? null : null;
  }

  async listByUser(userId: string, opts?: LedgerPageOpts): Promise<Transaction[]> {
    const mine = this.rows.filter((r) => r.userId === userId);
    if (!opts) return mine.map((r) => ({ ...r })); // unbounded (insertion order) — unchanged
    // Newest-first, keyset paginated. Insertion order is chronological, so reverse.
    const newestFirst = [...mine].reverse();
    let start = 0;
    if (opts.cursor) {
      const idx = newestFirst.findIndex((r) => r.id === opts.cursor);
      start = idx >= 0 ? idx + 1 : 0; // rows strictly after (older than) the cursor
    }
    return newestFirst.slice(start, start + Math.max(0, opts.take)).map((r) => ({ ...r }));
  }

  async all(): Promise<Transaction[]> {
    return this.rows.map((r) => ({ ...r }));
  }

  async sumByUserAndType(userId: string, type: TransactionType): Promise<number> {
    return this.rows
      .filter((r) => r.userId === userId && r.type === type)
      .reduce((s, r) => s + Math.abs(r.amountCents), 0);
  }
  async sumByUserTypesSince(userId: string, types: TransactionType[], sinceMs: number): Promise<number> {
    const set = new Set(types);
    return this.rows
      .filter((r) => r.userId === userId && set.has(r.type) && r.createdAt >= sinceMs)
      .reduce((s, r) => s + r.amountCents, 0); // signed
  }
  async countByUserAndType(userId: string, type: TransactionType): Promise<number> {
    return this.rows.filter((r) => r.userId === userId && r.type === type).length;
  }
  async listByUserTypeSince(userId: string, type: TransactionType, sinceMs: number): Promise<Transaction[]> {
    return this.rows
      .filter((r) => r.userId === userId && r.type === type && r.createdAt >= sinceMs)
      .reverse() // newest-first, matching the Prisma order
      .map((r) => ({ ...r }));
  }
  async sumsByUser(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const r of this.rows) m.set(r.userId, (m.get(r.userId) ?? 0) + r.amountCents);
    return m;
  }
  async sumsByMatch(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const r of this.rows) if (r.matchId) m.set(r.matchId, (m.get(r.matchId) ?? 0) + r.amountCents);
    return m;
  }
}
