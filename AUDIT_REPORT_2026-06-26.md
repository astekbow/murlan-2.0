# 🔬 Ultra Audit — Crypto-Murlan (2026-06-26)

> Read-only forensic review of the whole monorepo by 5 parallel domain auditors (Opus, high-effort) +
> adversarial verification of every critical/high finding + a manual re-verification of the one critical.
> **Nothing was modified.** Every finding carries `file:line` evidence. Severity = impact × likelihood
> for a **real-money** app: 🔴 Critical · 🟠 High · 🟡 Medium · 🔵 Low · ⚪ Info.
>
> Stack: TS monorepo (`engine` rules · `shared` DTOs · `server` Fastify 5/Socket.IO 4.8/Prisma 5·PG/Redis ·
> `client` React 18/Vite/Tailwind/Zustand). ~37.5k LOC, 363 commits. Single-host Docker (Caddy→nginx→server).

---

## 1. Executive Summary

This is a **genuinely well-engineered real-money codebase** — well above the median for its size. The
server is strictly authoritative (the client is never trusted), the money layer is built with real
transactional atomicity, idempotent at-most-once credits, atomic compare-and-set status transitions, and a
per-user advisory lock; admin RBAC fails *closed*; JWTs are hardened against alg-confusion and are
revocation-aware; there are **zero npm vulnerabilities, no committed secrets**, a real CI go/no-go gate
(typecheck + tests against a throwaway Postgres + Trivy + SBOM + compliance gate), wired Prometheus
alerting, and **verified** backups. The audit surfaced **25 findings but only ONE Critical** — and that one
is a single-row fix, not a design flaw: the house rake ledger writes to a `__house__` user that **does not
exist**, and `transactions.userId` has an enforced foreign key, so the first staked match that books rake
(default 10%) would have its settlement **rolled back** on real Postgres (winners unpaid, match stuck
`active`). The in-memory test ledger has no FK, which is exactly why 83 server test files stayed green and
hid it. Everything else is Medium-or-below: an owner-acknowledged P2P-transfer AML gap, a non-atomic Club
War escrow, a hot-path full-ledger scan, a private-room join-code collision risk, the known 2,658-LOC
`gateway.ts` god-object, and badly **stale README/DEPLOYMENT docs** that contradict the (excellent) RUNBOOK.
**Headline:** fix the one Critical (seed the house account + add a Postgres-backed settle test), set a
transfer cap, and reconcile the docs — then this is a strong, launch-grade engineering base (compliance/
licensing remains a separate, owner-tracked gate, not assessed here).

## 2. Health Scorecard

| Dimension | Score | One-line justification |
|---|:---:|---|
| Architecture | 7/10 | Strictly server-authoritative + clean DI; dragged by the 2,658-LOC `gateway.ts` god-object. |
| Code Quality | 8/10 | No TODO/FIXME in source, strong cosmetic-vs-money isolation; `any` at the Prisma boundary. |
| Security | 9/10 | IDOR structurally impossible, RBAC fail-closed, JWT hardened, no injection/secrets, layered rate-limits. |
| Database | 6/10 | Exemplary idempotency/atomicity/indexing — but the 🔴 `__house__` FK settle-blocker. |
| UI / UX | 8/10 | Focus traps everywhere, double-submit guards, loading/empty/error states, code-split. |
| Accessibility | 8/10 | `GameAnnouncer` is exemplary; AA contrast + 44px targets + reduced-motion; 2 overlays miss live-regions. |
| Performance | 7/10 | Lazy/code-split client; hot-path unbounded ledger scan + render-blocking fonts. |
| Tests | 7/10 | 83 server + 87 client tests incl. CI Postgres — but in-memory ledger hid the Critical. |
| DevOps | 8/10 | Real CI gate, non-root, healthchecks, verified backups, wired alerting; floating base images. |
| Docs | 6/10 | RUNBOOK is excellent & current; README/DEPLOYMENT are badly stale and contradict it. |

