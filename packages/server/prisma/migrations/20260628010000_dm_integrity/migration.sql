-- DirectMessage referential integrity (audit 2026-06-28). ChatMessage already FKs userId -> users; DMs did
-- not. In practice users are ANONYMIZED (row retained for legal/AML), never hard-deleted, so DMs never
-- actually orphan — this is defense-in-depth + parity for any future hard-delete path.
--
-- NOT VALID: enforced on every NEW / updated row, but Postgres skips validating pre-existing rows, so the
-- migration CANNOT fail on (or touch) any existing row. ON DELETE CASCADE mirrors chat_messages (a hard
-- account delete, if ever added, would also drop that account's DMs). First null out nothing — DMs are
-- NOT NULL on both ids; CASCADE + NOT VALID is the safe additive shape.

ALTER TABLE "direct_messages"
  ADD CONSTRAINT "direct_messages_fromUserId_fkey"
  FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "direct_messages"
  ADD CONSTRAINT "direct_messages_toUserId_fkey"
  FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
