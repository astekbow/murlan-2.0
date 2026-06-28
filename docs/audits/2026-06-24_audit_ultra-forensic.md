# 🔬 Murlan — Ultra Forensic Audit

> **Date:** 2026-06-24 · **Method:** evidence-based, read-only. Five parallel phase audits (code, security, DB, UI/UX, devops), with every 🔴/🟠 finding re-verified against source by the lead before inclusion. **No mutating commands were run.** Two sub-agent claims were checked and **rejected as inaccurate** (see §7).
> Supersedes the 2026-06-02 audit (67/100); the prior "Now" tier was remediated, reflected in today's higher score.
> **Stack:** npm-workspaces monorepo · Node ≥22 · TS 5.7 · server: Fastify 5 + Socket.IO 4.8 + Prisma 5/Postgres · client: React 18 + Vite 6 + Tailwind 3 + Zustand 5 · single-host Docker. Real-money (USDT-TRC20 deposits, Binance payouts). ~31.6k LOC, 100 test files, 23 Prisma models, 28 migrations.

---

## 1. Executive Summary

This is a **genuinely well-engineered, security-conscious real-money codebase** — well above the norm for a solo-operator project. The money core (wallet, ledger, settlement, withdrawals, escrow) is the strongest part: integer-cents throughout (no floats touch money), exactly-once credits via deterministic `providerRef` UNIQUE keys, atomic compare-and-set balance guards backed by a DB `CHECK (balanceCents >= 0)`, real `$transaction`-backed atomicity, and a claim-first withdrawal flow with a duplicate/ambiguous taxonomy that is exactly how you avoid double-paying crypto. The two prior red-team passes' fixes **hold up under fresh verification** — JWT revocation, refresh rotation, deposit idempotency, CORS/helmet, and Telegram authz are real, not cosmetic.

**No money-minting, double-payout, spoofable-identity, or injection holes were found.** The freshly auto-merged clan-tournaments code did not corrupt the money logic. The real risks are **operational resilience and polish, not money correctness**: a Redis blip can crash the whole host (no error listener / no global crash handler), a class of Prisma writes silently swallow failures (a failed password-reset or role-demotion is reported as *success*), offsite backups aren't wired (single disk loss = ledger + backups gone), and several frontend money-surfaces show "empty" when a load actually *failed*. None are launch-blocking individually, but #1–#4 below should be fixed before relying on the system at volume.

**Headline numbers:** 0 confirmed Critical · 4 High · ~14 Medium · ~16 Low/Info. Dependency scan: 4 vulns, **all in dev-only `vite`/`vitest` tooling** (not shipped). Overall health: **80/100**.

---

## 2. Health Scorecard

| Dimension | Score | One-line justification |
|---|---|---|
| Architecture | **8/10** | Clean money core, UnitOfWork, pure engine, server-authoritative socket identity; minor route/service coupling. |
| Code Quality | **8/10** | Disciplined and commented; a few swallowed-error sites + one hand-rolled validation path on a money route. |
| Security | **9/10** | Two red-team passes verified to hold; no critical/high code-sec issues. Argon2 memory at floor; single-instance limits. |
| Database | **7.5/10** | Integer cents, idempotency UNIQUEs, real atomicity; tournament has no FKs, free-text status, unbounded `list()`. |
| UI / UX | **7/10** | Strong primitives; some money-views conflate loading/empty/error; verb/label inconsistencies. |
| Accessibility | **7/10** | Surprisingly strong (focus-trap, SR live-announcer, reduced-motion); contrast token mismatch, traps missing on game dialogs. |
| Performance | **8/10** | Memoized canvas, code-splitting w/ retry, CSS-driven timers, exponential socket backoff. |
| Tests | **7.5/10** | 100 files, real PG integration + conservation invariants; gaps in tournament rounding/8-player + client components. |
| DevOps | **7.5/10** | Fail-closed config, pre-deploy backup, non-root multi-stage Docker, real observability; unpinned digests, no image scan, offsite backup manual. |
| Docs | **7/10** | Extensive runbooks/audits; some stale (CI "no remote") + contradictory (KYC narrative). |
| **OVERALL** | **80 / 100** | Strong, hardened real-money build. Gaps are resilience + polish, not money-correctness. |