### **Overall: 72 / 100** — *one Critical fix + doc reconciliation away from the mid-80s.*

---

## 3. Top 10 Priorities

| # | Finding | Sev | Effort | Why now |
|:-:|---|:---:|:---:|---|
| 1 | **`__house__` rake FK violation rolls back staked settlement** | 🔴 | **S** | Core loop: on a fresh Postgres, no staked match can pay winners. One-row fix. |
| 2 | **P2P transfer has no cap/KYC/hold by default** | 🟡 | S | AML/mule/collusion-cashout rail; cap is `0`=unlimited until set. Set before any real volume. |
| 3 | **Club War escrow debit + roster-save not atomic** | 🟡 | M | A crash mid-step strands a real buy-in; no clubwar orphan sweep exists. |
| 4 | **README/DEPLOYMENT stale** (wrong TLS upstream, DB, payment rails) | 🟡 | M | Mis-steers an operator during setup/incident; contradicts RUNBOOK. |
| 5 | **Full-ledger scan on every settle/profile** (VIP multiplier) | 🟡 | M | Latency/OOM grows with each player's lifetime as the DB ages. |
| 6 | **Private join-code has no uniqueness check** | 🟡 | S | Code collision can seat a redeemer into a stranger's staked private room. |
| 7 | **`gateway.ts` 2,658-LOC god-object** | 🟡 | L | Every change risks unrelated timer/settlement maps; hard to test in isolation. |
| 8 | **`GET /wallet/transactions` `take` unclamped** | 🔵 | S | Self-DoS: a user can request their whole ledger into the heap. Quick win. |
| 9 | **Floating base images (`node:22-alpine`, `prom/*:latest`)** | 🔵 | S | Non-reproducible/ non-tamper-evident builds; `pin-images.sh` exists, just run+commit it. |
| 10 | **No DB CHECK on `club_wars.status` / `matches.type`** | 🔵 | S | A bad status write silently strands escrow (the exact bug the tournament CHECK fixed). |

---

## 4. Detailed Findings

### 🔴 CRITICAL

**C1 — Rake ledger writes to a non-existent `__house__` user → FK violation aborts every staked settlement**
`packages/server/src/money/walletService.ts:302,307` · `prisma/migrations/0001_init/migration.sql:144` · `schema.prisma:277`
- **Evidence (independently re-verified):** `recordRake()` writes a ledger row with `userId='__house__'`. `Transaction.user` is a **required** relation (`schema.prisma:277`) and `transactions_userId_fkey FOREIGN KEY(userId) REFERENCES users(id) ON DELETE RESTRICT` is created in `0001_init:144` and **never dropped/altered** in any of the 35 migrations. `PrismaLedger.append` (`prismaRepositories.ts:441-443`) writes `userId` verbatim. The house is **ledger-only with no `users` row by design** (`walletService.ts:399`: *"has no User row, so getBalance(HOUSE) is always 0"*) and **no seed/upsert creates it** (grep across all migrations + src = none). `settle()` calls `recordRake` whenever `rakeCents>0` (`moneyService.ts:167`); default `RAKE_BPS=1000` (10%, `config.ts:31`). `appendIdempotent`'s `createMany({skipDuplicates})` only swallows *unique* conflicts — **not** the FK violation (P2003).
- **Why it matters:** On real Postgres, the rake `INSERT` throws inside the `settle` `$transaction` → the whole settlement (winner payouts + `markSettled`) rolls back → match stuck `active`, winners unpaid (later force-refunded, so stakes return but the house earns $0 and **no staked game ever concludes with a payout**). Tournament prize payout has the same exposure (`payoutChampion`). All 63 money tests pass because `InMemoryLedger` has no FK.
- **Fix:** Seed the house once (migration or boot): `INSERT INTO users (id, username, usernameLower, email, passwordHash, ...) VALUES ('__house__', ...) ON CONFLICT DO NOTHING;` **and** add a **Postgres-backed** integration test that settles a staked match with `rake>0` so CI catches this class. **First, confirm against the live DB whether a `__house__` row was hand-inserted** — if staked matches have been settling in prod, a row exists and this is *latent on a fresh DB*; if not, staked settlement is currently broken.

