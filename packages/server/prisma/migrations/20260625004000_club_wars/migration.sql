-- Club War (round-robin series between two clubs, free or buy-in). rosters + pairings as JSONB
-- so escrowed buy-ins + scores survive a restart (mirrors the tournaments table). New table → safe.
CREATE TABLE IF NOT EXISTS "club_wars" (
    "id" TEXT NOT NULL,
    "clubAId" TEXT NOT NULL,
    "clubBId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'registering',
    "stakeCents" INTEGER NOT NULL,
    "rakeBps" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "rosterA" JSONB NOT NULL DEFAULT '[]',
    "rosterB" JSONB NOT NULL DEFAULT '[]',
    "pairings" JSONB NOT NULL DEFAULT '[]',
    "scoreA" INTEGER NOT NULL DEFAULT 0,
    "scoreB" INTEGER NOT NULL DEFAULT 0,
    "prizePoolCents" INTEGER NOT NULL DEFAULT 0,
    "winnerClubId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "club_wars_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "club_wars_clubAId_createdAt_idx" ON "club_wars"("clubAId", "createdAt");
CREATE INDEX IF NOT EXISTS "club_wars_clubBId_createdAt_idx" ON "club_wars"("clubBId", "createdAt");