---

## 3. Top 10 Priorities

| # | Finding | Sev | Effort | Why now |
|---|---|---|---|---|
| 1 | Redis pub/sub clients have **no `error` listener** + **no global `unhandledRejection`/`uncaughtException` handler** | 🟠 High | S | A transient Redis drop re-throws as an uncaught exception → process exit → every live real-money match on the host dies. |
| 2 | Prisma `setRole`/`setPassword`/`setPermissions`/`setEmailVerified` **`.catch(() => undefined)`** | 🟠 High | S | A failed password-reset or admin role-demotion is reported as **success** while the old state persists — fail-open on security writes. |
| 3 | **Offsite backups not wired** into cron (db-backup writes to the same host disk as pgdata) | 🟠 High | S (ops) | One VPS/disk failure loses the real-money ledger *and* every backup at once. Script is ready, just not scheduled. |
| 4 | `redeploy.sh` auto-applies migrations on boot with **no destructive-op guard** | 🟡 Med-High | S | A bad-but-successful migration auto-runs on prod; recovery is a manual restore the operator must notice. |
| 5 | `Tournament` has **no foreign keys**; club delete doesn't guard live escrow tournaments | 🟡 Med-High | M | A club holding an in-flight money tournament can be deleted, leaving the pool reachable only by the stale-sweep timer. |
| 6 | Tournaments / Support / Shop **conflate loading vs error vs empty** | 🟡 Med-High | M | A failed load on a money surface renders as "nothing here" with no retry — false negative on real money. |
| 7 | Argon2id **memory cost at the 4 MiB floor** (OWASP ≈19 MiB) | 🟡 Med | S | Breach-conditional: a DB dump is far cheaper to brute-force than it should be. |
| 8 | **Contrast token mismatch**: Tailwind `muted`/`txt.lo` = `#9c96a6` (≈4.0:1) vs CSS `--muted` = `#b8b0c8` | 🟡 Med | S (1 line) | The AA fix was applied to the CSS var but not the Tailwind utility that most secondary text actually uses. |
| 9 | CI has **no image vuln scan**; `npm audit` is a hard gate with no escape; stale "no git remote" comment | 🟡 Med | S | A vulnerable base-OS image ships green; a future transitive high blocks all merges incl. hotfixes. |
| 10 | **Docker base images unpinned** (`:latest`/floating tags; `prom/*:latest`) | 🟡 Med | S | Non-reproducible, tamper-susceptible builds. `deploy/pin-images.sh` exists but was never run. |

> **Cross-cutting (do before ANY horizontal scaling):** login lockout, email cap, RG/loss caps, auto-payout caps, and the tournament/match locks are **in-process maps** — correct single-instance (the documented current deploy) but bypassable/racy across replicas. Move to Redis/DB atomics before adding a second instance.

---

## 4. Detailed Findings

### PHASE 1 — Code & Architecture

**🟠 H1. Redis adapter has no `error` listener; no global crash backstop.**
`packages/server/src/realtime/redisAdapter.ts:10-18` constructs `new Redis(url, …)` + `.duplicate()` with no `.on('error', …)`. ioredis is an EventEmitter — an `'error'` with no listener re-throws as an uncaught exception. Verified: **no** `process.on('uncaughtException'|'unhandledRejection')` anywhere in `packages/server/src` (only SIGINT/SIGTERM in `index.ts`). With `lazyConnect:false`, a Redis partition (or boot failure) terminates the process and every live match. *Fix:* add `.on('error', e => app.log.error(e))` to both clients before `createAdapter`; add a global `unhandledRejection`/`uncaughtException` logger as a backstop; surface Redis state to health checks instead of crashing.

