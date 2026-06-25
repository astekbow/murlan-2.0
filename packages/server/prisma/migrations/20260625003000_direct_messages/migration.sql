-- Direct messages (friends-only 1:1). `fromUsername` is denormalized so a conversation renders
-- without a user join. `readAt` (null = unread) drives per-friend unread badges. No FKs — the app
-- gates sends by friendship. Additive new table → safe on a live DB.
CREATE TABLE IF NOT EXISTS "direct_messages" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "fromUsername" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "direct_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "direct_messages_fromUserId_toUserId_createdAt_idx" ON "direct_messages"("fromUserId", "toUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "direct_messages_toUserId_readAt_idx" ON "direct_messages"("toUserId", "readAt");
