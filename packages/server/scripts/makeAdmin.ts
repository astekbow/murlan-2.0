// ============================================================================
// Promote a user to the `admin` role (so the Admin panel unlocks).
// Usage (from repo root):  npm run make-admin -- <username|email>
// Reads DATABASE_URL from the env (../../.env is auto-loaded by the npm script).
// ============================================================================

import { getPrisma } from '../src/db/prismaClient.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — point it at your database first (.env).');
  process.exit(1);
}

const key = process.argv[2];
if (!key) {
  console.error('Usage: npm run make-admin -- <username|email>');
  process.exit(1);
}

const db = getPrisma(url);
const k = key.toLowerCase();
const user = await db.user.findFirst({ where: { OR: [{ usernameLower: k }, { email: k }] } });
if (!user) {
  console.error(`No user matching "${key}". Register that account in the app first.`);
  await db.$disconnect();
  process.exit(1);
}

if (user.role === 'admin') {
  console.log(`${user.username} (${user.email}) is already an admin.`);
} else {
  const updated = await db.user.update({ where: { id: user.id }, data: { role: 'admin' } });
  console.log(`✅ Promoted ${updated.username} (${updated.email}) -> role=${updated.role}`);
  console.log('   Log out and log back in to see the "Paneli i Adminit" button.');
}
await db.$disconnect();
