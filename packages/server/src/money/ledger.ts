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
  listByUser(userId: string): Promise<Transaction[]>;
  all(): Promise<Transaction[]>;
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

  async listByUser(userId: string): Promise<Transaction[]> {
    return this.rows.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }

  async all(): Promise<Transaction[]> {
    return this.rows.map((r) => ({ ...r }));
  }
}
