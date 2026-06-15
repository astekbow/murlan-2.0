-- Performance indexes (audit IDX-1/2/3/4/6). All ADDITIVE: CREATE INDEX validates no
-- data and only briefly locks small tables, so this is safe to apply on the live DB.
-- IF NOT EXISTS keeps it idempotent (a re-run / a hand-created index can't error).
-- Names follow Prisma's "<table>_<column>_idx" convention so the schema stays in sync.

-- IDX-1: XP leaderboard (topByXp → ORDER BY xp DESC).
CREATE INDEX IF NOT EXISTS "users_xp_idx" ON "users"("xp");
-- IDX-2: admin user listing (newest-first).
CREATE INDEX IF NOT EXISTS "users_createdAt_idx" ON "users"("createdAt");
-- IDX-3: anti-cheat flag listing sorted by recency.
CREATE INDEX IF NOT EXISTS "suspicion_flags_createdAt_idx" ON "suspicion_flags"("createdAt");
-- IDX-4: chat-report moderation queue sorted by recency.
CREATE INDEX IF NOT EXISTS "chat_reports_createdAt_idx" ON "chat_reports"("createdAt");
-- IDX-6: admin withdrawal audit lookups by the resolving admin.
CREATE INDEX IF NOT EXISTS "withdrawals_resolvedByAdminId_idx" ON "withdrawals"("resolvedByAdminId");
