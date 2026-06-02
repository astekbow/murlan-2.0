// ============================================================================
// Reset a user's password (Argon2id hash, same as registration).
// Usage (from repo root):  npm run set-password -- <username|email> <newPassword>
// Reads DATABASE_URL from the env (.env is auto-loaded by the npm script).
// ============================================================================

import { getPrisma } from '../src/db/prismaClient.ts';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — point it at your database first (.env).');
  process.exit(1);
}

const key = process.argv[2];
const newPass = process.argv[3];
if (!key || !newPass) {
  console.error('Usage: npm run set-password -- <username|email> <newPassword>');
  process.exit(1);
}
if (newPass.length < 8) {
  console.error('Password must be at least 8 characters (matches the register rule).');
  process.exit(1);
}

const db = getPrisma(url);
const k = key.toLowerCase();
const user = await db.user.findFirst({ where: { OR: [{ usernameLower: k }, { email: k }] } });
if (!user) {
  console.error(`No user matching "${key}".`);
  await db.$disconnect();
  process.exit(1);
}

const passwordHash = await hashPassword(newPass);
await db.user.update({ where: { id: user.id }, data: { passwordHash } });
const ok = await verifyPassword(passwordHash, newPass); // sanity-check the new hash
console.log(`✅ Password updated for ${user.username} (${user.email}). verify=${ok}`);
await db.$disconnect();
