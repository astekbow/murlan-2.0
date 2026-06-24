-- Achievements / badges (§2.6): an append-only set of earned badge ids per user.
-- Mirrors `cosmetics` (TEXT[] NOT NULL DEFAULT '{}'). Additive + live-safe: every
-- existing row defaults to the empty array (no badges), so nothing is affected.
-- Achievement badges are granted lazily when a stat threshold is crossed; season
-- badges (season_<n>_finalist/top3/champion) are granted when a season is archived.
-- Cosmetic/status ONLY — never money, never MMR.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "badges" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
