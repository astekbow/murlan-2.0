-- Case-insensitive usernames: keep `username` for display, add `usernameLower`
-- as the unique lookup key (mirrors the in-memory repository contract).
ALTER TABLE "users" ADD COLUMN "usernameLower" TEXT;
UPDATE "users" SET "usernameLower" = lower("username");
ALTER TABLE "users" ALTER COLUMN "usernameLower" SET NOT NULL;
CREATE UNIQUE INDEX "users_usernameLower_key" ON "users"("usernameLower");
DROP INDEX "users_username_key";
