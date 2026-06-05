-- Responsible-gaming self-imposed daily limits (cents per UTC day; NULL = no
-- limit). Additive only — two nullable columns on the existing users table.

ALTER TABLE "users" ADD COLUMN "dailyDepositLimitCents" INTEGER;
ALTER TABLE "users" ADD COLUMN "dailyLossLimitCents" INTEGER;
