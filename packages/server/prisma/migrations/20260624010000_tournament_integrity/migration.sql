-- Tournament integrity hardening (audit M5/M6/M9). All live-safe + additive.

-- M9: the club list filters on clubId and ORDERs BY createdAt — a composite index serves
-- both list (clubId IS NULL) and listByClub index-only. Replace the single-column index.
DROP INDEX IF EXISTS "tournaments_clubId_idx";
CREATE INDEX IF NOT EXISTS "tournaments_clubId_createdAt_idx" ON "tournaments"("clubId", "createdAt");

-- M5: add the clubId → clubs FK so a club-scoped tournament can't dangle.
-- First null out any clubId that points at an already-deleted club (orphan-cleanup before
-- the FK, matching the pattern of the 20260614/20260621 migrations) so the constraint adds
-- cleanly. ON DELETE SET NULL: deleting a club degrades its tournaments to global, never
-- strands them (escrow is independently safe via sweepStale/listAll).
UPDATE "tournaments" SET "clubId" = NULL
  WHERE "clubId" IS NOT NULL AND "clubId" NOT IN (SELECT "id" FROM "clubs");
ALTER TABLE "tournaments"
  ADD CONSTRAINT "tournaments_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- M6: guard the money-state machine at the DB level (status was free-text TEXT). A typo'd
-- write that fell outside this set would have silently dropped a tournament out of the
-- stale-sweep's SWEEPABLE check → stranded escrow. CHECK is invisible to Prisma's diff
-- (same as the users.balanceCents >= 0 CHECK), so it adds no schema drift.
ALTER TABLE "tournaments"
  ADD CONSTRAINT "tournaments_status_check"
  CHECK ("status" IN ('registering', 'running', 'awaiting_confirmation', 'finished', 'cancelled'));
