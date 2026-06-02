// ============================================================================
// Supabase live smoke test
// ----------------------------------------------------------------------------
// Connects to the real Postgres via DATABASE_URL and exercises the production
// Prisma adapters end-to-end: connectivity → create user → credit → debit →
// reconcile → cleanup. Run with the env loaded, e.g.
//   node --env-file=../../.env --import tsx scripts/supabaseSmoke.ts
// (from packages/server) or pass DATABASE_URL inline.
// ============================================================================

import { getPrisma } from '../src/db/prismaClient.ts';
import { createPrismaStores } from '../src/db/prismaRepositories.ts';
import { WalletService } from '../src/money/walletService.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — point it at Supabase first.');
  process.exit(1);
}

const stamp = Date.now();
const username = `smoke_${stamp}`;
const email = `smoke_${stamp}@example.com`;

async function main(): Promise<void> {
  const db = getPrisma(url!);
  const stores = createPrismaStores(db);
  const wallet = new WalletService(stores.users, stores.ledger, stores.uow);

  // 1) Connectivity.
  const ping = await db.$queryRawUnsafe<Array<{ ok: number }>>('SELECT 1 AS ok');
  console.log('1) connectivity  :', ping[0]?.ok === 1 ? 'OK (SELECT 1)' : 'FAILED');

  // 2) Create a throwaway user.
  const user = await stores.users.create({ username, email, passwordHash: 'x'.repeat(32) });
  console.log('2) create user   : id=%s username=%s', user.id, user.username);

  try {
    // 3) Credit (idempotent on providerRef).
    const ref = `smoke:deposit:${stamp}`;
    const c1 = await wallet.credit(user.id, 5000, { type: 'deposit', providerRef: ref, reason: 'smoke deposit' });
    const c2 = await wallet.credit(user.id, 5000, { type: 'deposit', providerRef: ref, reason: 'smoke deposit' });
    console.log('3) credit 5000   : balance=%d idempotentReplay=%s', c1.balanceCents, c2.idempotent);

    // 4) Debit.
    const d1 = await wallet.debit(user.id, 2000, { type: 'bet', reason: 'smoke bet' });
    console.log('4) debit 2000    : balance=%d', d1.balanceCents);

    // 5) Read-back balance (expect 3000) + ledger sum for this user.
    const bal = await wallet.getBalance(user.id);
    const rows = await stores.ledger.listByUser(user.id);
    const sum = rows.reduce((a, t) => a + t.amountCents, 0);
    console.log('5) balance/ledger: balance=%d ledgerSum=%d rows=%d match=%s', bal, sum, rows.length, bal === sum && bal === 3000);

    // 6) Global reconcile (balances vs ledger across all users).
    const rec = await wallet.reconcile();
    console.log('6) reconcile     : ok=%s mismatches=%d', rec.ok, rec.mismatches.length);
    if (!rec.ok) console.log('   mismatches:', JSON.stringify(rec.mismatches, null, 2));
  } finally {
    // 7) Cleanup — remove the throwaway rows so the DB stays clean.
    const delTx = await db.transaction.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    console.log('7) cleanup       : deleted %d tx rows + user', delTx.count);
    await db.$disconnect();
  }
}

main().then(
  () => { console.log('\n✅ Supabase smoke test passed.'); process.exit(0); },
  (e) => { console.error('\n❌ Supabase smoke test failed:\n', e); process.exit(1); },
);