### 🟡 MEDIUM

**M1 — P2P wallet transfer has no KYC / amount / velocity / hold by default** · `http/walletRoutes.ts:163-216`
Cap defaults to `0`=unlimited (`:193`); owner-acknowledged in a code comment. Friends-only + compliance-gated, but no value ceiling/hold ⇒ laundering/collusion-cashout rail. **Fix:** set `dailyTransferCapCents`, add a per-tx max + short hold on received funds before they're withdrawable; flip default-open → default-capped for prod.

**M2 — Club War buy-in escrow is not transactional** · `social/clubWarService.ts:83-90` · `app.ts:732-743`
`debit()` then `repo.save()` as two awaits; compensating refund only fires if `save()` *throws*. Unlike `tournamentService` (UoW-threaded, SCH-3), `ClubWarWallet` takes no `ctx`. A crash between the two strands the buy-in, and there's no clubwar orphan sweep. **Fix:** thread `WalletTxContext` and wrap escrow+save in `uow.transaction`; add a stale-clubwar refund sweep.

**M3 — README.md / DEPLOYMENT.md badly stale** · `DEPLOYMENT.md:§0,§2,§4,§9` · `README.md:97-108`
Last touched 2026-06-06 (compose is 2026-06-24). Tells operators `reverse_proxy 127.0.0.1:8080` (real Caddyfile uses `client:80`), documents Supabase/in-memory DB defaults (compose defaults to bundled Postgres), and "mock payment provider / PayPal" (live system is on-chain USDT-TRC20 + Binance), and KYC-gated withdrawals (KYC was removed). **Fix:** reconcile with reality or fold into RUNBOOK and mark superseded.

**M4 — Full-ledger scan on the hot settlement/profile path** · `profile/profileService.ts:231,203` · `walletService.ts:362-364`
`recordMatch()` derives the VIP-XP multiplier via `listTransactions(userId)` — **unbounded** `listByUser` — per seat at every match end, and again on every profile/leaderboard-ring open. The team already paginated the admin equivalent (`adminRoutes.ts:136`) but not this. **Fix:** derive lifetime staked volume from a bounded `SUM()` (or a running `stakedVolumeCents` column updated at escrow).

**M5 — `gateway.ts` is a 2,658-LOC god-object** · `realtime/gateway.ts:139-2658`
One class owns connection lifecycle, handshake, room CRUD, matchmaking, bots, provably-fair, settlement, forfeit, tournaments, club-wars, chat, spectating, ticker + 20 mutable Maps + 25 injected services. Maintainability/regression risk, not a live bug. **Fix:** extract `MatchLifecycle` / `BotDriver` / `SocialBridge` / `SpectatorRegistry` behind the existing `TimerOrchestrator` pattern; gateway becomes a thin router. *(Known/deferred — ARCH-1.)*

**M6 — Private-room join codes have no uniqueness check** · `room/roomManager.ts:41-46,197,276-281`
`genJoinCode()` = 6 digits, assigned without checking it's free; `roomIdForCode()` returns the **first** match → `markInvited` authorizes the redeemer into whichever room matched first. Birthday-bound collisions become real at ~1k concurrent private rooms (and an attacker can farm codes). **Fix:** `do/while` reject codes held by a live private room and/or a `code→roomId` index with insert-time uniqueness; widen alphabet/length.

### 🔵 LOW

