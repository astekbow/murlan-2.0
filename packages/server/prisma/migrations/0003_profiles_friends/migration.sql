-- Phase 5: player progression (XP/stats), cosmetic avatar, and friendships.

ALTER TABLE "users" ADD COLUMN "xp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "gamesPlayed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "wins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "biggestPotCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "currentStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "avatar" TEXT;

CREATE TYPE "FriendStatus" AS ENUM ('pending', 'accepted');

CREATE TABLE "friendships" (
  "id" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "addresseeId" TEXT NOT NULL,
  "status" "FriendStatus" NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "friendships_requesterId_addresseeId_key" ON "friendships" ("requesterId", "addresseeId");
CREATE INDEX "friendships_addresseeId_idx" ON "friendships" ("addresseeId");

ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
