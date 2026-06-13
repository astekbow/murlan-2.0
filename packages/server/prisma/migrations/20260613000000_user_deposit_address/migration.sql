-- Per-player USDT-TRC20 deposit address (watch-only, derived from TRON_DEPOSIT_XPUB
-- at index `depositAddressIndex`). Additive + backward-compatible: both columns are
-- nullable and assigned lazily on first wallet visit. UNIQUE so an on-chain deposit
-- is attributed to exactly one account by which address received it (no claim-jacking).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "depositAddress" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "depositAddressIndex" INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS "users_depositAddress_key" ON "users"("depositAddress");
CREATE UNIQUE INDEX IF NOT EXISTS "users_depositAddressIndex_key" ON "users"("depositAddressIndex");