- **L1 — `GET /wallet/transactions` `take` unclamped** · `walletRoutes.ts:155-160` — `Number(q.limit)||200` with no `Math.min` (admin/export clamp to 100/500). Self-scoped heap pressure. **Fix:** `Math.min(500, Math.max(1, …))`. *(quick win)*
- **L2 — Auto-payout 24h caps serialized single-instance** · `walletRoutes.ts:108-133,320-339` — in-process Promise chains, not a DB budget. Multi-instance could overrun per-user/global/dest caps (NOT a double-pay — the claim-first guard holds). Fine for single-host. **Fix:** DB-backed budget inside the claim tx before scaling.
- **L3 — Deposit-cap serializer + deposit-watch registry single-instance** · `walletService.ts:115-121` · `depositPoller.ts:21-55` — documented; correct on single-host, weak if scaled. **Fix:** Redis-back before horizontal scale.
- **L4 — Prisma row mappers + JSON columns typed `any`** · `prismaRepositories.ts:51,…,1266` — schema/client drift compiles clean, surfaces at runtime on money/match objects. **Fix:** `Prisma.*GetPayload<{}>` row types + zod-validate JSON columns on read.
- **L5 — `applyMatchResult` non-atomic streak/biggestPot** · `prismaRepositories.ts:240-255` — read-modify-write; **cosmetic only** (increments use `{increment}`). **Fix:** SQL `GREATEST`/small tx, or comment the deliberate cosmetic race.
- **L6 — No DB CHECK on `club_wars.status` / `matches.type`** · `schema.prisma:467,289` — tournament got a CHECK to stop stranded escrow; clubwar (same escrow pattern) didn't. **Fix:** `CHECK status IN (...)`. *(quick win)*
- **L7 — RankedSearchOverlay not exposed to AT** · `components/ui/RankedSearchOverlay.tsx:21-36` — no `role=dialog`/`aria-modal`/live-region/focus-trap (sibling `ReconnectOverlay` does it right). **Fix:** mirror `ReconnectOverlay`. *(quick win)*
- **L8 — RotateOverlay lacks live-region** · `components/ui/RotateOverlay.tsx:10-22` — no `role=status`/`aria-live`; on iOS it's the only thing shown. **Fix:** add `role=status aria-live=assertive`. *(quick win)*
- **L9 — Render-blocking Google Fonts, no preload** · `index.html:21-26` — 3 families/~11 weights via sync `<link>`; LCP swap on the hero. **Fix:** self-host woff2 subset / `preload` the 1-2 heading weights / trim weights.
- **L10 — RUNBOOK §6 lists an already-fixed `:8080` incident** · `RUNBOOK.md:133` — client is already `127.0.0.1:8080` in both compose files. **Fix:** drop/rewrite the row. *(quick win)*
- **L11 — Floating base & monitoring images** · `Dockerfile.server:9,23` · `Dockerfile.client:9,20` · `docker-compose.deploy.yml:94,105` — `node:22-alpine`, `prom/*:latest` unpinned. **Fix:** run `deploy/pin-images.sh`, commit the `@sha256` digests.
- **L12 — CI Trivy action pinned to `@master`** · `.github/workflows/ci.yml:106,113` — mutable ref runs with the workflow token (others are `@v4`). **Fix:** pin to a SHA/tag. *(quick win)*

### ⚪ INFO (verify / keep-as-is)
- **I1 — Many `catch(()=>undefined)` swallows** (`gateway.ts:343,369,807,…`) — *intentional* isolation of cosmetic/social/audit from money (a **strength**); just log+count the audit-relevant ones (matchLog/anti-cheat) so a chronic failure is visible.
- **I2 — CSP off at the API/helmet layer** (`app.ts:189-195`) — correct (API serves JSON); **verify the static host/Caddy sets a strict CSP for the client origin** — don't bolt a no-op CSP onto the JSON API.
- **I3 — Tournament/ClubWar bracket/roster as unbounded JSON** (`schema.prisma:621-622,462-466`) — fine at capacities {2,4,8}; normalize to rows only if larger tournaments are ever added.
- **I4 — `useFocusTrap` uses `offsetParent`** (`useFocusTrap.ts:18-19`) — drops fixed-positioned focusables; no broken overlay today. **Fix later:** filter via `getClientRects().length`.
- **I5 — Emoji in aria-labelled icon buttons not `aria-hidden`** (`TopBar.tsx:122-143`) — possible double announcement; wrap in `<span aria-hidden>`.
- **I6 — CI builds+scans images but doesn't push/deploy** (`ci.yml:91-118`) — prod rebuilds from source via `redeploy.sh`; the scanned artifact ≠ the deployed one (byte-identical only with pinned bases). Fine for single-operator; image-based deploy when scaling.

