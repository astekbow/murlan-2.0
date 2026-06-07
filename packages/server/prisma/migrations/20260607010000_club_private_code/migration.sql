-- Private clubs: a privacy flag + a shareable join code (hidden from the public list).
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "private" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "joinCode" TEXT;
