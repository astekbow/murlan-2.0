-- VIP weekly gift: the ISO-week key ('YYYY-Www') of the last claimed weekly cosmetic gift.
-- Nullable (null = never claimed) so existing rows are unaffected. Idempotent.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastVipGift" TEXT;
