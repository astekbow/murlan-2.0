-- Schema-integrity hardening (audit 2026-07-01: db-4 enum/CHECK columns, db-5 CHECK drift, db-6
-- DepositIntent FK). Four free-text status/type/role/category columns get a CHECK pinning them to
-- their known value set, and deposit_intents.userId gets the FK it was missing.
--
-- ALL constraints are added NOT VALID: Postgres enforces them on every NEW / updated row but SKIPS
-- validating pre-existing rows, so this migration CANNOT fail on (or touch) any existing data — even
-- if some historical row were out of range. Once you've confirmed the live data is clean you can
-- promote each with:  ALTER TABLE <t> VALIDATE CONSTRAINT <c>;  (optional, non-blocking).
--
-- The value sets below are the COMPLETE unions written by the code (verified against the writers):
--   matches.type           ← MatchType            = '1v1' | '1v1v1' | '2v2'          (gateway validates)
--   game_actions.type      ← MatchActionType      = 'play' | 'pass' | 'switch' | 'forfeit'
--   support_tickets.category ← zod enum           = 'match' | 'payment' | 'account' | 'other'
--   club_members.role      ← ClubRole             = 'founder' | 'member'
-- CHECK constraints are invisible to Prisma's schema diff (same as the existing tournaments /
-- club_wars / users.balanceCents CHECKs), so they add no schema drift.

ALTER TABLE "matches"
  ADD CONSTRAINT "matches_type_check"
  CHECK ("type" IN ('1v1', '1v1v1', '2v2')) NOT VALID;

ALTER TABLE "game_actions"
  ADD CONSTRAINT "game_actions_type_check"
  CHECK ("type" IN ('play', 'pass', 'switch', 'forfeit')) NOT VALID;

ALTER TABLE "support_tickets"
  ADD CONSTRAINT "support_tickets_category_check"
  CHECK ("category" IN ('match', 'payment', 'account', 'other')) NOT VALID;

ALTER TABLE "club_members"
  ADD CONSTRAINT "club_members_role_check"
  CHECK ("role" IN ('founder', 'member')) NOT VALID;

-- deposit_intents.userId had no referential integrity. Users are ANONYMIZED (row retained for
-- legal/AML), never hard-deleted, so intents never actually orphan — this is defense-in-depth +
-- parity with chat_messages / direct_messages. Intents are transient (swept after ~72h), so a hard
-- account delete (if ever added) should also drop that account's intents → ON DELETE CASCADE.
ALTER TABLE "deposit_intents"
  ADD CONSTRAINT "deposit_intents_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