**🟠 H2. Prisma user-mutation repo swallows all errors → silent fail-open on security state.**
`packages/server/src/db/prismaRepositories.ts:280-291`: `setEmailVerified`/`setPassword`/`setRole`/`setPermissions` each end in `.catch(() => undefined)`. `authService.resetPassword` then `return true` unconditionally and revokes sessions, so a failed write *looks* like a successful reset (old password still works); `setRole` re-reads and returns the stale user, so `POST /admin/.../role` reports success while a compromised admin is **not** demoted. The in-memory repo does **not** swallow — so this is a Prisma-only fail-open. *Fix:* remove the `.catch`, let it propagate (or assert `update` affected a row and throw on mismatch) so the route 500s and the operator knows.

**🟡 M1. A few async Socket.IO handlers are `void`-fired without try/catch.**
`packages/server/src/realtime/gateway.ts` — e.g. `onLeave` (~:545 `await this.forfeitMatch(...)`) and other `socket.on('x', () => void this.onX())` handlers (~:410, :789, :1514, :2269). Socket.IO doesn't await handler promises; a throw becomes an unhandled rejection (and the client ack hangs). `onPlay`/`onPass`/`onCreate` wrap correctly — these don't. Combined with H1's missing global handler, an unhandled rejection follows Node's default. *Fix:* wrap each async handler body in try/catch that always replies an ack error, mirroring `onCreate`.

**🟡 M2. `/tournaments/:id/report` uses hand-rolled `typeof` validation, not zod.**
`packages/server/src/http/tournamentRoutes.ts:143-146` casts `req.body as {…}` and checks `typeof === 'number'` — accepts `NaN`/`Infinity`/negative/float, inconsistent with the zod `createSchema` on the sibling route. Doesn't mint money (a bad index just misses → `no_match`), but it's a validation gap on an admin money route. *Fix:* `z.object({ round: z.number().int().min(0), index: z.number().int().min(0), winnerId: z.string().min(1) })`.

**🔵 L1.** `adjustBalance` returns a post-increment balance via a separate `findUnique` (`prismaRepositories.ts:129-135`) — the increment is atomic (funds always correct), only the *returned number* can be stale if standalone; benign because every credit/debit runs inside a UoW `$transaction`. **🔵 L2.** `fair:clientSeed` socket event ungated by state (`gateway.ts:346-352`) — bounded + can't ride into another's deal; fairness impact limited to the player's own match. **🔵 L3.** Handshake/cache maps pruned by size not TTL; `socketsOf` is O(all sockets) — scaling nit. **⚪ L4 (NEEDS VERIFICATION).** Gateway turn/countdown timers not `.unref()`'d and may not be torn down on shutdown — harmless data-wise.

**Strong patterns (keep):** exactly-once money via deterministic providerRefs + atomic primitives; claim-first withdrawal with definite/duplicate/ambiguous taxonomy; UnitOfWork binding wallet+matches+withdrawals+tournaments+audit to one transaction + crash recovery + periodic `reconcile()`; server-authoritative identity at the socket boundary (actor from `socket.data.userId`, never client payload).

---

### PHASE 2 — Security (OWASP-grade)

**Verdict: no critical/high. Prior red-team fixes verified to hold.**

**🟡 M3. Argon2id memory at the 4 MiB floor.** `packages/server/src/auth/password.ts:6-8` calls `hash(plain)` with no options → `@node-rs/argon2` defaults (Argon2id, t=3, p=1, **m=4 MiB**), far below OWASP's ~19 MiB. Variant + time cost are right; memory is not. *Fix:* `hash(plain, { algorithm: Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })` and fix the "OWASP-aligned" comment.

**🟡 M4. Global / per-destination 24h auto-payout caps race across users.** `walletRoutes.ts` serializes per-userId, but the *global* cap reads `withdrawals.autoPaidSince` (completed-only) — two different users can both read the same stale total before either completes, overshooting the hot-wallet-drain budget. Each send is still bounded by `AUTO_WITHDRAW_MAX_CENTS`. *Fix:* serialize the auto-pay classify+send behind a `pg_advisory_xact_lock` on a fixed key when a global/dest cap is set (the helper exists at `prismaRepositories.ts:1029`).

