-- Granular admin RBAC: per-admin permission scopes. Additive + backward-compatible:
-- the column defaults to an empty array, and an admin with NO scopes is treated as
-- a full admin (the current behaviour), so every existing admin is unaffected.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "permissions" TEXT[] NOT NULL DEFAULT '{}';
