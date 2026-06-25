// ============================================================================
// MURLAN — Withdrawals (Phase 6, spec §5.4)
// ----------------------------------------------------------------------------
// A withdrawal debits the balance immediately (the funds are held) and creates
// a PENDING record. An admin approves (external payout assumed done) or rejects
// (funds refunded). Basic per-request limits are enforced.
// ============================================================================

import { WalletService, InsufficientFundsError } from './walletService.ts';
import type { UnitOfWork } from './unitOfWork.ts';
import type { PayoutProvider, PayoutResult } from './payoutProvider.ts';
import { isValidTronAddress } from './tronAddress.ts';

export type WithdrawalStatus = 'pending' | 'completed' | 'rejected';

export interface WithdrawalRecord {
  id: string;
  userId: string;
  amountCents: number;
  destination: string; // crypto address or PayPal email
  status: WithdrawalStatus;
  createdAt: number;
  resolvedAt: number | null;
  // Audit/dispute trail (populated as the withdrawal progresses; null until known).
  providerRef: string | null;       // payout provider's withdrawal/batch id (e.g. Binance)
  network: string | null;           // payout network actually used (e.g. TRX)
  txHash: string | null;            // on-chain tx hash once known
  resolvedByAdminId: string | null; // admin who approved/rejected (null = auto/system)
  failureReason: string | null;     // short reason when a payout fails/reverses
}

/** Audit fields recorded when a withdrawal is resolved (all optional). */
export interface WithdrawalResolution {
  resolvedByAdminId?: string | null;
  providerRef?: string | null;
  network?: string | null;
  txHash?: string | null;
  failureReason?: string | null;
}

export interface WithdrawalRepository {
  create(r: Omit<WithdrawalRecord, 'id' | 'status' | 'createdAt' | 'resolvedAt' | 'providerRef' | 'network' | 'txHash' | 'resolvedByAdminId' | 'failureReason'>): Promise<WithdrawalRecord>;
  find(id: string): Promise<WithdrawalRecord | null>;
  /**
   * Atomically transition ONLY a 'pending' row to `status`, optionally stamping
   * audit fields. Returns the updated record if this call performed the transition,
   * or null if it was already resolved (the compare-and-set lost the race) — so
   * approve/reject act once.
   */
  setStatusIfPending(id: string, status: WithdrawalStatus, audit?: WithdrawalResolution): Promise<WithdrawalRecord | null>;
  /** Flip a 'completed' withdrawal to 'rejected' (used when a paid-out payout later
   *  failed on-chain and was reversed) — so it's deduped + excluded from the daily cap. */
  markReversed(id: string): Promise<void>;
  /** Stamp audit fields (providerRef/network/txHash/failureReason) on an existing row
   *  WITHOUT changing its status — used to record the payout ref AFTER a send. */
  setAudit(id: string, audit: WithdrawalResolution): Promise<void>;
  listPending(): Promise<WithdrawalRecord[]>;
  /** A user's withdrawals, newest-first, BOUNDED by `limit` (default cap) so a user-facing
   *  history never loads an unbounded set (dos-2). */
  listByUser(userId: string, limit?: number): Promise<WithdrawalRecord[]>;
  /** Every COMPLETED withdrawal resolved at/after `sinceMs` — for the global + per-destination
   *  rolling-24h auto-payout caps (money-7). Single-instance aggregate (one replica). */
  listCompletedSince(sinceMs: number): Promise<WithdrawalRecord[]>;
}

/** Default + max page size for a user's withdrawal history (dos-2 bound). */
export const WITHDRAWALS_PAGE_DEFAULT = 100;

export class InMemoryWithdrawals implements WithdrawalRepository {
  private rows: WithdrawalRecord[] = [];
  private seq = 0;

