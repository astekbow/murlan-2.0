-- Additive: date indexes for admin/reporting range queries, plus a foreign key on
-- clubs.founderId so a club always references a real user (Restrict — a founder
-- can't be hard-deleted out from under their club).

CREATE INDEX "transactions_createdAt_idx" ON "transactions"("createdAt");
CREATE INDEX "withdrawals_createdAt_idx" ON "withdrawals"("createdAt");
CREATE INDEX "support_tickets_createdAt_idx" ON "support_tickets"("createdAt");
CREATE INDEX "admin_actions_createdAt_idx" ON "admin_actions"("createdAt");

CREATE INDEX "clubs_founderId_idx" ON "clubs"("founderId");
ALTER TABLE "clubs"
  ADD CONSTRAINT "clubs_founderId_fkey"
  FOREIGN KEY ("founderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
