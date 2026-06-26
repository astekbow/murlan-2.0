-- Guard the Club War money-state machine at the DB level (audit L6).
--
-- club_wars.status is free-text TEXT (default 'registering'). A typo'd write outside the valid set
-- would silently drop a war out of listActive's recovery filter (status IN ('registering','running'))
-- → stranded escrowed buy-ins — the exact failure mode the tournaments_status_check
-- (20260624010000) was added to prevent. A CHECK constraint is invisible to Prisma's schema diff
-- (same as the tournaments/users.balanceCents CHECKs), so it adds no schema drift.
ALTER TABLE "club_wars"
  ADD CONSTRAINT "club_wars_status_check"
  CHECK ("status" IN ('registering', 'running', 'finished', 'cancelled'));