---

## 5. Quick Wins (< 1 hour each)
1. **Clamp** `GET /wallet/transactions` `take` (L1) — one line.
2. **Set** `dailyTransferCapCents` to a real value (M1) — config.
3. **Add** `CHECK club_wars.status IN (...)` migration (L6).
4. **a11y:** `role=dialog`+trap on RankedSearchOverlay (L7) and `role=status` on RotateOverlay (L8); `aria-hidden` emoji in TopBar (I5).
5. **Pin** the Trivy action to a SHA (L12).
6. **Fix** the stale `:8080` RUNBOOK row (L10).
7. **Run** `deploy/pin-images.sh` and commit digests (L11).

## 6. Remediation Roadmap

**🚨 Now (this week)**
- **C1** — seed `__house__` user (migration/boot) **and** add a Postgres-backed staked-settle test in CI; confirm the live-DB state first.
- **M1** — set transfer cap (+ consider hold) before any real volume.
- **M3** — reconcile README/DEPLOYMENT with reality (or supersede via RUNBOOK).
- Quick wins L1, L6, L7, L8, L10, L12.

**🛠️ Next (this sprint)**
- **M2** — Club War UoW atomicity + stale-clubwar refund sweep.
- **M4** — bounded staked-volume aggregate (kill the hot-path full scan).
- **M6** — join-code uniqueness/index.
- **L11** — pin base/monitoring images. L9 — font preload/subset. L4 — typed row mappers + zod-validated JSON. I1/I2 — log-count swallows; verify static-host CSP.

**🌱 Later (backlog)**
- **M5** — `gateway.ts` decomposition (ARCH-1).
- Multi-instance hardening (L2/L3): Redis-backed payout/deposit caps + watch registry + per-id locks **before any horizontal scale**.
- Image-based deploy (I6); JSON normalization if tournaments grow (I3); `useFocusTrap` visibility fix (I4).

---

## 7. What I did NOT cover (scope statement)
- **No live DB / network.** C1 was verified **statically** (schema + migrations + code) and by an adversarial sub-agent, but I could not query prod — **confirm whether a `__house__` row exists in the live DB** (decides "latent" vs "currently broken").
- **No runtime tooling:** did not run the app, axe-core/Lighthouse, a real screen reader, or real-device touch testing — a11y/CWV findings are from static review + computed contrast.
- **Sampled, not line-by-line:** the `match.ts` rules engine, every client component beyond the audited views/overlays, `clubWarService`/RG internals, and `checkProdConfig.ts` body were sampled via grep, not fully read.
- **Out of scope (separate owner track):** legal/licensing, KYC/AML *policy*, and the gambling-compliance gate — flagged in prior docs (`LAUNCH_READINESS.md`), not re-assessed here.
- **Not re-listed:** issues the prior audits already fixed (verified against live code) — this report focuses on the current, unaddressed state.

---

## 8. Resolution status (updated 2026-06-27)

Remediation was carried out in verified, committed batches (server+client tsc clean, **700 server +
87 client tests pass**, builds green after every batch). Status of all 25 findings:

