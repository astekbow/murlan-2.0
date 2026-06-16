-- Dual-control (four-eyes) for the tournament champion payout.
-- Additive + nullable → safe on a live table (no rewrite, no default backfill).
-- pendingWinnerId   : the champion awaiting a second admin's confirmation
-- reportedByAdminId : the admin who reported the final (the confirmer must differ)
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "pendingWinnerId" TEXT;
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "reportedByAdminId" TEXT;
