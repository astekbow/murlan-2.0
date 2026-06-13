// ============================================================================
// MURLAN — Withdrawals (Phase 6, spec §5.4)
// ----------------------------------------------------------------------------
// A withdrawal debits the balance immediately (the funds are held) and creates
// a PENDING record. An admin approves (external payout assumed done) or rejects
// (funds refunded). Basic per-request limits are enforced.
// ============================================================================

import { WalletService, InsufficientFundsError } from './walletService.ts';

export type WithdrawalStatus = 'pending' | 'completed' | 'rejected';

export interface WithdrawalRecord {
  id: string;
  userId: string;
  amountCents: number;
  destination: string; // crypto address or PayPal email
  status: WithdrawalStatus;
  createdAt: number;
  resolvedAt: number | null;
}

export interface WithdrawalRepository {
  create(r: Omit<WithdrawalRecord, 'id' | 'status' | 'createdAt' | 'resolvedAt'>): Promise<WithdrawalRecord>;
  find(id: string): Promise<WithdrawalRecord | null>;
  /**
   * Atomically transition ONLY a 'pending' row to `status`. Returns the updated
   * record if this call performed the transition, or null if it was already
   * resolved (the compare-and-set lost the race) — so approve/reject act once.
   */
  setStatusIfPending(id: string, status: WithdrawalStatus): Promise<WithdrawalRecord | null>;
  /** Flip a 'completed' withdrawal to 'rejected' (used when a paid-out payout later
   *  failed on-chain and was reversed) — so it's deduped + excluded from the daily cap. */
  markReversed(id: string): Promise<void>;
  listPending(): Promise<WithdrawalRecord[]>;
  listByUser(userId: string): Promise<WithdrawalRecord[]>;
}

export class InMemoryWithdrawals implements WithdrawalRepository {
  private rows: WithdrawalRecord[] = [];
  private seq = 0;

  async create(r: Omit<WithdrawalRecord, 'id' | 'status' | 'createdAt' | 'resolvedAt'>): Promise<WithdrawalRecord> {
    this.seq += 1;
    const rec: WithdrawalRecord = { ...r, id: `wd_${this.seq}`, status: 'pending', createdAt: Date.now(), resolvedAt: null };
    this.rows.push(rec);
    return { ...rec };
  }
  async find(id: string): Promise<WithdrawalRecord | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async setStatusIfPending(id: string, status: WithdrawalStatus): Promise<WithdrawalRecord | null> {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.status !== 'pending') return null; // already resolved
    r.status = status;
    r.resolvedAt = Date.now();
    return { ...r };
  }
  async markReversed(id: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r && r.status === 'completed') { r.status = 'rejected'; r.resolvedAt = Date.now(); }
  }
  async listPending(): Promise<WithdrawalRecord[]> {
    return this.rows.filter((r) => r.status === 'pending').map((r) => ({ ...r }));
  }
  async listByUser(userId: string): Promise<WithdrawalRecord[]> {
    return this.rows.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }
}

export class WithdrawalError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WithdrawalError';
  }
}

export interface WithdrawalLimits {
  minCents: number;
  maxCents: number;
}

export class WithdrawalService {
  constructor(
    private readonly wallet: WalletService,
    private readonly repo: WithdrawalRepository,
    private readonly limits: WithdrawalLimits = { minCents: 500, maxCents: 1_000_000 },
  ) {}

  /** Request a withdrawal: validate limits, hold the funds, create a pending row. */
  async request(userId: string, amountCents: number, destination: string): Promise<WithdrawalRecord> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new WithdrawalError('bad_amount', 'Shumë e pavlefshme.');
    if (amountCents < this.limits.minCents) throw new WithdrawalError('below_min', `Tërheqja minimale është ${this.limits.minCents} cent.`);
    if (amountCents > this.limits.maxCents) throw new WithdrawalError('above_max', 'Tërheqja kalon limitin maksimal.');
    if (!destination || destination.trim().length < 4) throw new WithdrawalError('bad_destination', 'Destinacioni i tërheqjes mungon.');

    try {
      await this.wallet.debit(userId, amountCents, { type: 'withdrawal', reason: 'kërkesë tërheqjeje' });
    } catch (e) {
      if (e instanceof InsufficientFundsError) throw new WithdrawalError('insufficient_funds', 'Bilanc i pamjaftueshëm.');
      throw e;
    }
    try {
      return await this.repo.create({ userId, amountCents, destination });
    } catch (e) {
      // The balance was already debited but the record didn't persist → refund it so
      // the funds aren't stuck in a phantom hold with no withdrawal to resolve.
      await this.wallet.credit(userId, amountCents, { type: 'admin_adjust', reason: 'rikthim: krijimi i tërheqjes dështoi' }).catch(() => {});
      throw e;
    }
  }

  /** Admin marks a withdrawal paid out externally. Atomic, acts at most once. */
  async approve(id: string): Promise<WithdrawalRecord> {
    const rec = await this.repo.find(id);
    if (!rec) throw new WithdrawalError('not_found', 'Tërheqja nuk u gjet.');
    const claimed = await this.repo.setStatusIfPending(id, 'completed');
    if (!claimed) throw new WithdrawalError('not_pending', 'Tërheqja nuk është në pritje.');
    return claimed;
  }

  /**
   * Admin rejects a withdrawal and refunds the held funds. Concurrency-safe:
   * the refund credit carries a deterministic providerRef so it can credit AT
   * MOST ONCE, and the status transition is an atomic compare-and-set.
   */
  async reject(id: string): Promise<WithdrawalRecord> {
    const rec = await this.repo.find(id);
    if (!rec) throw new WithdrawalError('not_found', 'Tërheqja nuk u gjet.');
    if (rec.status !== 'pending') throw new WithdrawalError('not_pending', 'Tërheqja nuk është në pritje.');
    // CLAIM the transition FIRST (atomic compare-and-set). Only the winner refunds —
    // so a concurrent approve() (which already paid out) can't also trigger a refund
    // here (that would be a double-pay). The loser of the race throws not_pending.
    const claimed = await this.repo.setStatusIfPending(id, 'rejected');
    if (!claimed) throw new WithdrawalError('not_pending', 'Tërheqja nuk është në pritje.');
    // Idempotent refund (providerRef): safe even if this path somehow re-runs.
    await this.wallet.credit(rec.userId, rec.amountCents, {
      type: 'admin_adjust',
      reason: 'rikthim tërheqjeje',
      providerRef: `withdrawal_refund:${id}`,
    });
    return claimed;
  }

  listPending(): Promise<WithdrawalRecord[]> {
    return this.repo.listPending();
  }
  listByUser(userId: string): Promise<WithdrawalRecord[]> {
    return this.repo.listByUser(userId);
  }
  find(id: string): Promise<WithdrawalRecord | null> {
    return this.repo.find(id);
  }
  markReversed(id: string): Promise<void> {
    return this.repo.markReversed(id);
  }
}
