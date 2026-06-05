-- Anti-collusion / anti-bot heuristic flags for manual admin review. Additive.

-- CreateTable
CREATE TABLE "suspicion_flags" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "severity" INTEGER NOT NULL,
  "detail" TEXT NOT NULL,
  "matchId" TEXT,
  "reviewed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "suspicion_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suspicion_flags_reviewed_idx" ON "suspicion_flags"("reviewed");

-- CreateIndex
CREATE INDEX "suspicion_flags_userId_idx" ON "suspicion_flags"("userId");
