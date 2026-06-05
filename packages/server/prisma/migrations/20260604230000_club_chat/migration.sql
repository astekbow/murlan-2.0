-- Club chat + moderation foundation. Additive, all standalone (soft string ids,
-- no FK), mirroring the suspicion/push tables. `username` on a message is
-- denormalized so chat history renders without a user join.

CREATE TABLE "chat_messages" (
  "id" TEXT NOT NULL,
  "clubId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_messages_clubId_idx" ON "chat_messages"("clubId");

CREATE TABLE "chat_reports" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "clubId" TEXT NOT NULL,
  "reporterId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "reviewed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_reports_reviewed_idx" ON "chat_reports"("reviewed");

CREATE TABLE "user_mutes" (
  "userId" TEXT NOT NULL,
  "until" TIMESTAMP(3) NOT NULL,
  "by" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  CONSTRAINT "user_mutes_pkey" PRIMARY KEY ("userId")
);
