# Crypto-Murlan — Full Audit (2026-06-08)

Six-dimension read-only audit (money, security, legal/compliance, reliability,
deployment/ops, code-quality/tests/frontend) focused on the code shipped since the
last audit (2026-06-05): the **real-money tournament subsystem**, the **real-money
shop**, **NOWPayments/Resend** wiring, **private games/clubs + join codes**, the
**friend notifier**, the **practice escrow-skip fix**, and the **live single-host
Docker deployment** (switch to bundled Postgres).

## Verdict

The **core remains strong** and was re-confirmed: match escrow/settle/refund is atomic
+ idempotent + crash-recoverable, provably-fair is sound, the game is server-authoritative,
and — importantly — **real-money games are genuinely human-only; the disguised-bot idea
was never built** (verified in code by two independent auditors).

The **new features did not inherit the core's safety rails**, and the **live operational +
legal posture has existential gaps**. In current state this is **not safe to run as a
real-money business**. The blockers are integration/enforcement/ops, not a redesign of
the core.

---

## 🔴 CRITICAL

### C1 — Unlicensed real-money gambling with EVERY compliance control switched off
Live, taking crypto deposits and paying cash prizes + tournaments, keeping a 10% rake,
with **no gambling license** and the four compliance gates disabled by config:
`KYC_REQUIRED=false`, `MIN_AGE=0`, `GEO_BLOCKED_COUNTRIES=` (empty), `RESPONSIBLE_GAMING=false`
(`.env:28-31`, `DEPLOYMENT.md:26-29`). There is **no real KYC/AML provider** — "KYC" is a
manual admin enum flip (`adminRoutes.ts:84`), no sanctions/PEP screening, no transaction
monitoring. Age is self-typed and not even collected at signup. Geo is a self-typed 2-letter
country with no IP geolocation. This is personal criminal exposure for a solo operator + a
high money-laundering-channel risk (crypto-in / cash-out, no identity), and NOWPayments' own
terms typically prohibit unlicensed gambling → **account/fund freeze risk that would trap
player balances**.
**Action:** Get licensed before continuing real money, OR convert to free-to-play/no-cashout.
At minimum, turn all four gates ON with real backing data, add a real KYC/AML provider gating
first-deposit + every withdrawal, and add IP geolocation. Engage a gambling attorney.

### C2 — Verify the LIVE host `.env` — the repo copy still targets Supabase with dev/placeholder secrets
The committed `.env` is `NODE_ENV=development`, `JWT_*=dev-…-change-in-prod`,
`PAYMENT_WEBHOOK_SECRET=dev-…`, and `DATABASE_URL/DIRECT_URL` pointing at
`…pooler.supabase.com` with a plaintext password (`.env:1,6-7,12,23-25`). **If that is the
file Compose reads on the VPS, the whole "bundled Postgres + daily backups" story is moot —
money is being written to Supabase, which the `db-backup` service never touches.**
**Action:** On the host run `docker compose exec server printenv DATABASE_URL NODE_ENV`. Ensure
prod uses `NODE_ENV=production`, strong unique secrets, and the bundled
`postgres://murlan:murlan@postgres:5432/murlan` (or unset to use the compose default). Rotate
the Supabase password now that it's been seen in plaintext.

### C3 — Postgres & Redis have NO restart policy → they don't come back after a reboot/OOM
The deploy overlay adds `restart: unless-stopped` to caddy/server/client/db-backup but
**deliberately omits postgres and redis** (`docker-compose.yml:5-28`, `docker-compose.deploy.yml`).
On a VPS reboot, OOM-kill, or `dockerd` restart, the app restarts but the DB doesn't → the
server crash-loops on `prisma migrate deploy` (can't reach DB) → full outage until manual
intervention. This is the single most likely real-world outage cause.
**Action:** Add `restart: unless-stopped` to `postgres` and `redis`.

### C4 — Escrowed tournament buy-ins can be stranded FOREVER (no recovery, no auto-advance, cancel blocked once running)
Register debits real money into the pot (`tournamentService.ts:103`), but: tournaments are
**not in the crash-recovery sweep** (`recoverOrphanedMatches` is matches-only —
`moneyService.ts`/`app.ts:482`), the bracket only advances when an **admin manually** POSTs
`/report` (the gateway never calls `reportResult`), and `cancel()` throws once status is
`running` (`tournamentService.ts:165`). So a crashed/abandoned/disputed tournament locks every
buy-in with no payout and no refund path. `wallet.reconcile()` won't flag it (balance still
equals ledger sum; money is just trapped in the pot).
**Action:** Add a tournament-orphan sweep (idempotent refund of non-finished tournaments) at
boot + in the periodic sweep, AND an admin force-cancel/refund that works in `running`.

