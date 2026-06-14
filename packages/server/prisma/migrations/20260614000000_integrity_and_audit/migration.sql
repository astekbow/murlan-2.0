-- Integrity + audit hardening (audit follow-ups). All additive and written to apply
-- cleanly on the live DB (IF NOT EXISTS, orphan cleanup before FKs, idempotent FKs).

-- 1) Transaction composite indexes for the two hot queries (per-user history by date,
--    revenue/reporting by type+date).
CREATE INDEX IF NOT EXISTS "transactions_userId_createdAt_idx" ON "transactions"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "transactions_type_createdAt_idx" ON "transactions"("type", "createdAt");

-- 2) A user can occupy at most ONE seat in a match.
CREATE UNIQUE INDEX IF NOT EXISTS "match_players_matchId_userId_key" ON "match_players"("matchId", "userId");

-- 3) Private-club join codes must be unique (NULLs allowed → public clubs unaffected).
CREATE UNIQUE INDEX IF NOT EXISTS "clubs_joinCode_key" ON "clubs"("joinCode");

-- 4) Sweep index for stale deposit intents.
CREATE INDEX IF NOT EXISTS "deposit_intents_createdAt_idx" ON "deposit_intents"("createdAt");

-- 5) Withdrawal audit/dispute columns (nullable, populated as a withdrawal progresses).
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "providerRef" TEXT;
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "network" TEXT;
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "txHash" TEXT;
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "resolvedByAdminId" TEXT;
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "failureReason" TEXT;

-- 6) DB-level backstop: a balance can never go negative (app already guards this via
--    the conditional decrement; this catches any future code path that bypasses it).
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_balanceCents_nonneg";
ALTER TABLE "users" ADD CONSTRAINT "users_balanceCents_nonneg" CHECK ("balanceCents" >= 0);

-- 7) Foreign keys for always-real user references (chat author, club membership, push
--    subscription). Remove any pre-existing orphan rows first so the FK applies cleanly,
--    then (re)create the FK with ON DELETE CASCADE. Idempotent.
DELETE FROM "chat_messages"       WHERE "userId" NOT IN (SELECT "id" FROM "users");
DELETE FROM "club_members"        WHERE "userId" NOT IN (SELECT "id" FROM "users");
DELETE FROM "push_subscriptions"  WHERE "userId" NOT IN (SELECT "id" FROM "users");

CREATE INDEX IF NOT EXISTS "chat_messages_userId_idx" ON "chat_messages"("userId");

ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS "chat_messages_userId_fkey";
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "club_members" DROP CONSTRAINT IF EXISTS "club_members_userId_fkey";
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_subscriptions" DROP CONSTRAINT IF EXISTS "push_subscriptions_userId_fkey";
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
