-- Rotating quests (daily + weekly) & level-up rewards (§2.6) — the retention core.
-- Additive + live-safe: three array columns on "users" tracking claimed dailies/weeklies
-- (per-period keys) and collected level milestones. XP/cosmetic only, never cashable.
-- Existing rows default to empty arrays (no quests claimed, no milestones collected),
-- so nothing about the live data changes. Mirrors the "claimedChallenges" pattern.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "claimedDailies"      TEXT[]    NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "claimedWeeklies"     TEXT[]    NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "collectedMilestones" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
