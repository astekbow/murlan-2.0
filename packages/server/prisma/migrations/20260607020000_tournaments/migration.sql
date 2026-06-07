-- Tournaments (single-elimination, real-money buy-ins). playerIds + bracket as JSONB
-- so escrowed buy-ins + bracket state survive a restart.
CREATE TABLE IF NOT EXISTS "tournaments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "buyInCents" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'registering',
    "playerIds" JSONB NOT NULL DEFAULT '[]',
    "bracket" JSONB NOT NULL DEFAULT '[]',
    "prizePoolCents" INTEGER NOT NULL DEFAULT 0,
    "rakeBps" INTEGER NOT NULL,
    "winnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "tournaments_status_createdAt_idx" ON "tournaments"("status", "createdAt");
