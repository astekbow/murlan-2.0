-- Club-scoped tournaments: a tournament may belong to a club (clubId non-null), joinable
-- only by members and creatable only by the founder. null = global (public list).
-- Additive + nullable → safe on a live table (no rewrite, no default backfill).
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "clubId" TEXT;
CREATE INDEX IF NOT EXISTS "tournaments_clubId_idx" ON "tournaments"("clubId");