### C5 — Tournament register/finish are not atomic and have no concurrency lock
Tournaments have no in-flight lock (unlike `MoneyService`) and `PrismaTournaments.save` is a
blind last-write-wins `update` with no version check (`prismaRepositories.ts:922`). Two
concurrent `POST /register` for the same user both pass the dupe check before either saves →
**double-debit** (the buy-in debit has no idempotency providerRef — `app.ts:408`). `finish()`
pays the champion before `repo.save()`, so a crash between them leaves the DB `running` while
money already moved (idempotent payout ref prevents a double-*pay*, but the state machine is
left inconsistent).
**Action:** Wrap register (debit+save) and finish (credit+rake+status+save) each in a single
UnitOfWork transaction; add a per-tournament in-flight lock; give the buy-in debit a
deterministic providerRef so retries can't re-charge.

---

## 🟠 HIGH

### H1 — Rotate the leaked secrets
`JWT_ACCESS/REFRESH_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `NOWPAYMENTS_API_KEY/IPN_SECRET`,
`RESEND_API_KEY` were pasted into a support chat. A leaked `JWT_*` lets an attacker forge a
token for any user (incl. admin → see H4). `.env` is correctly git+docker-ignored and not baked
into the image, so the *image* is clean — the exposure is the chat. **Rotate all of them now**
(invalidates existing JWTs → forces re-login, acceptable) and redeploy.

### H2 — Tournaments AND the real-money shop bypass every compliance/RG/account-state gate
The staked-match path runs `checkAccountRealMoney` + `compliance.checkRealMoney` +
`rg.checkLoss` before escrow (`gateway.ts:885-908`). `tournamentService.register()` and
`rewardsService.buy()` run **none** of these. So a self-excluded, frozen, banned, underage,
or geo-blocked user can buy into a real-money tournament and be paid out, or spend deposited
money in the shop. Directly undermines any claim that controls are enforced.
**Action:** Route tournament register + shop buy through the same gates as staked matches.

### H3 — Shop debit-then-grant is not atomic → user charged with no cosmetic, no refund
`rewardsService.buy()` debits the wallet, then calls `purchaseCosmetic` to grant
(`rewardsService.ts:148-155`). Not one transaction, no compensating credit. If the grant fails
after the debit commits, the money is gone and the user owns nothing.
**Action:** Run debit+grant in one transaction, or issue a compensating credit on grant failure.

### H4 — Tournament `/report` is pure admin-trust with no game binding (no dual-control)
The bracket winner is whatever an admin types; the gateway never plays the pairing as a real
match. Route is correctly `requireAdmin`-gated and validates the winner is one of the two in the
pairing (so not a privilege-escalation bug), but a single compromised/rogue admin can create a
tournament, have confederates register, and report a chosen account as champion to drain the
pool. Combined with the UI showing raw ids (H7), even an honest admin can mis-pay.
**Action:** Bind payouts to real match results (auto-`reportResult` from gateway match-end), or
require two-admin approval on non-zero-pool tournaments + alert on `tournament prize` credits.

### H5 — No off-server backup → one disk failure loses the live DB *and* all backups
The `db-backup` service writes to `./backups` on the same host disk as the live DB. No
offsite copy (no rclone/s3/scp anywhere).
**Action:** Sync `./backups` off-host on a schedule and *test* a restore.

### H6 — Migrate-on-boot with no pre-deploy backup + crash-loop on a bad migration
`Dockerfile.server:47` runs `prisma migrate deploy || exit 1`; `redeploy.sh` does
`git pull && up --build` with **no backup step first** and no rollback. A failed migration on
the populated prod DB → `restart: unless-stopped` loops forever; a half-applied migration with
no fresh backup is unrecoverable.
**Action:** `pg_dump` immediately before every redeploy; review each migration for
destructive/long-locking ops; consider migrations as a gated one-shot step.

### H7 — Tournament bracket shows raw truncated userIds, not usernames
`TournamentsView.tsx:43` renders `uid.slice(0,6)` everywhere — opponents, champion banner, and
the admin "report winner" buttons. The admin pays a real prize by choosing between two 6-char id
fragments → misclick/mispayment risk; players see `a1b2c3` instead of names.
**Action:** Include a `userId → username` map in the tournament DTO; render usernames.

### H8 — The bracket only models 1v1; Murlan is a 3-4 player game; no byes
`VALID_CAPACITIES = {2,4,8}` and `seedBracket` pairs exactly two players per match
(`tournamentService.ts:61,113`). There's no `MatchType` on a tournament and no way to express a
3/4-player Murlan table. Adding any non-power-of-two capacity would corrupt the next-round build.
**Action:** Decide intent — enforce + label 1v1-only, or restructure the bracket for N-player
tables. Guard/assert power-of-two until then.

### H9 — No resource limits → OOM-kill risk (possibly Postgres mid-write)
No `mem_limit`/`cpus` on any service. On a modest VPS a spike OOM-kills whichever process the
kernel picks.
**Action:** Set conservative per-service limits, tune PG `shared_buffers`/`work_mem`, add swap.

### H10 — The iPhone notch fix is incomplete: the in-game TableView (and SpectateView) still overlap
The safe-area insets you asked for were added only to the lobby `Shell` (`App.tsx:64-74`), but
`TableView`/`SpectateView` render **outside** Shell (`App.tsx:152-153`) and have no
`env(safe-area-inset-*)` (`TableView.tsx:245-248`). The main gameplay screen — Leave button,
turn timer, hand — still renders under the Dynamic Island / home indicator. **This is the screen
players spend the most time on, so the fix you requested doesn't actually cover it.**
**Action:** Add `paddingTop: calc(.75rem + env(safe-area-inset-top))` + left/right insets to the
TableView and SpectateView roots.

---

## 🟡 MEDIUM

- **M1 — Tournament buy-ins use ledger type `bet` with no matchId.** They count as a "loss" in the
  RG daily-loss cap the instant they're escrowed (can block the user from staked matches) and are
  excluded from the match-conservation invariant. Give them a distinct ledger type.
  (`app.ts:408`, `responsibleGaming.ts:41`, `walletService.ts:263`)
- **M2 — `joinByCode` (room + club) has no dedicated rate-limit / lockout.** 6-char codes
  (31^6 ≈ 887M, so not trivially brute-forced) but linear with N accounts and no per-code lockout.
  Add a low-rate limiter + consider 8-char codes.
- **M3 — Friend-request endpoint is a username/online-presence oracle** (distinct not_found vs
  success — `friendsService.ts:45`). Make it enumeration-safe like `forgot-password`.
- **M4 — Stale `insufficient_xp` branch + wrong status on the shop route.** `rewardsService.buy`
  returns `insufficient_funds`, but `rewardsRoutes.ts:55` still checks `insufficient_xp` and returns
  400 instead of 402 → user sees generic "Blerja dështoi". Map to a real message + 402.
- **M5 — Test gaps on new money/realtime code** (see list below).
- **M6 — Healthcheck/port mismatch:** Dockerfile probes `:3100`, compose binds `:3000`
  (`Dockerfile.server:42` vs `docker-compose.yml:36`) → container can be marked unhealthy.
- **M7 — The money-drift alarm (`BALANCE RECONCILE MISMATCH`) only logs to stdout.** Nothing
  scrapes `/metrics` or alerts. Add external uptime + a Prometheus scrape + page on
  `reconcileMismatches`/`pendingWithdrawals`. Also set Docker log rotation (disk-full risk).
- **M8 — DEPLOYMENT.md is stale** (still says "Postgres (Supabase)" + "rely on Supabase PITR").
  During an incident the runbook points at the wrong source. Update to the bundled-PG + db-backup
  reality and write a tested restore procedure.
- **M9 — GDPR:** no privacy policy, retention schedule, or data-subject access/erasure path for
  PII (email, DOB, country, IP). Needed before EU exposure.

## 🟢 LOW / confirmed-good

- **Real-money games are human-only — the disguised-bot scheme was never built.** Bots exist only
  in zero-stake practice (`gateway.ts:708`, `practice:true, stakeCents:0`); escrow is gated
  `if (this.money && !room.practice)`. Confirmed by two auditors. (Building the disguised-bot idea
  would be fraud / illegal rigged gambling — do not.)
- Match money core, provably-fair, NOWPayments IPN (intent-binding makes it safe even under key
  leak), input validation, fail-closed prod secret guard, non-root container, localhost-bound
  services, nginx CSP/HSTS — all solid.
- Practice escrow-skip fix is correct and leak-free.
- Data durability is actually sound *if* the bundled PG is live (named `pgdata` volume, no `down -v`
  in redeploy) — but see C2.
- Default DB creds `murlan/murlan` (localhost-bound, low risk — rotate for hygiene).
- Gateway monolith grew to ~1654 lines; `onJoinByCode` duplicates ~80% of `onJoin` — extract a
  shared `finishJoin` helper.

## New code with NO tests
1. `rewardsService.buy` real-money wallet debit (`rewards/rewardsService.ts:140-156`)
2. `/api/shop/buy` route debit + error mapping (`http/rewardsRoutes.ts`)
3. Tournament HTTP routes — admin gating, register escrow, 402 mapping (`http/tournamentRoutes.ts`)
4. Gateway `onJoinByCode` private-room join (`gateway.ts:353-378`)
5. Friend-request notifier (`friendsService.setNotifier` / `gateway.ts:155-157`)
6. Club `joinByCode` route + service (`http/clubRoutes.ts:79`, `social/clubService.ts:84`)

---

## Recommended order of work

**Do before trusting it with real money (launch blockers):**
1. **C2** verify the live host env (10 minutes, may change everything).
2. **C3** add restart policies to postgres/redis.
3. **H1** rotate the leaked secrets.
4. **C4 + C5** tournament orphan-sweep + force-cancel + atomic register/finish + lock.
5. **H2** route tournaments + shop through the compliance/RG/account-state gates.
6. **H3** make shop debit+grant atomic.
7. **H5 + H6** off-server backup + pre-deploy backup step.
8. **C1** the licensing/KYC/AML decision — the existential one; everything else is moot if
   NOWPayments freezes the account or a regulator acts.

**Soon:** H4 (tournament dual-control/game-binding), H7 (usernames in bracket), H10 (TableView
notch — the fix you asked for), H8 (1v1 bracket decision), H9 (resource limits), M1/M4/M6.

**Later:** M2/M3 (rate-limit/enumeration), M5 (tests), M7/M8 (observability/runbook), M9 (GDPR),
gateway refactor.
