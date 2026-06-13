# Crypto-Murlan — Worldwide Launch Readiness

**Auditor's final verdict — 2026-06-13. Single-host Docker, cryptomurlan.com. Solo operator.**

> Produced by a 43-agent multi-dimension audit (legal/compliance, security/secrets, payments/treasury,
> reliability/ops, scalability, privacy/data) that re-checked the three prior audits (2026-06-01/-02/-08)
> against the **current** code and adversarially verified every blocker/high finding. 36 high/blocker
> findings verified; 19 confirmed open.

---

## 1. Verdict: **NO-GO** for worldwide real-money distribution

**Readiness score: ~58/100** (engine & money-safety ~85; legal/compliance ~25; ops ~70).

Do **not** distribute this worldwide as a real-money product in its current state. The *code* has matured
impressively — the money ledger, escrow, idempotency, and fail-closed config are genuinely strong — but the
platform is **unlicensed real-money gambling with every compliance control switched off** (`.env:28-31`:
`KYC_REQUIRED=false`, `MIN_AGE=0`, `GEO_BLOCKED_COUNTRIES=` empty, `RESPONSIBLE_GAMING=false`), **no real
KYC/AML provider**, **no privacy policy / data-deletion path**, and at least one **active money-loss bug**
(deposit claim-jacking). These are not configuration toggles you can flip on launch morning; the legal ones
are prerequisites that precede any technical work and carry **personal criminal and financial liability**
for you as a solo operator. A **CONDITIONAL-GO exists only for a free-to-play / no-cashout build** (see §6).

---

## 2. What is genuinely ready (real strengths, evidence-backed)

- **Money conservation is the anchor and it holds.** Balance-to-ledger reconciliation runs every 5 minutes
  and pages on drift (`walletService.ts:243-256`, `app.ts:608-612`). Credits/debits are one atomic
  UnitOfWork; rake is ledger-only and never breaks the sum.
- **Idempotency everywhere it matters.** Deposits are idempotent on `tron:${txId}` (`walletRoutes.ts:221-222`),
  withdrawal refunds are compare-and-set then credit (`withdrawals.ts:127-142`), failed Binance payouts are
  reconciled and auto-refunded idempotently (`paymentMonitor.ts:47-75`). A TxID, a refund, or a reversal each
  move money at most once.
- **Real-money games are human-only.** Bots exist only in practice (`stakeCents=0`/`practice=true`); escrow
  runs only for staked human matches (`gateway.ts:708`). The disguised-bot fraud scheme was never built.
- **Crash/restart safety.** Boot-time + periodic orphan sweep refunds stranded matches and abandoned
  tournaments (`app.ts:574-604`, `tournamentService.ts:219-237`); graceful drain settles in-flight pots.
- **Security baseline is solid.** JWT pinned to HS256 with issuer/audience (`tokens.ts:54-58`), refresh-token
  rotation + family reuse-detection, Argon2id passwords, HMAC-SHA256 webhooks with 5-min anti-replay +
  optional IP allowlist, Prisma (no raw SQL), production fail-closed on weak/placeholder secrets and on unset
  compliance flags (`config.ts:100-131`).
- **Unified real-money gate.** Deposits, withdrawals, paid tournaments, and the shop all route through one
  `checkRealMoneyAccess` gate (`realMoneyGate.ts:35-57`).

The skeleton is sound. The problem is everything legally required to wrap around it.

---

## 3. Launch blockers (must fix before worldwide real money)

### LEGAL / COMPLIANCE (existential — these gate everything)

**1. No gambling license + all compliance controls OFF.** The platform takes crypto deposits, pays cash
prizes, and takes a 10% rake (`RAKE_BPS=1000`, `.env:13`) while operating as **unlicensed gambling**, with
all four compliance gates disabled (`.env:28-31`). Operating unlicensed real-money gambling is a criminal
offense in most jurisdictions and exposes you personally; Binance will freeze the payout account and trap
player balances when it detects unlicensed gaming flows. *Fix:* obtain a license (Curaçao/Malta/Anjouan are
the common solo-operator routes) **before** accepting real money, then set the flags per jurisdiction.

**2. No real KYC/AML provider — "KYC" is a manual admin enum flip.** `KycStatus` is a `none|pending|verified`
enum an admin flips via `POST /api/admin/users/:id/kyc` (`adminRoutes.ts:124-134`). No Onfido/Jumio/Sumsub,
no document/liveness check, no OFAC/PEP/UN sanctions screening. An admin can reset `status:'none'` to
re-unlock the immutability gate. *Fix:* integrate a real KYC/AML provider with verified/blocked + sanctions
match; require provider-verification before first deposit/withdrawal; lock DOB/country to verified data.

