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

export interface WalletTxContext {
  users: UserRepository;
  ledger: LedgerRepository;
  // Bound to the same transaction so a match's payouts/rake AND its status flip
  // (settle/refund) commit or roll back together — no partially-settled match.
  matches: MatchesRepository;
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
  ) {}

  transaction<T>(fn: (ctx: WalletTxContext) => Promise<T>): Promise<T> {
    return fn({ users: this.users, ledger: this.ledger, matches: this.matches });
  }
}
