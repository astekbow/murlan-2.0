-- Phase 6: engagement rewards (daily/challenges/shop) — XP/cosmetic only.

ALTER TABLE "users" ADD COLUMN "lastDailyClaim" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "dailyStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "cosmetics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "users" ADD COLUMN "cardBack" TEXT;
ALTER TABLE "users" ADD COLUMN "tableFelt" TEXT;
ALTER TABLE "users" ADD COLUMN "claimedChallenges" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