**🔵 L5.** Push-unsubscribe is an IDOR — `pushService.unsubscribe(endpoint)` keyed only on client-supplied endpoint, not `caller.userId` (`accountRoutes.ts:~139`). Auth-gated + opaque endpoints → low. *Fix:* scope `WHERE endpoint=? AND userId=?`. **🔵 L6.** No global `bodyLimit` (Fastify default 1 MB on every authed route). *Fix:* `bodyLimit: 64*1024` + per-route overrides. **🔵 L7.** `/clubs/joinByCode` limiter is IP-keyed not user-keyed (`clubRoutes.ts:83`). **🔵 L8 (config, owner-acknowledged).** `DAILY_TRANSFER_CAP_CENTS` defaults 0 = unlimited P2P (AML rail off by choice; enforcement code is wired). **🔵 L9 (verify at deploy).** API sets `contentSecurityPolicy:false` (correct for a JSON API) — **confirm the SPA host (nginx) sets CSP+HSTS** (it does — `nginx.conf:10-21`).

**Controls verified CORRECT (keep):** fail-closed prod config (rejects weak/placeholder/equal JWT+webhook secrets, refuses bare `ALLOW_STUB_PROVIDERS`/`TRUST_PROXY=true`/negative Telegram chat id, bounds `ACCESS_TTL`); HS256 pinned with iss/aud, `ver`/tokenVersion revocation re-checked on every REST + socket handshake, atomic refresh rotation with reuse-detection; CORS pinned to exact origin (wildcard throws at boot); enumeration-safe login/forgot (pre-lookup throttle + dummy-Argon2 timing defense); deposit credit idempotent via `providerRef @unique` + `tron:<txid>` shared across all credit paths; webhook secrets compared with `timingSafeEqual`; card RNG uses `crypto`, provably-fair commits the serverSeed hash **before** clientSeeds; avatar upload has a **magic-byte check** (rejects SVG/script as fake PNG) + 24 KB cap; all 3 raw-SQL sites are constant or parameterized.

---

### PHASE 3 — Database & Data Layer
*(Static only — no live DB, so index "scan-risk" is inferred from query shape, not measured; no `EXPLAIN`.)*

**🟡 M5. `Tournament` has no foreign keys; club deletion ignores live escrow tournaments.** `schema.prisma:555-580` + migrations add `clubId` as a plain `TEXT`+index, no FK; `winnerId`/`pendingWinnerId`/`reportedByAdminId`/JSON `playerIds` are all unconstrained. Deleting a club with an in-flight money tournament succeeds and leaves the pool reachable only via the global `sweepStale()` timer, not `listByClub()` / any club UI. (The escrow itself is *not* lost — `sweepStale` uses `listAll()`.) *Fix:* add `clubId → clubs.id ON DELETE SET NULL` (degrade to global, additive-safe) and/or guard `deleteClub` against non-finished tournaments. Owner decision — the model deliberately uses loose coupling.

**🟡 M6. Money-state machines stored as free-text `String`, not PG enums.** `Tournament.status` (`schema.prisma:560`) drives a money state machine yet is unconstrained `TEXT` (contrast `Match.status`/`WithdrawalStatus`/`TransactionStatus`, which *are* enums). A typo'd write would silently fall out of `sweepStale`'s `SWEEPABLE` set → stranded escrow. *Fix:* promote `Tournament.status` to a PG enum (additive `CREATE TYPE` + `ALTER … USING`).

**🟡 M7. Unbounded `list()` queries.** `prismaRepositories.ts:191` `User.list()` has no `take` (admin list loads the whole users table); `Ledger.all()` loads every transaction (acceptable only for the offline `reconcile()` job — keep it off request paths). *Fix:* paginate `User.list()` with the keyset cursor already used by `listByUser` (`:410`).

