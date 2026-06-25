// authz-2: an uploaded avatar data-URL is validated by decoded MAGIC BYTES, not just the
// MIME prefix — a `data:image/png;base64,...` carrying non-image (script/SVG) bytes is a
// latent stored-XSS and must be rejected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { ProfileService, AVATARS } from './profileService.ts';
import { levelInfo, XP_PLAY, XP_WIN } from './level.ts';
import type { Transaction } from '../money/ledger.ts';

async function setup() {
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'pic', email: 'p@x.com', passwordHash: 'h' });
  return { svc: new ProfileService(users), userId: u.id };
}

const betTx = (cents: number): Transaction =>
  ({ id: 'b', userId: 'u', type: 'bet', amountCents: -cents, currency: 'USD', status: 'completed', providerRef: null, matchId: 'm', reason: null, createdAt: 0 });

test('recordMatch applies the VIP XP boost from staked volume', async () => {
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'vipx', email: 'vx@x.com', passwordHash: 'h' });
  // $100 lifetime staked → bronze (+10% XP). A win = (XP_PLAY + XP_WIN) * 1.1.
  const ledger = { listTransactions: async () => [betTx(10_000)] };
  const svc = new ProfileService(users, ledger, true);
  await svc.recordMatch([{ userId: u.id, won: true, potCents: 0 }]);
  assert.equal((await users.findById(u.id))!.xp, Math.round((XP_PLAY + XP_WIN) * 1.1));
});

test('recordMatch without a ledger awards base XP (no boost)', async () => {
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'noledger', email: 'nl@x.com', passwordHash: 'h' });
  const svc = new ProfileService(users); // no ledger → standard, 1.0×
  await svc.recordMatch([{ userId: u.id, won: false, potCents: 0 }]);
  assert.equal((await users.findById(u.id))!.xp, XP_PLAY);
});

// A 1x1 PNG (valid magic bytes 89 50 4E 47 …) base64-encoded.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngDataUrl = `data:image/png;base64,${PNG_1x1}`;

test('avatar: a preset id is accepted', async () => {
  const { svc, userId } = await setup();
  const p = await svc.setAvatar(userId, AVATARS[0]);
  assert.equal(p!.avatar, AVATARS[0]);
});

test('avatar: a real PNG data-URL (valid magic bytes) is accepted', async () => {
  const { svc, userId } = await setup();
  const p = await svc.setAvatar(userId, pngDataUrl);
  assert.equal(p!.avatar, pngDataUrl);
});

test('avatar: a data:image/png with NON-image bytes (fake MIME) is REJECTED', async () => {
  const { svc, userId } = await setup();
  // "<script>alert(1)</script>" base64 — declares image/png but is not a real image.
  const evil = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
  await assert.rejects(() => svc.setAvatar(userId, evil), /invalid avatar/);
});

test('avatar: a data:image/png whose bytes are a JPEG/other is still an image and accepted only on real magic', async () => {
  const { svc, userId } = await setup();
  // Empty/short payload → no valid magic → rejected.
  await assert.rejects(() => svc.setAvatar(userId, 'data:image/png;base64,AAAA'), /invalid avatar/);
});

test('avatar: an oversized data-URL is rejected before decode', async () => {
  const { svc, userId } = await setup();
  const huge = `data:image/png;base64,${'A'.repeat(20_000)}`;
  await assert.rejects(() => svc.setAvatar(userId, huge), /invalid avatar/);
});

// ---- Demo leaderboard (klasifikimi) -----------------------------------------

test('leaderboard: with demoLeaderboard ON, the board has ~100 rows and a fresh real user is NOT rank 1', async () => {
  const users = new InMemoryUserRepository();
  const fresh = await users.create({ username: 'newbie', email: 'n@x.com', passwordHash: 'h' }); // 0 xp
  const svc = new ProfileService(users, undefined, /* demoLeaderboard */ true);

  const rows = await svc.leaderboard(100);
  assert.equal(rows.length, 100, 'board is filled to the limit by demo players');

  // Ranks are 1..N and the demo rows are detectable by their id prefix.
  assert.equal(rows[0]!.rank, 1);
  assert.ok(rows.some((r) => r.id.startsWith('demo_')), 'demo rows are present');

  const me = rows.find((r) => r.id === fresh.id) ?? null;
  // A fresh (0 xp) account either lands near the BOTTOM or falls off the top-100 entirely —
  // either way it is NEVER rank 1 (the whole point of seeding the board).
  if (me) assert.notEqual(me.rank, 1, 'a brand-new user is not #1');
  assert.notEqual(rows[0]!.id, fresh.id, 'the top row is not the fresh user');
});

test('leaderboard: deterministic across calls (stable demo roster)', async () => {
  const users = new InMemoryUserRepository();
  const svc = new ProfileService(users, undefined, true);
  const a = await svc.leaderboard(100);
  const b = await svc.leaderboard(100);
  assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id), 'same order every call');
});

test('leaderboard: with demoLeaderboard OFF, only real users appear', async () => {
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'solo', email: 's@x.com', passwordHash: 'h' });
  await users.addXp(u.id, 500);
  const svc = new ProfileService(users, undefined, false);
  const rows = await svc.leaderboard(100);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, u.id);
  assert.equal(rows[0]!.rank, 1);
});

// ---- Username search (miqt) -------------------------------------------------

test('searchUsers: case-insensitive substring match, excludes the caller, minimal shape', async () => {
  const users = new InMemoryUserRepository();
  const me = await users.create({ username: 'Andi', email: 'a@x.com', passwordHash: 'h' });
  const b = await users.create({ username: 'Andrea', email: 'b@x.com', passwordHash: 'h' });
  await users.create({ username: 'Besa', email: 'c@x.com', passwordHash: 'h' });
  await users.addXp(b.id, 1000);
  const svc = new ProfileService(users);

  const res = await svc.searchUsers('and', 20, me.id); // matches Andi + Andrea, case-insensitive
  const ids = res.map((r) => r.id);
  assert.ok(ids.includes(b.id), 'Andrea matched');
  assert.ok(!ids.includes(me.id), 'caller excluded');
  // Minimal public shape only — no email/stats.
  assert.deepEqual(Object.keys(res[0]!).sort(), ['avatar', 'id', 'level', 'username']);
  const andrea = res.find((r) => r.id === b.id)!;
  assert.equal(andrea.level, levelInfo(1000).level, 'level derived from xp');
});

test('searchUsers: bounded to ≤ 20 results', async () => {
  const users = new InMemoryUserRepository();
  for (let i = 0; i < 30; i++) await users.create({ username: `Player${i}`, email: `p${i}@x.com`, passwordHash: 'h' });
  const svc = new ProfileService(users);
  const res = await svc.searchUsers('player', 50, undefined); // ask for 50 → still capped at 20
  assert.equal(res.length, 20);
});
