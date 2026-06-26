-- Seed the synthetic HOUSE account that owns the rake ledger.
--
-- WHY THIS IS REQUIRED (not cosmetic): `transactions.userId` has an enforced foreign key to
-- `users(id)` (created in 0001_init, never dropped), and every staked-match settlement books the
-- house rake to userId = '__house__' (see walletService.recordRake → ledger.append). Without a
-- matching users row, that rake INSERT raises a foreign-key violation INSIDE the settle
-- transaction, which rolls back the ENTIRE settlement (winner payouts + status flip) — so no
-- staked game can ever pay out. (In-memory tests never caught this: the in-memory ledger has no FK.)
--
-- The house is ledger-only: it has no real balance (treasury = SUM of its 'rake' rows), it can never
-- authenticate (passwordHash is a non-argon2 sentinel that verify() can never match), and its
-- username/email are internal sentinels a real signup cannot produce (validation rejects them). All
-- other NOT NULL columns have DB defaults, so this minimal insert is sufficient.
--
-- Idempotent: ON CONFLICT (id) DO NOTHING — safe to (re)apply, and a no-op if the row already exists.
INSERT INTO "users" ("id", "username", "usernameLower", "email", "passwordHash")
VALUES ('__house__', 'House', '__house__', 'house@cryptomurlan.internal', '!nologin-house-account')
ON CONFLICT ("id") DO NOTHING;
