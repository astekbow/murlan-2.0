-- XP economy (§2.6): a parallel SPENDABLE-XP balance for XP-priced cosmetics.
-- Additive + live-safe: `xp` (lifetime earned) is untouched so level = levelInfo(xp)
-- stays monotonic; the spendable balance is (xp - xpSpent), clamped ≥ 0. Existing rows
-- default to 0 spent (every player keeps their full earned XP as spendable).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "xpSpent" INTEGER NOT NULL DEFAULT 0;
