-- Club War integrity (audit 2026-06-28 #5). The club_wars table escrows money (prizePoolCents) but its
-- clubAId/clubBId had NO foreign key to clubs (unlike tournaments, hardened in 20260624010000) — so a war
-- could dangle past a deleted club and strand its escrow accounting. Add the FKs + a self-war guard.
--
-- Added NOT VALID on purpose: the constraints are enforced immediately on every NEW / updated row, but
-- Postgres SKIPS validating the (tiny) set of pre-existing rows — so this migration CANNOT fail on, or
-- delete, any live money row (safer here than the orphan-DELETE pattern, since clubAId/clubBId are NOT
-- NULL). ON DELETE RESTRICT keeps a club with war history recoverable (a founder is blocked via
-- account-state ban, never a hard delete — mirrors clubs.founder). Live-safe + additive.

ALTER TABLE "club_wars"
  ADD CONSTRAINT "club_wars_clubAId_fkey"
  FOREIGN KEY ("clubAId") REFERENCES "clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "club_wars"
  ADD CONSTRAINT "club_wars_clubBId_fkey"
  FOREIGN KEY ("clubBId") REFERENCES "clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- A war is always between two DIFFERENT clubs. CHECK is invisible to Prisma's diff (same as the
-- users.balanceCents >= 0 / tournaments_status_check constraints), so it adds no schema drift.
ALTER TABLE "club_wars"
  ADD CONSTRAINT "club_wars_distinct_clubs_check" CHECK ("clubAId" <> "clubBId") NOT VALID;
