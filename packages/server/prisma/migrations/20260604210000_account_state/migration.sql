-- Account lifecycle (trust & safety): active / frozen / suspended / banned.
-- Additive only — a new enum + three columns. `accountState` defaults to
-- 'active', so every existing user row is unaffected.

CREATE TYPE "AccountState" AS ENUM ('active', 'frozen', 'suspended', 'banned');

ALTER TABLE "users" ADD COLUMN "accountState" "AccountState" NOT NULL DEFAULT 'active';
ALTER TABLE "users" ADD COLUMN "accountStateReason" TEXT;
ALTER TABLE "users" ADD COLUMN "accountStateUntil" TIMESTAMP(3);
