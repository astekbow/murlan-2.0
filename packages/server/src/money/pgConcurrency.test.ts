// ============================================================================
// MURLAN — Postgres concurrency integration test (opt-in)
// ----------------------------------------------------------------------------
// In-memory tests prove the LOGIC; this proves the SAME guarantees hold under a
// real Postgres backend, where credit/debit run in a genuine prisma.$transaction
// and idempotency relies on the UNIQUE providerRef + the conditional balance
// UPDATE — none of which the synchronous in-memory store exercises.
//
// SKIPS unless DATABASE_TEST_URL points at a THROWAWAY Postgres (never production
// — the test creates users and moves money). Locally:
//   docker compose up -d postgres
//   DATABASE_URL=postgres://murlan:murlan@localhost:5432/murlan \
//   DIRECT_URL=postgres://murlan:murlan@localhost:5432/murlan \
//     npm run db:migrate --workspace @murlan/server
//   DATABASE_TEST_URL=postgres://murlan:murlan@localhost:5432/murlan npm run test:server
// CI runs it automatically (see .github/workflows/ci.yml postgres service).
// Imports of @prisma/client are DYNAMIC so a skipped run never loads it.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletService } from './walletService.ts';
import { MoneyService } from './moneyService.ts';

const PG_URL = process.env.DATABASE_TEST_URL;
const skip = PG_URL ? false : 'set DATABASE_TEST_URL (throwaway Postgres) to run';

async function setup() {
  const { getPrisma } = await import('../db/prismaClient.ts');
  const { createPrismaStores } = await import('../db/prismaRepositories.ts');
  const prisma = getPrisma(PG_URL!);
  const stores = createPrismaStores(prisma);
  const wallet = new WalletService(stores.users, stores.ledger, stores.uow);
  const money = new MoneyService(wallet, stores.matches, stores.uow);
  // Unique per run so the (persistent) test DB never collides across runs.
  const tag = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const a = await stores.users.create({ username: `pgA_${tag}`, email: `a_${tag}@t.com`, passwordHash: 'h' });
  const b = await stores.users.create({ username: `pgB_${tag}`, email: `b_${tag}@t.com`, passwordHash: 'h' });
  await wallet.credit(a.id, 1000, { type: 'deposit', providerRef: `dep_a_${tag}` });
  await wallet.credit(b.id, 1000, { type: 'deposit', providerRef: `dep_b_${tag}` });
  const matchId = `m_${tag}`;
  return { prisma, wallet, money, a, b, matchId, tag };
}

test('Postgres: two concurrent settles pay the winner exactly once; ledger conserves', { skip }, async () => {
  const { prisma, wallet, money, a, b, matchId } = await setup();
  try {
    const esc = await money.escrow({ matchId, type: '1v1', stakeCents: 1000, rakeBps: 1000, players: [{ seat: 0, userId: a.id }, { seat: 1, userId: b.id }] });
    assert.ok(esc.ok);
    assert.equal(await wallet.getBalance(a.id), 0); // stakes escrowed via a real $transaction

    // Fire two settles for the SAME match concurrently — only one may take effect.
    const results = await Promise.all([
      money.settle({ matchId, winnerSeats: [0] }),
      money.settle({ matchId, winnerSeats: [0] }),
    ]);
    assert.equal(results.filter(Boolean).length, 1); // exactly one settled (no double-pay)
    assert.equal(await wallet.getBalance(a.id), 1800); // pot − 10% rake, paid ONCE
    assert.equal(await wallet.getBalance(b.id), 0);

    const sums = await wallet.matchLedgerSums();
    assert.equal(sums.get(matchId), 0); // bets in === payouts + rake out (conserved)
    assert.equal((await wallet.reconcile()).ok, true);
  } finally {
    await prisma.$disconnect();
  }
});

test('Postgres: a settle and a refund racing the same match resolve it once, no money lost/minted', { skip }, async () => {
  const { prisma, wallet, money, a, b, matchId } = await setup();
  try {
    await money.escrow({ matchId, type: '1v1', stakeCents: 1000, rakeBps: 1000, players: [{ seat: 0, userId: a.id }, { seat: 1, userId: b.id }] });

    // Race settle vs refund. The synchronous inFlight claim + status guard ensure
    // only the first wins; the other is a no-op. Either way money is conserved.
    await Promise.all([
      money.settle({ matchId, winnerSeats: [0] }),
      money.refund(matchId),
    ]);

    const balA = await wallet.getBalance(a.id);
    const balB = await wallet.getBalance(b.id);
    assert.ok(balA >= 0 && balB >= 0); // never negative
    // Exactly one outcome happened: settle (a=1800,b=0) OR refund (a=1000,b=1000).
    const settled = balA === 1800 && balB === 0;
    const refunded = balA === 1000 && balB === 1000;
    assert.ok(settled || refunded, `unexpected balances a=${balA} b=${balB}`);

    const sums = await wallet.matchLedgerSums();
    assert.equal(sums.get(matchId), 0); // closed match nets to zero either way
    assert.equal((await wallet.reconcile()).ok, true);
  } finally {
    await prisma.$disconnect();
  }
});

test('Postgres: a duplicate-providerRef credit is idempotent (credited once)', { skip }, async () => {
  const { prisma, wallet, a, tag } = await setup();
  try {
    const ref = `webhook_${tag}`;
    const before = await wallet.getBalance(a.id);
    const r1 = await wallet.credit(a.id, 500, { type: 'deposit', providerRef: ref });
    const r2 = await wallet.credit(a.id, 500, { type: 'deposit', providerRef: ref }); // retry
    assert.equal(r1.idempotent, false);
    assert.equal(r2.idempotent, true); // ON CONFLICT DO NOTHING — not re-credited
    assert.equal(await wallet.getBalance(a.id), before + 500); // +500 once, not +1000
  } finally {
    await prisma.$disconnect();
  }
});
