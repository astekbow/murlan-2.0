-- Ranked competitive ladder: seasons + per-user season rating rows.
-- Additive only — no existing table/column is modified. Ratings are
-- competitive/cosmetic and have NO link to the money ledger.

-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('active', 'archived');

-- CreateTable
CREATE TABLE "seasons" (
  "id" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "status" "SeasonStatus" NOT NULL DEFAULT 'active',
  "decayFactor" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_seasons" (
  "userId" TEXT NOT NULL,
  "seasonId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL DEFAULT 1000,
  "peakRating" INTEGER NOT NULL DEFAULT 1000,
  "games" INTEGER NOT NULL DEFAULT 0,
  "wins" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_seasons_pkey" PRIMARY KEY ("seasonId", "userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "seasons_number_key" ON "seasons"("number");

-- CreateIndex
CREATE INDEX "seasons_status_idx" ON "seasons"("status");

-- CreateIndex
CREATE INDEX "user_seasons_seasonId_rating_idx" ON "user_seasons"("seasonId", "rating");

-- CreateIndex
CREATE INDEX "user_seasons_userId_idx" ON "user_seasons"("userId");

-- AddForeignKey
ALTER TABLE "user_seasons" ADD CONSTRAINT "user_seasons_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_seasons" ADD CONSTRAINT "user_seasons_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