### ✅ Fixed & committed
| Finding | What shipped |
|---|---|
| 🔴 **C1** house-account FK | Migration `20260626000000_house_account` seeds `__house__` (idempotent) + a Postgres settle-with-rake regression test. |
| 🟡 **M1** transfer cap | `DAILY_TRANSFER_CAP_CENTS` defaults to $1,000/day (was 0=unlimited). |
| 🟡 **M2** clubwar escrow | Buy-in escrow + war-row write now atomic via the `UnitOfWork` (+ test). |
| 🟡 **M3** stale docs | README/DEPLOYMENT reconciled with the real deploy; "files are authoritative" banner. |
| 🟡 **M4** full-ledger scan | Bounded `stakedVolumeCents` DB aggregate on the VIP/profile hot paths. |
| 🟡 **M6** join-code collision | `genUniqueJoinCode` rejects in-use codes (+ 500-room distinctness test). |
| 🔵 **L1** wallet-tx clamp · **L4** JSON zod-on-read · **L5** atomic stats · **L6** clubwar status CHECK · **L7/L8** overlay a11y · **L9** font trim+preload · **L10** RUNBOOK row | all shipped. |
| ⚪ **I1** swallow visibility | The 3 audit-relevant gateway swallows now `inc` a `murlan_audit_write_failures_total` counter + log. |
| ⚪ **I4** focus trap · **I5** TopBar emoji aria | shipped. |
| 🟡 **M5 (partial)** gateway god-object | **3 of the cleanly-separable collaborators extracted** (HandshakeThrottle, SpectatorRegistry, RematchCoordinator) — each behavior-preserving with a unit test, ~7 mutable Maps lifted out. |

### ⚪ Verified already-correct (no change needed)
- **I2** — a strict CSP **is already set** for the client origin at `packages/client/deploy/nginx.conf` (the API/helmet omitting CSP is correct — it serves JSON).
- **I3** — tournament/clubwar bracket/roster JSON is fine at the current capacities {2,4,8}; normalize only if larger tournaments are added.

### ⏸️ Deferred — with engineering rationale (NOT skipped)
- **M5 deep slices** (`BotDriver`, `ProvablyFair`, `TournamentMatchBridge`) — unlike the 3 extracted, these own **logic** woven into the live move/settlement path (`driveBot` plays moves + broadcasts; provably-fair reveals on settle; the tournament bridge advances the bracket on settle). Extracting them is the dedicated, integration-test-gated ARCH-1 effort where a subtle error (a leaked timer firing into a settled match, a seed not cleared between matches corrupting fairness, a double-advance) has real money/trust cost. Left for a focused pass, not rushed.
- **L2** (DB-backed auto-payout budget) and **L3** (Redis-backed deposit serializer/watch) — these only change behavior under **multi-instance** scaling; the deploy is single-host, so they add **no current benefit**, are **money-path risk**, and **can't be verified offline** (no Redis/multi-instance rig). Note: the scoper's suggestion to *delete* the in-process deposit serializer as "redundant with the advisory lock" was checked and is **incorrect** — the advisory lock exists only on the Postgres path, so the serializer is the cap guard for the in-memory path and must stay. Revisit all of L2/L3 only when actually scaling horizontally.
- **I6** — CI builds+scans but doesn't push the image; acceptable for single-operator (prod rebuilds from source via `redeploy.sh`).

### 🔧 Owner action — needs a connected Docker host / network (cannot be done safely offline)
- **L11** (pin Docker base + monitoring images to `@sha256`) — digests must be resolved with `bash deploy/pin-images.sh` on a Docker host; guessing narrower tags offline risks a `manifest not found` CI/build break.
- **L12** (pin the Trivy CI action off `@master`) — needs the real release tag/SHA looked up online; pinning a guessed tag risks breaking CI.

---
*Generated 2026-06-26 by a 6-agent forensic pass (5 domain auditors + adversarial verification, Opus high-effort) over commit `c31efbd`. Read-only at audit time; §8 records the subsequent remediation (verified + committed).*
