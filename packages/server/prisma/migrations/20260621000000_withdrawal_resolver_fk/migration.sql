-- Referential integrity for the withdrawal audit trail: Withdrawal.resolvedByAdminId
-- -> users.id. Previously an indexed bare TEXT column with no FK.
--
-- SAFE ON A LIVE TABLE:
--  1) NULL out any orphan values first (an id that no longer maps to a user), so
--     adding the constraint can never fail on stale data. resolvedByAdminId is only
--     ever set to a real admin id, so this should affect 0 rows — it's a guard.
--  2) ON DELETE SET NULL: deleting/anonymizing an admin keeps the withdrawal row
--     (financial record) but drops the resolver link. ON UPDATE CASCADE mirrors
--     Prisma's default for a referential relation.
UPDATE "withdrawals" w
   SET "resolvedByAdminId" = NULL
 WHERE w."resolvedByAdminId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = w."resolvedByAdminId");

ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_resolvedByAdminId_fkey"
  FOREIGN KEY ("resolvedByAdminId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