  async create(r: Omit<WithdrawalRecord, 'id' | 'status' | 'createdAt' | 'resolvedAt' | 'providerRef' | 'network' | 'txHash' | 'resolvedByAdminId' | 'failureReason'>): Promise<WithdrawalRecord> {
    this.seq += 1;
    const rec: WithdrawalRecord = {
      ...r, id: `wd_${this.seq}`, status: 'pending', createdAt: Date.now(), resolvedAt: null,
      providerRef: null, network: null, txHash: null, resolvedByAdminId: null, failureReason: null,
    };
    this.rows.push(rec);
    return { ...rec };
  }
  async find(id: string): Promise<WithdrawalRecord | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async setStatusIfPending(id: string, status: WithdrawalStatus, audit?: WithdrawalResolution): Promise<WithdrawalRecord | null> {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.status !== 'pending') return null; // already resolved
    r.status = status;
    r.resolvedAt = Date.now();
    if (audit) {
      if (audit.resolvedByAdminId !== undefined) r.resolvedByAdminId = audit.resolvedByAdminId;
      if (audit.providerRef !== undefined) r.providerRef = audit.providerRef;
      if (audit.network !== undefined) r.network = audit.network;
      if (audit.txHash !== undefined) r.txHash = audit.txHash;
      if (audit.failureReason !== undefined) r.failureReason = audit.failureReason;
    }
    return { ...r };
  }
  async markReversed(id: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r && r.status === 'completed') { r.status = 'rejected'; r.resolvedAt = Date.now(); r.failureReason = 'payout failed on-chain (auto-reversed)'; }
  }
  async setAudit(id: string, audit: WithdrawalResolution): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return;
    if (audit.providerRef !== undefined) r.providerRef = audit.providerRef;
    if (audit.network !== undefined) r.network = audit.network;
    if (audit.txHash !== undefined) r.txHash = audit.txHash;
    if (audit.failureReason !== undefined) r.failureReason = audit.failureReason;
  }
  async listPending(): Promise<WithdrawalRecord[]> {
    return this.rows.filter((r) => r.status === 'pending').map((r) => ({ ...r }));
  }
  async listByUser(userId: string, limit = WITHDRAWALS_PAGE_DEFAULT): Promise<WithdrawalRecord[]> {
    const lim = Math.max(1, Math.min(WITHDRAWALS_PAGE_DEFAULT, Math.floor(limit)));
    return this.rows
      .filter((r) => r.userId === userId)
      .slice() // newest-first (rows are appended chronologically)
      .reverse()
      .slice(0, lim)
      .map((r) => ({ ...r }));
  }
  async listCompletedSince(sinceMs: number): Promise<WithdrawalRecord[]> {
    return this.rows.filter((r) => r.status === 'completed' && (r.resolvedAt ?? r.createdAt) >= sinceMs).map((r) => ({ ...r }));
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
    // When provided (Prisma), the debit + the withdrawal-row insert run in ONE
    // transaction, so a crash can never leave a phantom debit with no record.
    private readonly uow?: UnitOfWork,
  ) {}

  /** Request a withdrawal: validate limits, hold the funds, create a pending row. */
  async request(userId: string, amountCents: number, destination: string): Promise<WithdrawalRecord> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new WithdrawalError('bad_amount', 'Shumë e pavlefshme.');
    if (amountCents < this.limits.minCents) throw new WithdrawalError('below_min', `Tërheqja minimale është ${this.limits.minCents} cent.`);
    if (amountCents > this.limits.maxCents) throw new WithdrawalError('above_max', 'Tërheqja kalon limitin maksimal.');
    if (!destination || destination.trim().length < 4) throw new WithdrawalError('bad_destination', 'Destinacioni i tërheqjes mungon.');

    // ATOMIC PATH (Prisma): debit + insert in one $transaction — a crash mid-way rolls
    // BOTH back, so there's never a debit with no withdrawal record (and vice versa).
    if (this.uow) {
      try {
        return await this.uow.transaction(async (ctx) => {
          await this.wallet.bind(ctx).debit(userId, amountCents, { type: 'withdrawal', reason: 'kërkesë tërheqjeje' });
          return ctx.withdrawals.create({ userId, amountCents, destination });
        });
      } catch (e) {
        if (e instanceof InsufficientFundsError) throw new WithdrawalError('insufficient_funds', 'Bilanc i pamjaftueshëm.');
        throw e;
      }
    }

    // FALLBACK (in-memory: single-threaded, already atomic): debit then create, with a
    // compensating refund if the insert throws so funds aren't stuck in a phantom hold.
    try {
      await this.wallet.debit(userId, amountCents, { type: 'withdrawal', reason: 'kërkesë tërheqjeje' });
    } catch (e) {
      if (e instanceof InsufficientFundsError) throw new WithdrawalError('insufficient_funds', 'Bilanc i pamjaftueshëm.');
      throw e;
    }
    try {
      return await this.repo.create({ userId, amountCents, destination });
    } catch (e) {
      await this.wallet.credit(userId, amountCents, { type: 'admin_adjust', reason: 'rikthim: krijimi i tërheqjes dështoi' }).catch(() => {});
      throw e;
    }
  }

  /** Admin marks a withdrawal paid out externally. Atomic, acts at most once.
   *  `audit` records who/how (resolvedByAdminId, providerRef, network, txHash). */
  async approve(id: string, audit?: WithdrawalResolution): Promise<WithdrawalRecord> {
    const rec = await this.repo.find(id);
    if (!rec) throw new WithdrawalError('not_found', 'Tërheqja nuk u gjet.');
    const claimed = await this.repo.setStatusIfPending(id, 'completed', audit);
    if (!claimed) throw new WithdrawalError('not_pending', 'Tërheqja nuk është në pritje.');
    return claimed;
  }

  /**
   * Admin rejects a withdrawal and refunds the held funds. Concurrency-safe:
   * the refund credit carries a deterministic providerRef so it can credit AT
   * MOST ONCE, and the status transition is an atomic compare-and-set.
   */
  async reject(id: string, audit?: WithdrawalResolution): Promise<WithdrawalRecord> {
    const rec = await this.repo.find(id);
    if (!rec) throw new WithdrawalError('not_found', 'Tërheqja nuk u gjet.');
    if (rec.status !== 'pending') throw new WithdrawalError('not_pending', 'Tërheqja nuk është në pritje.');
    // Dual-control / anti-self-dealing: an admin may never resolve their OWN withdrawal.
    if (audit?.resolvedByAdminId && rec.userId === audit.resolvedByAdminId) {
      throw new WithdrawalError('self_resolve', 'Nuk mund të vendosësh për tërheqjen tënde.');
    }
    // CLAIM the transition FIRST (atomic compare-and-set). Only the winner refunds —
    // so a concurrent approve() (which already paid out) can't also trigger a refund
    // here (that would be a double-pay). The loser of the race throws not_pending.
    const claimed = await this.repo.setStatusIfPending(id, 'rejected', audit);
    if (!claimed) throw new WithdrawalError('not_pending', 'Tërheqja nuk është në pritje.');
    // Idempotent refund (providerRef): safe even if this path somehow re-runs.
    await this.wallet.credit(rec.userId, rec.amountCents, {
      type: 'admin_adjust',
      reason: 'rikthim tërheqjeje',
      providerRef: `withdrawal_refund:${id}`,
    });
    return claimed;
  }

  /**
   * Admin approves AND actually SENDS the payout on-chain via the provider — so
   * "Approve" can never be confused with "mark paid but nothing sent".
   *
   * Safety: CLAIM the row first (atomic pending→completed) so a racing reject()
   * can't refund a payout we're about to send, and only ONE approve sends. The
   * provider dedupes on our withdrawal id (Binance withdrawOrderId), so even the
   * tiny claim→send window can't double-send. On send FAILURE the held funds are
   * refunded (idempotent) and the row reversed out of 'completed', leaving the
   * player whole. With NO real provider configured (NullPayoutProvider), it falls
   * back to a plain mark-completed — the operator paid externally by hand.
   */
  async payoutNow(id: string, payout: PayoutProvider | null, opts: { resolvedByAdminId?: string | null } = {}): Promise<WithdrawalRecord> {
    const rec = await this.repo.find(id);
    if (!rec) throw new WithdrawalError('not_found', 'Tërheqja nuk u gjet.');
    if (rec.status !== 'pending') throw new WithdrawalError('not_pending', 'Tërheqja nuk është në pritje.');
    // Dual-control / anti-self-dealing: an admin may never approve+pay their OWN withdrawal.
    if (opts.resolvedByAdminId && rec.userId === opts.resolvedByAdminId) {
      throw new WithdrawalError('self_resolve', 'Nuk mund të vendosësh për tërheqjen tënde.');
    }
    // MONEY-8: re-validate the destination at payout time (defense-in-depth — it was
    // checked at request, but never send real funds to a malformed/corrupted address).
    if (!isValidTronAddress(rec.destination)) throw new WithdrawalError('bad_destination', 'Adresa e tërheqjes është e pavlefshme.');

    // No auto-send provider → behave like the old manual approve (operator sent the
    // crypto themselves and is just recording it as paid).
    if (!payout || payout.name === 'null') {
      return this.approve(id, { resolvedByAdminId: opts.resolvedByAdminId ?? null });
    }

    // CLAIM first (atomic compare-and-set): only one approve proceeds, and a racing
    // reject() sees not-pending → it can't refund a payout we're about to send.
    const claimed = await this.repo.setStatusIfPending(id, 'completed', { resolvedByAdminId: opts.resolvedByAdminId ?? null });
    if (!claimed) throw new WithdrawalError('not_pending', 'Tërheqja nuk është në pritje.');

    const r = await payout.payout({ withdrawalId: id, amountCents: rec.amountCents, address: rec.destination });
    if (r.ok) {
      // The money is ALREADY sent. Stamping the provider ref is best-effort: a DB blip
      // here must NOT make a successful payout look failed (which would mislead the
      // admin and strand the row). The reconciler can still match via Binance history.
      await this.repo.setAudit(id, { providerRef: r.providerRef ?? null }).catch(() => {});
      return { ...claimed, providerRef: r.providerRef ?? null };
    }

    // money-16: a failure is one of THREE kinds — only a DEFINITE failure may refund.
    //   • duplicate: our withdrawOrderId was already submitted → the original send STANDS.
    //     Keep the row COMPLETED, stamp the note, NEVER refund (would double-pay the player).
    //   • ambiguous: the outcome is unknown (timeout/5xx/network) → the funds MAY have left.
    //     Keep COMPLETED + flag for ops, NEVER refund; the reconciler reverses it ONLY if
    //     Binance history confirms the send failed.
    if (r.duplicate) {
      await this.repo.setAudit(id, { providerRef: r.providerRef ?? null, failureReason: 'duplicate send (already paid) — marked paid, no refund' }).catch(() => {});
      return { ...claimed, providerRef: r.providerRef ?? null, failureReason: 'duplicate send (already paid)' };
    }
    if (r.ambiguous) {
      await this.repo.setAudit(id, { failureReason: `AMBIGUOUS send — left as paid, NOT refunded (verify on-chain): ${r.error ?? ''}`.slice(0, 280) }).catch(() => {});
      // Surface as a special error so the admin UI/Telegram flags it, but the row stays
      // 'completed' and the funds stay debited (no refund on a maybe-sent payout).
      throw new WithdrawalError('payout_ambiguous', `Pagesa është e PASIGURT (mund të jetë dërguar): ${r.error ?? 'e panjohur'}. NUK u rikthye — verifiko on-chain para se ta provosh sërish.`);
    }

    // DEFINITE failure → refund the held funds FIRST (idempotent providerRef, so a re-run
    // can't double-refund) so the player is never short, then reverse the row.
    await this.wallet.credit(rec.userId, rec.amountCents, {
      type: 'admin_adjust', reason: 'rikthim: pagesa e tërheqjes dështoi', providerRef: `withdrawal_refund:${id}`,
    });
    await this.repo.markReversed(id);
    throw new WithdrawalError('payout_failed', `Pagesa dështoi: ${r.error ?? 'e panjohur'}. Fondet u kthyen lojtarit — provoje sërish ose dërgo manualisht.`);
  }

  /**
   * AUTO-PAY path (off the response, fired by autoPayout.processWithdrawal). Identical
   * safety to payoutNow — CLAIM the row (pending→completed) BEFORE sending, only send if
   * the claim won (a concurrent reject/approve can't double-pay), refund ONLY on a DEFINITE
   * failure (duplicate/ambiguous never refund) — but returns a structured outcome instead
   * of throwing, since this runs in the background. Requires a REAL provider (the route
   * only calls this for tier 'auto' with a configured provider).
   */
  async autoPayout(id: string, payout: PayoutProvider): Promise<{ outcome: 'paid' | 'duplicate' | 'ambiguous' | 'failed' | 'not_pending' | 'bad_destination'; providerRef?: string | null; error?: string }> {
    const rec = await this.repo.find(id);
    if (!rec) return { outcome: 'not_pending', error: 'not_found' };
    if (rec.status !== 'pending') return { outcome: 'not_pending' };
    // Defense-in-depth: never auto-send to a malformed address.
    if (!isValidTronAddress(rec.destination)) return { outcome: 'bad_destination', error: 'invalid destination' };

    // CLAIM first (atomic pending→completed): only ONE path proceeds. A racing reject()
    // then sees not-pending and can't refund a payout we're about to send.
    const claimed = await this.repo.setStatusIfPending(id, 'completed');
    if (!claimed) return { outcome: 'not_pending' };

    const r = await payout.payout({ withdrawalId: id, amountCents: rec.amountCents, address: rec.destination })
      .catch((e): PayoutResult => ({ ok: false, ambiguous: true, error: `payout threw (ambiguous): ${String(e)}` }));

    if (r.ok) {
      await this.repo.setAudit(id, { providerRef: r.providerRef ?? null }).catch(() => {});
      return { outcome: 'paid', providerRef: r.providerRef ?? null };
    }
    if (r.duplicate) {
      await this.repo.setAudit(id, { providerRef: r.providerRef ?? null, failureReason: 'duplicate send (already paid) — auto, no refund' }).catch(() => {});
      return { outcome: 'duplicate', providerRef: r.providerRef ?? null, error: r.error };
    }
    if (r.ambiguous) {
      await this.repo.setAudit(id, { failureReason: `AMBIGUOUS auto-send — left paid, NOT refunded: ${r.error ?? ''}`.slice(0, 280) }).catch(() => {});
      return { outcome: 'ambiguous', error: r.error };
    }
    // DEFINITE failure → idempotent refund + reverse out of completed (player made whole).
    await this.wallet.credit(rec.userId, rec.amountCents, {
      type: 'admin_adjust', reason: 'rikthim: auto-pagesa dështoi', providerRef: `withdrawal_refund:${id}`,
    }).catch(() => {});
    await this.repo.markReversed(id).catch(() => {});
    return { outcome: 'failed', error: r.error };
  }

  listPending(): Promise<WithdrawalRecord[]> {
    return this.repo.listPending();
  }
  listByUser(userId: string, limit?: number): Promise<WithdrawalRecord[]> {
    return this.repo.listByUser(userId, limit);
  }

  /** money-7: total AUTO-paid (system-resolved, resolvedByAdminId===null) cents in the last
   *  `windowMs`, optionally restricted to one destination address. Powers the global +
   *  per-destination rolling-24h auto-payout caps. Excludes manually-approved payouts (which
   *  an operator already vetted) — the caps bound the UNATTENDED auto-send blast radius. */
  async autoPaidSince(sinceMs: number, destination?: string): Promise<number> {
    const rows = await this.repo.listCompletedSince(sinceMs);
    return rows
      .filter((w) => w.resolvedByAdminId === null && (destination === undefined || w.destination === destination))
      .reduce((s, w) => s + w.amountCents, 0);
  }
  find(id: string): Promise<WithdrawalRecord | null> {
    return this.repo.find(id);
  }
  markReversed(id: string): Promise<void> {
    return this.repo.markReversed(id);
  }
}