**3. No transaction monitoring (AML structuring/velocity/round-trip).** The daily auto-payout cap only
tier-grades payouts (`config.ts:37`, `withdrawalPolicy.ts`); it does not detect structuring, velocity, or
deposit-then-immediate-withdraw round-trips, and there's no sanctions matching on money movement. FinCEN/FATF
and every gambling regulator require this. *Fix:* a `TransactionMonitoringService` on deposit/withdraw that
flags structuring/velocity/round-trips + large totals into a manual-review queue with a Telegram alert.

**4. No privacy policy, no data-export, no account deletion (GDPR/CCPA).** PII is stored (`schema.prisma:78,
102-103` — email, DOB, country; IPs logged at `app.ts:258`, `walletRoutes.ts:242`) with no published privacy
policy, no `/api/account/export` (GDPR Art.15/20), and no deletion/erasure path (Art.17). *Fix:* publish a
privacy policy; add data export; add account-closure + PII anonymization (preserve the ledger for the AML/tax
hold); redact `req.ip` from logs + set a retention period; sign DPAs with Binance/TronGrid/Resend/Telegram.

### TECHNICAL MONEY-SAFETY (smaller, but real and exploitable)

**5. Deposit claim-jacking — any user can steal another player's on-chain deposit. (CONFIRMED — active loss
vector.)** `/api/wallet/deposit/txid` credits whoever submits a valid TxID. `tronDeposit.verify()` checks
only that the transfer hit the house address — it returns the sender (`from`) but never binds the credit to
it (`tronDeposit.ts:48-75`). The anti-claim-race `DepositIntentTracker` exists (`depositIntentTracker.ts`)
but is never wired: `buildHttpApp` is called without `depositIntents` (`app.ts:514`), so the guard at
`walletRoutes.ts:201` is a dead no-op. An attacker watches the house TRON address on an explorer, copies a
victim's TxID, and claims it to their own account. Idempotency stops a *double*-credit but not the *first
wrong* credit. *Fix:* the robust solution is **per-user unique deposit addresses** (attribution by which
address received funds — not publicly guessable). Stopgaps (intent gating, declared-sender matching) are
weakened by the public blockchain (txid/from/amount are all visible). Until attribution is sound, route
self-service TxID deposits through operator confirmation.

**6. Tournament winner payout is admin-trust with no game binding.** `/api/tournaments/:id/report`
(`tournamentRoutes.ts:94-113`) pays the pool to whatever `winnerId` the admin types; `tournamentService.ts:156`
only checks the winner is one of the two paired — no real match is played, rooms have no `tournamentId`, the
gateway never reports tournament results. A rogue/compromised admin can drain a pool. *Fix:* auto-bind
tournament pairings to real staked matches so only match-end settlement reports the winner (remove the manual
`/report`), or require dual-admin approval on any non-zero payout with an alert on large prizes.

### OPERATIONAL (verify on the live host — could already be fine)

**7. Verify the live `.env`; rotate exposed secrets.** The committed dev `.env` holds plaintext Supabase
creds (`.env:23-25`) and `NODE_ENV=development`. Live Binance/TronGrid/Telegram keys were pasted into chat.
*Fix:* `docker compose exec server printenv DATABASE_URL NODE_ENV` — must show bundled `postgres:5432/murlan`
and `production`. Rotate the Supabase password, Binance key/secret, TronGrid key, Telegram token, and
regenerate JWT/webhook secrets with `openssl rand -hex 32`.

**8. Backups are on-host only (no offsite).** `db-backup` writes daily dumps to `./backups` on the **same
disk** as the live Postgres volume; the offsite rclone script (`deploy/backup-offsite.sh`) is manual/unwired.
A single disk/host failure loses the ledger **and** every backup. *Fix:* wire `backup-offsite.sh` into cron
to an offsite bucket (S3/B2), test a restore, update `DEPLOYMENT.md`.

---

## 4. High-priority (fix soon after / scaling)

- **Tournament register/finish not in a UnitOfWork transaction** (`tournamentService.ts:111-178`) — a crash
  between pay and status-flip leaves inconsistent state. **Hard blocker if you ever run >1 instance.**