**🟡 M8 (NEEDS DB-LEVEL VERIFICATION). `__house__` rake rows vs the `transactions.userId` FK.** `transactions.userId` has an FK to `users.id` (`0001_init:144`, RESTRICT); rake is written with `userId='__house__'` (`walletService.ts:307`) and no `__house__` user is seeded in any migration/boot path I could locate. **However** — the opt-in Postgres integration test settles a match with 10% rake and asserts ledger conservation against real Postgres (`pgConcurrency.test.ts:48-62`) and is green in CI, which **empirically contradicts** an FK-violation production break. So this is *not* a confirmed Critical; the *mechanism* (a seed I couldn't find, or FK semantics) is unresolved in static review. *Action:* confirm at the DB level whether a `__house__` row exists / how the insert succeeds; if it relies on something fragile, seed `__house__` explicitly or make house rows `userId=NULL + isHouse`.

**🟡 M9. Composite-index ordering on tournaments.** `list()`/`listByClub` filter on `clubId` + order by `createdAt`, but the index is `@@index([clubId])` only (`schema.prisma:578`); `@@index([clubId, createdAt])` would serve both index-only. The existing `@@index([status, createdAt])` appears **unused** (no query filters on `status`) — candidate to drop. Low impact at current row counts.

**🔵 L10.** PII (`email`, `dateOfBirth`, `country`, `depositAddress`) stored plaintext — at-rest protection presumably volume-level (verify); `anonymize()` correctly nulls DOB/country on deletion. **🔵 L11.** Ledger/admin records correctly retained forever (AML); verify the `db-backup` compose service actually runs + restores. **🔵 L12.** Repo layer is row-scoped by `userId` correctly; recommend a route-layer pass to confirm every endpoint binds the *authed* userId (not a client-supplied one) into history/transfer calls.

**Strong patterns (keep):** integer cents everywhere (only `Float` is cosmetic `Season.decayFactor`); real `$transaction` UoW rebinding all repos; idempotency UNIQUE on `providerRef` + `createMany(skipDuplicates)`; atomic conditional overdraw guard backed by a DB `CHECK`; deliberate `onDelete` (RESTRICT on financial/audit, Cascade on social, SetNull on resolver); newest migrations are additive + live-safe (`ADD COLUMN IF NOT EXISTS`, `ALTER TYPE ADD VALUE IF NOT EXISTS`); no schema/migration drift detected.

---

### PHASE 4 — UI / UX & Accessibility
*(Static review only — contrast hand-estimated (APPROX), touch sizes read from CSS not measured.)*

**🟡 M10. Contrast token mismatch (AA).** `tailwind.config.js:23-24` maps `txt.lo`/`muted` to `#9c96a6` (≈4.0:1) — the comment claims "lightened for AA" but it's the *old* value — while `index.css:41` `--muted` is `#b8b0c8` (≈5.6:1). Most secondary text in TSX uses the `text-muted` utility = the failing value. *Fix (1 line):* set `txt.lo`/`muted` to `#b8b0c8` in `tailwind.config.js`.

**🟡 M11. Money surfaces conflate loading / empty / error.** `TournamentsView.tsx:28-34,76-77` (no loading state; error is a transient toast → failed load shows permanent "no tournaments"); `SupportView.tsx:33-38` (`catch{}` → "no tickets"); `ShopView.tsx:55-56` (load error falls to the "log in" state for a logged-in user). *Fix:* adopt the `status:'loading'|'ready'|'error'` pattern Leaderboard/Rewards already use (skeleton → inline error+retry → empty only when genuinely empty). Lobby open-rooms (`LobbyView.tsx:117-154`) has the same empty-on-load false negative.

**🟡 M12. Hand-rolled game dialogs have no focus trap.** `TableView.tsx` inter-hand standings (~:597), match-over (~:680), forfeit confirm (~:766), `LogPanel` (~:77) are `role="dialog" aria-modal` backdrops with only `autoFocus` — they don't use the existing `useFocusTrap` (which `Modal` does). Tab escapes to the table behind the most consequential (money) moments. *Fix:* render via `Modal` or attach `useFocusTrap` + Escape.

**🟡 M13. Primary game buttons lack a min touch-target.** `.ctrl-play`/`.ctrl-pass` (`index.css:924-931`) are sized `13.5cqw` with no `min-height/width`; the `@media (hover:none)` 44px floor doesn't cover them, and landscape topbar icons set `min:0`. On a short landscape phone they can drop below 44px (WCAG 2.5.8). *Fix:* `min-width:44px;min-height:44px` on the two controls; `max(5cqw,30px)` on topbar icons.

**🟡 M14. Create-club / create-tournament / reset-password are `<div>`+onClick, not `<form>`** (`ClubsView.tsx:110`, `TournamentsView.tsx:63`, `ResetPasswordView.tsx:39`) → Enter doesn't submit. *Fix:* wrap in `<form onSubmit>` + `type="submit"`.

**Other Medium/Low (abridged):** landscape canvas not inset for left/right notch (`index.css` `.tv-canvas`); WalletView profile "Save" lacks the double-submit guard its siblings have (`:318`); toggle groups (auth tabs, language/RG segmented, avatar picker) convey selection by color only — add `role="radio" aria-checked`; duplicate `<h1>` on the lobby (`LobbyView.tsx:87` + `PageHeader`); no `aria-current` on active nav; CreateRoomModal closes (loses input) on failure; `socket` is `transports:['websocket']` only (no polling fallback for restrictive proxies); `PlayLog` empty-state hardcoded Albanian (bypasses i18n); dev annotations leaked into shipping `en` strings (`i18n.ts:868-877`); rank medals lack SR text. No RTL support (fine for sq+en).

**Strong patterns (keep):** SR live-announcer for game events (`TableView.tsx:103`); hand cards are real keyboard toggle buttons (`role=button`, `aria-pressed`, Enter/Space, 16px touch-slop); near-universal double-submit guards on money; memoized `SeatBadge`/`CardView`/`Hand` + `useShallow` selector excluding the log so appends don't re-render the felt; code-splitting via `lazyWithRetry` + ErrorBoundary; `prefers-reduced-motion`, `:focus-visible` gold-on-gold ring, safe-area insets, exit-guard while staked; i18n complete by construction (466 keys, both languages TS-enforced).

---

### PHASE 5 — DevOps, Config & Docs

**🟠 H3. Offsite backups not wired.** `deploy/backup-offsite.sh` exists (fail-closed, rclone) but is in no cron/compose; `docker-compose.deploy.yml:66-85` db-backup writes to `./backups` on the **same host disk** as `pgdata`. A disk/VPS failure loses ledger + backups together. *Fix (ops):* add the documented cron; alert if no offsite sync in 48h.

**🟡 M15. `redeploy.sh` migrate-on-boot has no destructive-op guard.** `deploy/redeploy.sh:40-41` → server runs `prisma migrate deploy` on boot (`Dockerfile.server:48`). The pre-deploy dump + gzip-integrity + >1KB check is genuinely good and aborts on a bad backup, but migrations are forward-only and a destructive-but-successful migration auto-applies; recovery is a manual restore. *Fix:* grep the pending `migration.sql` for `DROP|TRUNCATE|ALTER…DROP` and require `--confirm`; add a CI job that restores the dump into a throwaway DB.

**🟡 M16. CI gaps.** `.github/workflows/ci.yml`: (a) header says "no git remote yet" — **false**, `origin` is `github.com/astekbow/murlan-2.0.git` (verified), so CI is live; (b) `npm audit --audit-level=high` is a hard gate with no escape → a future unfixable transitive high blocks all merges incl. hotfixes; (c) no image vuln scan (Trivy/Scout) and the generated SBOM is archived but never evaluated. *Fix:* add image scanning with a high+ gate; give the audit step a documented escape; correct the comment.

**🟡 M17. Docker base images unpinned** (`Dockerfile.server`/`client` use `node:22-alpine`/`nginx:1.27-alpine`; `docker-compose.deploy.yml` `prom/*:latest`). `deploy/pin-images.sh` exists but was never run. *Fix:* run it on a Docker host, commit the `@sha256:` digests.

**🔵 L13.** `.env.example` ↔ `config.ts` parity gaps (`HAND_PAUSE_MS`, `DEPOSIT_POLL_MS`, `TOURNAMENT_DUAL_CONTROL`, `REWARDS_ENABLED` read but undocumented; `.env.example` PORT=3000 vs config default 3100). **🔵 L14.** PORT contract spread across Dockerfile/compose/config/nginx — held together by the compose `PORT` env; document or assert it. **🔵 L15.** nginx has no long-cache headers for hashed Vite assets + no explicit `client_max_body_size`. **🔵 L16.** Caddyfile sets no headers of its own (relies on inner nginx). **🔵 L17 (docs).** KYC narrative contradicts across `RUNBOOK.md` ("removed by owner") vs `LAUNCH_READINESS.md` (Blocker 2) — reconcile.

**Strong patterns (keep):** fail-closed prod config with the two historical boot-crash foot-guns *defused* (METRICS_TOKEN auto-generates, blank TRUST_PROXY allowed); Postgres/Redis bound to `127.0.0.1`, only Caddy public; CI is a real go/no-go gate with a *real* Postgres integration test; redeploy backs up + verifies before migrating; Dockerfiles are multi-stage, non-root (`USER node`), healthchecked, `.dockerignore` excludes `.env`; observability = Prometheus + Alertmanager→Telegram with money-integrity alerts (SettlementFailure, LedgerMismatch).

---

## 5. Quick Wins (<1h each)
- **Contrast one-liner** — `tailwind.config.js` `muted`/`txt.lo` → `#b8b0c8` (M10).
- **Redis `.on('error')` + global `unhandledRejection`/`uncaughtException` logger** (H1).
- **Remove `.catch(() => undefined)`** on the four Prisma security writes (H2).
- **Argon2 `memoryCost: 19456`** (M3).
- **Scope push-unsubscribe** to `userId` (L5); **user-key the joinByCode limiter** (L7).
- **Real `<form>`** on create-club/tournament/reset-password (M14); **`aria-current`** on active nav; **`aria-hidden`** on decorative emoji; **route `PlayLog` empty-state through i18n**.
- **Run `deploy/pin-images.sh`** + commit digests (M17); **wire the offsite-backup cron** (H3).
- **Strip dev annotations** from `en` strings (`i18n.ts:868-877`).
- **Correct stale docs** (CI "no remote", KYC narrative).

## 6. Remediation Roadmap
- **🚨 Now (this week):** H1 (crash safety), H2 (auth-write fail-open), H3 (offsite backups), M15 (destructive-migration guard), M3 (Argon2). All small, high-leverage.
- **🛠️ Next (this sprint):** M5 (tournament FK / club-delete guard), M11 (money-surface loading/error states), M10 (contrast), M16 (CI image scan + audit escape), M17 (digest pins), M12/M13/M14 (focus traps, touch targets, forms), M8 (verify `__house__` FK at DB level), M6 (Tournament.status enum), M7 (paginate `User.list()`).
- **🌱 Later (backlog):** multi-instance readiness (Redis/DB-backed throttles, caps, and tournament/match locks) **before scaling past one instance**; client component test suite; tournament rounding/8-player tests; RTL groundwork; perf + doc nits; route-layer userId-binding pass.

## 7. What I did NOT cover (honest scope)
- **No live DB:** no `EXPLAIN`/index-usage/cardinality — index findings are inferred from query shape; the `__house__` FK mechanism (M8) is unresolved statically (empirical PG test contradicts a break, but I couldn't locate the seed).
- **No running app:** no Lighthouse/axe/real contrast tooling (contrast is hand-estimated, APPROX); no dynamic auth/IDOR/SSRF probing; touch-target/notch findings are CSS-inferred, not measured on a device.
- **Network-limited:** CVE-to-exploit mapping is best-effort; the 4 `npm audit` vulns are dev-only `vite`/`vitest`.
- **Two sub-agent claims rejected after verification:** (1) "🔴 live DB password committed in `.env`" — **false**: `.env` is **not git-tracked and never was** (`git ls-files`/`git log` empty; `.gitignore` excludes it). A real credential exists only in the *local untracked* file; rotating any chat-exposed key still applies, but it is not a repo finding. (2) "🔴 `__house__` FK break" — **disproven** by the green PG rake+conservation test (downgraded to M8 "verify").
- **Reviewed by code only (not exercised):** avatar upload, Telegram bot flows, the Binance/TronGrid integrations.
- A **route-layer pass** confirming every endpoint binds the authenticated `userId` (not a client value) into repo calls is recommended as a focused follow-up.
