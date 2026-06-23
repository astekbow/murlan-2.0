// ============================================================================
// MURLAN — Unit of Work for atomic money writes
// ----------------------------------------------------------------------------
// WalletService.credit/debit make TWO writes (ledger row + balance). To keep
// them atomic, they run inside a UnitOfWork transaction that hands back repos
// bound to the same transaction. The in-memory impl is a trivial pass-through
// (single-threaded, already atomic); the Prisma impl wraps `$transaction`, so a
// failure rolls BOTH writes back — no compensating reversal needed.
// ============================================================================

import type { UserRepository } from '../auth/userRepository.ts';
import type { LedgerRepository } from './ledger.ts';
import { type MatchesRepository, InMemoryMatchesRepository } from './matchesRepository.ts';
import { type WithdrawalRepository, InMemoryWithdrawals } from './withdrawals.ts';
import { type TournamentRepository, InMemoryTournamentRepository } from '../tournament/tournamentService.ts';
import { type AdminAuditRepository, InMemoryAdminAudit } from '../auth/adminAudit.ts';

export interface WalletTxContext {
  users: UserRepository;
  ledger: LedgerRepository;
  // Bound to the same transaction so a match's payouts/rake AND its status flip
  // (settle/refund) commit or roll back together — no partially-settled match.
  matches: MatchesRepository;
  // Bound too, so a withdrawal's hold (debit + ledger) AND its record insert commit
  // or roll back together — no phantom debit with no withdrawal row.
  withdrawals: WithdrawalRepository;
  // Bound too, so a tournament's buy-in escrow / champion payout AND its row write
  // (playerIds, status, bracket, prizePool) commit or roll back together — no trapped
  // buy-in (debit lost with no registration), and no champion paid while the row stays
  // 'running' (which a later stale-sweep would wrongly refund → double-pay). (SCH-3)
  tournaments: TournamentRepository;
  // Bound too (admin-5): a privileged balance mutation AND its AdminAction audit row
  // commit or roll back together — the action can't commit without its audit trail.
  audit: AdminAuditRepository;
  /**
   * OPTIONAL transaction-scoped advisory lock (deposit-cap fix). On Postgres this runs
   * `pg_advisory_xact_lock(hashtext(key))` so concurrent capped-deposit transactions for
   * the SAME user serialize across ALL instances (the in-memory serializer only holds
   * single-instance). Auto-released at COMMIT/ROLLBACK. No-op in-memory (already
   * single-threaded). Call it FIRST in the transaction, before reading "deposits today".
   */
  advisoryXactLock?(key: string): Promise<void>;
}

export interface UnitOfWork {
  transaction<T>(fn: (ctx: WalletTxContext) => Promise<T>): Promise<T>;
}

/** Pass-through UoW for the in-memory store (operations are already atomic). */
export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(
    private readonly users: UserRepository,
    private readonly ledger: LedgerRepository,
    private readonly matches: MatchesRepository = new InMemoryMatchesRepository(),
    private readonly withdrawals: WithdrawalRepository = new InMemoryWithdrawals(),
    private readonly tournaments: TournamentRepository = new InMemoryTournamentRepository(),
    private readonly audit: AdminAuditRepository = new InMemoryAdminAudit(),
  ) {}

  transaction<T>(fn: (ctx: WalletTxContext) => Promise<T>): Promise<T> {
    return fn({ users: this.users, ledger: this.ledger, matches: this.matches, withdrawals: this.withdrawals, tournaments: this.tournaments, audit: this.audit });
  }
}