- **Single-instance is a hard ceiling.** Timers, rate-limit, presence, matchmaking, deposit-cap
  serialization, and room ownership all live in process memory (`gateway.ts:125-137`, no-op
  `InMemoryRoomOwnership` at `app.ts:567`). Running 2+ replicas without Redis-backed state **will corrupt
  live matches and bypass deposit caps**. Enforce single-replica in the runbook until a real scaling sprint.
- **No container resource limits** (`docker-compose.deploy.yml`) — OOM-killer can evict Postgres mid-write.
- **PORT mismatch** (Dockerfile `3100` vs compose `3000`) — align to avoid fragile healthchecks.
- **TRON address checksum not validated server-side** (`walletRoutes.ts:122`) — verify Base58Check.
- **TronGrid 200-record window** can bury a deposit at volume (`tronDeposit.ts:52`) — add pagination.
- **Responsible-gaming UX gaps** — no pre-cashout warning, no approaching-limit warnings, no in-play RG banner.
- **Age collected post-signup, not at registration** (`authService.ts:58-62`).
- **No CDN, no cookie-consent banner, no consent-record table.**

---

## 5. Already handled since prior audits (real progress)

- **C1 silent-default trap → FIXED in code:** prod fails closed if any compliance flag is unset
  (`config.ts:119-131`). (The *legal* C1 — license + real KYC — remains.)
- **C3 restart policies → FIXED:** postgres/redis `restart: unless-stopped` (`docker-compose.deploy.yml:30-33`).
- **C4 stranded tournament buy-ins → FIXED:** `sweepStale()` voids+refunds (`tournamentService.ts:219-237`).
- **H2 tournament/shop bypassing gates → FIXED:** both call `checkRealMoneyAccess`.
- **H3 shop debit-then-grant → FIXED:** compensating refund on grant failure (`rewardsService.ts:142-168`).
- **H6 pre-deploy backup → FIXED:** `pg_dump` before migrate in `redeploy.sh`.
- **KYC immutability → FIXED at service layer** (`authService.ts:374-388`).
- **Self-excluded users can still withdraw → FIXED** (`complianceService.ts:91-107`).
- **JWT algorithm-confusion, webhook anti-replay, secret fail-closed → all FIXED.**

---

## 6. Recommended path to launch (ordered, realistic)

**Track A — Real-money worldwide (slow, expensive, but the only legal route):**

1. **Legal first, before any more code.** Engage a gambling attorney. Choose a licensing jurisdiction
   (Curaçao/Anjouan for solo operators; Malta/UK heavier). Confirm crypto-in/cash-out is permitted. **Until
   you hold a license, keep real-money OFF.**
2. **Rotate every exposed secret now** (Binance, TronGrid, Telegram, JWT/webhook, Supabase) regardless of
   timeline — they are already compromised (Blocker 7).
3. **Verify the live host** is `production` + bundled Postgres, and **wire offsite backups** with a tested
   restore (Blockers 7, 8).
4. **Integrate a real KYC/AML provider** (Sumsub/Onfido) — verification before first deposit/withdrawal,
   sanctions screening, DOB/country locked to verified data (Blocker 2).
5. **Build transaction monitoring** + manual-review queue (Blocker 3).
6. **Fix deposit claim-jacking** (per-user deposit addresses / operator confirmation) and the **tournament
   admin-trust payout** (auto-bind or dual-control) — code, do in parallel (Blockers 5, 6).
7. **Publish privacy policy; build export + deletion/anonymization; redact IPs; sign DPAs** (Blocker 4).
8. **Turn all four compliance flags ON** per the licensed jurisdiction, wire the RG UX, geo-block by **IP
   geolocation** (not self-typed country), collect age at signup.
9. **Soft-launch in one licensed jurisdiction only**, geo-fenced, before any "worldwide" claim.

**Track B — Free-to-play / no-cashout (fast, low-risk — recommended near-term):**

Ship now **without real-money cash-out**: practice/play-money only, cosmetics bought with currency that
**cannot be withdrawn to crypto**. This removes the gambling-license and most AML/KYC exposure (you still
publish a privacy policy + honor deletion if you hold EU PII). The engine, matchmaking, tournaments, and
cosmetics are ready for this today. Note: in some jurisdictions even "buy currency → win prizes" is gambling,
so confirm the model with the same attorney before enabling any purchase.

**Bottom line:** good engineering sitting on top of an unlicensed real-money gambling operation with the
compliance subsystem turned off and a live deposit-theft bug. Do not distribute it worldwide for real money.
Either complete Track A behind a license and real KYC/AML, or ship Track B (free-to-play) now and earn while
the legal foundation is laid.
