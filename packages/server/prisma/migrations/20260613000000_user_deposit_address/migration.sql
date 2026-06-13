-- Per-player USDT-TRC20 deposit address (watch-only, derived from TRON_DEPOSIT_XPUB
-- at index `depositAddressIndex`). Additive + backward-compatible: both columns are
-- nullable and assigned lazily on first wallet visit. UNIQUE so an on-chain deposit
-- is attributed to exactly one account by which address received it (no claim-jacking).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "depositAddress" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "depositAddressIndex" INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS "users_depositAddress_key" ON "users"("depositAddress");
CREATE UNIQUE INDEX IF NOT EXISTS "users_depositAddressIndex_key" ON "users"("depositAddressIndex");

-- Hand out address indices from a SEQUENCE (not max+1) so concurrent first-time
-- wallet visits each get a DISTINCT index without colliding on the unique constraint
-- (a max+1 scheme makes every concurrent new user compute the same index → serialize
-- → some fail). Gaps are fine (the xpub derives a valid address at any index).
CREATE SEQUENCE IF NOT EXISTS "deposit_address_index_seq" MINVALUE 0 START WITH 0;
