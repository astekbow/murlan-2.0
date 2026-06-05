-- Match move-log for deterministic replay + dispute/audit. Standalone (no FK):
-- a matchId exists for every match, but a `matches` row only exists for staked
-- matches, so a FK would reject casual-match actions. Additive only.

-- CreateTable
CREATE TABLE "game_actions" (
  "matchId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "gameIndex" INTEGER NOT NULL,
  "seat" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "cards" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "game_actions_pkey" PRIMARY KEY ("matchId", "seq")
);

-- CreateIndex
CREATE INDEX "game_actions_matchId_idx" ON "game_actions"("matchId");
