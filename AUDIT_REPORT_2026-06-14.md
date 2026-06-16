# 🔬 Crypto-Murlan — Forensic Audit Report

**Date:** 2026-06-14 · **Scope:** full repository (engine/shared/server/client + infra) ·
**Method:** Phase-0 parallel codebase mapping (8 agents) + Phases 1–5 deep audit across 16 dimensions,
every finding **adversarially verified against current code** (136 agents). Findings already fixed by
recent commits were dropped (23 of 127).

> **Verdict in one line:** the *engineering* is genuinely strong — the money/auth core is sound, 404 tests
> pass, 0 npm vulnerabilities, and there are **no Critical code-level bugs**. The blockers to *worldwide
> real-money distribution* are **legal/compliance** and a handful of **live-host config verifications**,
> not code rot. **Distribution readiness: NO-GO** until those close (consistent with `LAUNCH_READINESS.md`).

---

## 1. Executive Summary

Crypto-Murlan is a well-architected real-money card-game platform. The four-package monorepo keeps the
rules engine pure, money flows are protected by a double-entry ledger with idempotent credits, atomic
`UnitOfWork` transactions, and crash-recovery; auth uses Argon2id + pinned-HS256 JWTs with refresh-token
rotation and reuse detection. The recent security sprint **closed the previously-confirmed deposit
claim-jacking bug** (per-user TRON HD addresses), added DB integrity constraints, withdrawal atomicity,
and prod fail-closed secret enforcement. The adversarial verification pass **found zero Critical code
defects** and confirmed the most dangerous prior findings are fixed.

What remains is of two kinds. First, **compliance & legal**: there is still no real KYC/AML provider (KYC
is a manual admin enum flip), no transaction-monitoring service, and no GDPR data-export/deletion path or
privacy policy — these block lawful real-money operation in most jurisdictions and *are* the headline
blockers for "worldwide distribution." Second, a set of **High-severity hardening gaps**: `ALLOW_STUB_PROVIDERS`
isn't fail-closed in production, HTTP handlers leak stack traces, login rate-limits are too permissive,
external API calls (TronGrid/Binance) lack retry/circuit-breakers, tournament payouts are single-admin and
not fully atomic, and accessibility has real gaps. None are catastrophic; all are fixable in days.

Finally, several **Critical-if-true items can only be verified on the live VPS** (not in the repo): is
`TRON_DEPOSIT_XPUB` actually set in prod (or does it silently fall back to a claim-jackable shared
address?), does the live `.env` point at the bundled Postgres rather than the committed dev Supabase
creds, were the secrets that leaked into chat rotated, and is the offsite backup actually on cron. These
should be checked **today**.

**Headline numbers:** 104 verified findings — **0 Critical (code)** · 22 High · 43 Medium · 29 Low · 10
Info. Plus **4 Critical compliance/legal blockers** (verified-absent) and **~4 host-config items to
verify**. 94 distinct strengths recorded. ~31.7k LOC, 404 passing tests, 0 dependency CVEs.

---

## 2. Health Scorecard

| Dimension | Score | One-line justification |
|---|---|---|
| Architecture | **7.0/10** | Clean package boundaries + DI; dragged down by the 1844-line `gateway.ts` god-object. |
| Code Quality | **7.5/10** | Zero `any`-abuse, strong discriminated unions; some bot-logic duplication + complexity hotspots. |
| Security (code) | **7.0/10** | Excellent fundamentals (Argon2id, JWT rotation, idempotency, RBAC, Zod everywhere); real gaps (stub-providers, CORS, stack-trace leaks, login rate-limit). |
| Database | **7.5/10** | Hot paths indexed, integrity constraints recently added; tournament atomicity gaps + a few missing FK/indexes. |
| UI/UX | **7.5/10** | Confirmations on money actions, code-splitting, good states; RG-limit confirmation gap + a `window.prompt`. |
| Accessibility | **6.0/10** | Focus traps, reduced-motion, some aria-live; contrast failures, incomplete SR game flow, menu keyboard gaps. |
| Performance | **8.0/10** | CSS-transform animations, memoized seats, lazy views; minor re-render + bundle items. |
| Tests | **8.0/10** | 404 pass; money/engine/auth thoroughly covered; recovery-path + client coverage thin. |
| DevOps | **6.5/10** | Pre-deploy backup, graceful drain, metrics, fail-closed; unpinned images, no client healthcheck, X-Forwarded-Proto, offsite backup unwired. |
| Docs | **6.0/10** | README/DEPLOYMENT present; no runbook, no API spec, logging setup undocumented. |
| **Compliance / Legal** | **3.0/10** | No real KYC/AML, no transaction monitoring, no GDPR/privacy; licensing is an operator prerequisite. |

**Overall engineering health: 72/100.**
**Worldwide real-money distribution readiness: 🔴 NO-GO** — gated by the compliance dimension and the
live-host verifications, *not* by code quality.

---

## 3. Top 10 Priorities

| # | Severity | Item | Why now | Effort |
|---|---|---|---|---|
| 1 | 🔴 Critical | **No KYC/AML provider + no transaction-monitoring** (manual enum flip only) | Lawful real-money operation is impossible in most markets without it; AML monitoring is mandatory per deposit/withdrawal. | L |
| 2 | 🔴 Critical | **No GDPR/CCPA path** — no data export (Art.15/20), no deletion/anonymization (Art.17), no privacy policy | Blocks any EU/UK/CA user; IPs are logged. | L |
| 3 | 🔴 Critical | **Gambling licence** is an operator prerequisite | Unlicensed real-money gambling is illegal in most jurisdictions; code fail-closes the flags but cannot grant a licence. | L (legal) |
| 4 | 🔴 Critical* | **Live-host verification** — is `TRON_DEPOSIT_XPUB` set (else fallback to a *claim-jackable shared address*), is live `.env` on bundled Postgres (not dev Supabase), were leaked secrets rotated, is offsite backup on cron | If any is wrong, the deposit fix is bypassed / data isn't durable / keys are compromised. *Severity depends on what the VPS check finds.* | S–M |
| 5 | 🟠 High | **`ALLOW_STUB_PROVIDERS` not fail-closed in prod** (`app.ts:480-482`) | If ever set in prod, mock webhook deposits can mint arbitrary balance. | M |
| 6 | 🟠 High | **Tournament payout: single-admin + not atomic** (`tournamentService.ts:180-186`; no dual-control/match-binding) | A rogue/compromised admin can name any winner and drain a pool; a mid-payout crash leaves the ledger unbalanced. | M |
| 7 | 🟠 High | **HTTP handlers leak stack traces** (`walletRoutes.ts:169,246,328` +5) + **CORS credentialed wildcard risk** (`app.ts:162,567`) | Information disclosure on a real-money app; web-security hardening. | S |
| 8 | 🟠 High | **Login brute-force: rate-limits too permissive** (`authRoutes.ts:93`, global `app.ts:163`) | Credential stuffing against weak passwords; add per-username limiting. | L |
| 9 | 🟠 High | **External APIs (TronGrid/Binance) have no retry/circuit-breaker** (`tronDeposit.ts:62`, `binanceDeposits.ts:56`, `binancePayout.ts:70`) | If Binance rate-limits, the failed-withdrawal reconciler goes blind → player money stuck in limbo. | M |
| 10 | 🟠 High | **Accessibility: incomplete SR game announcements + failing contrast** (`TableView.tsx:73-84`, `index.css:39-40`) | Game is unplayable for blind/low-vision users (ADA exposure); muted text fails WCAG AA (~3.2:1). | M/L |

\* Item 4 is Critical *if* the live host is misconfigured; verify first, then it either closes or becomes the #1 emergency.

---

## 4. Detailed Findings

### Phase 2b — Compliance & Legal (Critical, verified-absent)

These are confirmed **missing** in the codebase (Phase-0 + prior audits `LAUNCH_READINESS.md`, `AUDIT.md`):

- **🔴 KYC/AML:** `POST /api/admin/users/:id/kyc` is a manual `none|pending|verified` enum flip; no
  Sumsub/Onfido/Jumio integration, no document capture, no sanctions/PEP screening.
- **🔴 Transaction monitoring:** no service for structuring/velocity/round-trip detection on
  deposits/withdrawals (AML requirement).
- **🔴 GDPR/CCPA:** no `/api/account/export`, no deletion/anonymization route, no published privacy
  policy; client IPs are logged without a retention policy.
- **🔴 Licensing:** `config.ts` fail-closes the compliance flags in prod, but the flags **default OFF** —
  the site can boot in production with compliance disabled unless explicitly enabled. The licence itself
  is a business/legal action.

> **Recommendation:** treat these as a gated track. Do **not** scale real-money play to new jurisdictions
> until KYC/AML + GDPR are built and a licence is held. (This mirrors the existing NO-GO verdict.)

### Phase 1 — Code & Architecture

**🟠 ARCH-1 — `GameGateway` is a 1844-line god-object** · `gateway.ts:106-1844`
30 imports, 11 state Maps/Sets, ~68 methods spanning socket lifecycle, rooms, play, bots, ghost-fill,
provably-fair, timers, settlement, ranking, anti-cheat, push, admin-void, club chat. *Fix:* extract
`BotHandler`, `TimerHandler`, `FairnessHandler`, `SettlementHandler`, `RoomStateEmitter`,
`MatchmakingHandler`; gateway delegates rather than implements. *Effort: L.*

**🟠 ARCH-2 — `finalizedMatches` Set can grow unbounded** · `gateway.ts:142,976,1356-1362`
Never pruned on room destruction → slow memory growth → eventual OOM on a long-lived single host. *Fix:*
delete the matchId when the room closes, or bound the Set (LRU, keep last ~10k). *Effort: M.*

**🟠 CORRECTNESS-1 — Forfeit-settlement race** · `gateway.ts:1454`
`anyWinnerConnected` is sampled synchronously before the `await` settlement; a winner disconnecting during
settlement can cause a match to settle that should have been voided. *Fix:* re-check connection state
immediately before settlement, or base the void decision on whether any winner is still *seated*. *Effort: M.*

**🟠 TEST-7 — No test for `reconcileFailedWithdrawals` idempotency under crash** · `paymentMonitor.ts:47-76`
The real-money recovery path has no test; a refactor could silently break at-most-once crediting. *Fix:*
add a test that fails a withdrawal on-chain, marks reversed, re-runs the sweep, asserts a single credit. *Effort: M.*

*Medium/Low (Code):* ARCH-3 optional-deps implicit contracts (`gateway.ts:54-77`); ARCH-4 monolithic
`app.ts` HTTP/realtime wiring; CORRECTNESS-5 concurrent `socket.join` in `seatRankedGroup` (`gateway.ts:708-713`);
CORRECTNESS-8 same `finalizedMatches` leak; **CODE-1 `groupPlays`/`straightPlays` duplicated** in
`botDecision.ts` and `botSearch.ts` (extract to `bot/combos.ts`); CODE-4 `decideBotMove` high complexity;
TEST-1 engine ace-straight edge cases; TEST-4 no tests for `presence.ts`/`redisAdapter.ts`; TEST-5/6
deposit-cap boundary race + rake-formula tests; CODE-2/3/5/6/7 naming/quoting/caching nits.

### Phase 2 — Security

**🟠 SEC-4 — `ALLOW_STUB_PROVIDERS` not fail-closed in prod** · `app.ts:480-482`
Warns but doesn't block; if set in prod, `/api/payments/webhook/:provider` accepts mock deposits with a
predictable signature → mint balance. *Fix:* in prod, **throw** if set; only allow in staging behind an
explicit marker value. *Effort: M.*

**🟠 MONEY-3 — Deposit-cap serialization breaks on multi-instance** · `walletService.ts:95-101`
The per-user cap relies on single-instance serialization; with Redis/multi-instance a player can exceed
their RG daily cap via concurrent deposits. *Fix:* SERIALIZABLE tx or Redis distributed lock per userId;
or document single-instance-only. *Effort: M.*

**🟠 MONEY-7 / WEB-2 — Login rate-limits too permissive** · `authRoutes.ts:93`, `app.ts:163`
~10 attempts / 15 min per IP (+ a 300/min global bucket) enables practical brute-force. *Fix:* tighten to
~3/15min **and** add per-username limiting (so proxy-IP rotation doesn't help). *Effort: L.*

**🟠 WEB-1 — Stack traces leak to clients** · `walletRoutes.ts:169,246,328`, `adminRoutes.ts:314`, `clubRoutes.ts:35`, `socialRoutes.ts:78,117`, `tournamentRoutes.ts:43`
Unhandled route errors return internals. *Fix:* a global `app.setErrorHandler` returning a generic 500
(localized) while logging the real error. *Effort: S.*

**🟠 WEB-3 — CORS credentials with a fixed/wildcard origin** · `app.ts:162,567`
If `clientOrigin` is ever a wildcard in prod, credentialed cross-origin requests are possible. *Fix:* in
`config.ts`, reject `*` and non-HTTPS origins in prod. *Effort: S.*

**🟠 WEB-7 — No retry/circuit-breaker on TronGrid/Binance** · `tronDeposit.ts:62`, `binanceDeposits.ts:56,87`, `binancePayout.ts:70`
External rate-limits/outages can blind the failed-withdrawal reconciler → money in limbo. *Fix:* `p-retry`
exponential backoff + circuit breaker with cached fallback. *Effort: M.*

*Medium/Low (Security):* SEC-1/SEC-5 webhook-secret dev fallback (`config.ts:169`); **SEC-3 real DB creds in
committed `.env`** (`.env:23,25` — rotate + scrub, see host-verify); AUTHZ-6 admin-demote only blocks
self-demote (`adminRoutes.ts:162-176`); INJ-2/INJ-4 missing length bounds on admin reason / withdrawal
reject reason; INJ-3 support/admin notes unsanitized at storage; MONEY-5 global (not per-op) rate-limit on
deposit/withdraw; **MONEY-8 withdrawal destination not re-validated at approval** (`walletRoutes.ts:128-132`);
MONEY-6 in-memory-only debit rollback gap; WEB-5 vague socket auth errors; WEB-6 webhook IP allowlist
depends on correct trust-proxy; SEC-7 metrics open if `METRICS_TOKEN` unset; SEC-8 no key-rotation policy;
AUTHZ-2 replay endpoint has no IDOR check (replays are public — confirm intended); INJ-1 hardcoded
sequence name in `$queryRawUnsafe` (safe, flagged for review).

### Phase 3 — Database

**🟠 SCH-2 — Tournament prize payout + rake not atomic (Prisma)** · `tournamentService.ts:180-186`
A crash between prize credit and rake record breaks the `sum(ledger per match)==0` invariant. *Fix:* wrap
both in one `UnitOfWork.transaction()` like `MoneyService.settle()`. *Effort: M.*

*Medium/Low (DB):* SCH-3 tournament register escrow+record not atomic (in-memory compensating only);
SCH-1/IDX-6 missing FK **and** index on `Withdrawal.resolvedByAdminId` (`schema.prisma:480`); SCH-4 money
columns lack DB-level CHECK on some tables (`schema.prisma:244,266-268,471`); SCH-5 `SupportTicket.matchId`
soft FK; SCH-7 `DepositIntent` not linked to User; SCH-8 `setStatusIfPending` compare-and-set can race
multi-instance without row lock; IDX-1 XP-leaderboard composite index; IDX-2 `User.createdAt` for admin
listing; IDX-3 `SuspicionFlag.createdAt`; IDX-4 `ChatReport` moderation indexes.

### Phase 4 — UI / UX / Accessibility / Performance

**🟠 A11Y-4 — Incomplete screen-reader game flow** · `TableView.tsx:73-84` (GameAnnouncer)
SR users don't hear opponents' plays, hand counts, or turn order → game unplayable for blind users (ADA).
*Fix:* expand `GameAnnouncer` to announce each action, counts, and pile/round changes via store
subscriptions. *Effort: L.*

**🟠 A11Y-5 — Muted text fails WCAG AA contrast** · `index.css:39-40`
`--muted` ≈ 3.2:1 on the dark bg. *Fix:* lighten to ~4.8:1 (e.g. `#b8b0c8`). *Effort: M.*

**🟠 A11Y-2 — `role="menu"` has no arrow-key support** · `TopBar.tsx:138-169` *(Fix: WAI-ARIA menu keyboard pattern; Effort M.)*

**🟠 UX-1 / UX-5 — RG-limit removal without confirmation + silent save failure** · `WalletView.tsx:322,334,342`
Responsible-gaming limits are safety controls; removal has no `useConfirm` and the input clears before save
completes; save errors are swallowed. *Fix:* confirm before removal, clear input only on success, surface
errors as a toast. *Effort: S–M.*

*Medium/Low (Frontend):* A11Y-1 placeholder-only inputs lack labels (Admin/Clubs/Support/Wallet);
A11Y-3 empty card `alt`; A11Y-7 no visible `h1`; A11Y-8 `RealityCheckModal` button-type/focus-trap;
UX-2 `window.prompt` for club-chat report; UX-3/UX-4 admin KYC/unmute without confirm; UX-6 900ms
double-submit guard too long; UX-7/UX-8 withdraw-error not cleared + missing RG skeleton; **PERF-2/3/4**
memoize `CardView`/`PlayLog` + reduce 250ms timer re-render cascade; PERF-1 socket fixed-500ms infinite
reconnect (add backoff); PERF-7 main bundle 328KB.

### Phase 5 — DevOps / Config / Docs

**🟠 NGINX-1 — Proxy drops `X-Forwarded-Proto`** · `deploy/nginx.conf:26-40`
Server runs plain HTTP behind the proxy; without this header secure cookies may be mis-set. *Fix:* add
`proxy_set_header X-Forwarded-Proto $scheme;` to `/api` and `/socket.io` blocks. *Effort: S.*

**🟠 DEPLOY-2 — No `stop_grace_period`** · `docker-compose.deploy.yml:31-37`
10s default risks truncated DB dumps / in-flight matches on reboot. *Fix:* `stop_grace_period: 60s`. *Effort: S.*

**🟠 OBS-2/4/6 — Observability docs/alerting gaps** · `app.ts:126-132`, `notifier.ts:38-50`, `metrics.ts:37-45`
No documented log-shipping; Telegram alerts are fire-and-forget (a failed large-withdrawal alert vanishes);
`murlan_settlement_failures_total` has no documented alert rule. *Fix:* document pino log sink; add an
alert retry/queue; document a Prometheus alert on settlement failures. *Effort: M.*

*Medium/Low (DevOps):* DOCKER-1 unpinned base images (pin to digest); DOCKER-2 client container has no
`HEALTHCHECK`; DEPLOY-1 pre-deploy backup not integrity-verified; OBS-3 no runbook; OBS-5 no API/OpenAPI
spec; OBS-7 treasury-alert throttling can mask repeated under-funding; OBS-8/OBS-9 client console flood +
no readiness metric.

---

## 5. Quick Wins (each < ~1 hour, high value)

1. **Global `setErrorHandler`** to stop stack-trace leaks (WEB-1).
2. **Reject wildcard/non-HTTPS CORS origin in prod** in `config.ts` (WEB-3).
3. **Add `X-Forwarded-Proto`** to nginx (NGINX-1) → secure cookies work.
4. **Pin Docker base images to digests** (DOCKER-1) + **add client `HEALTHCHECK`** (DOCKER-2).
5. **`stop_grace_period: 60s`** in deploy compose (DEPLOY-2).
6. **Surface RG-limit save errors + confirm removal** (UX-5/UX-1); **confirm admin KYC/unmute** (UX-3/UX-4).
7. **Length-bound admin reason + withdrawal reject reason** (INJ-2/INJ-4).
8. **Add FK + index on `Withdrawal.resolvedByAdminId`** (SCH-1/IDX-6) and the small leaderboard/admin indexes (IDX-1/IDX-2).
9. **Memoize `CardView`/`PlayLog`** + add card `alt` text + visible `h1` (PERF-3/4, A11Y-3/7).
10. **Bound `finalizedMatches`** to stop the slow memory leak (ARCH-2/CORRECTNESS-8).

---

## 6. Remediation Roadmap

**🚨 Now (this week)**
- **Verify the live host** (the most urgent, lowest-effort): `docker compose exec server printenv` →
  confirm `TRON_DEPOSIT_XPUB` is set (else deposits fall back to a claim-jackable shared address),
  `DATABASE_URL` points at bundled Postgres (not dev Supabase), `NODE_ENV=production`; **rotate** any
  secret that was pasted into chat; confirm `backup-offsite.sh` is on cron.
- **Fail-closed `ALLOW_STUB_PROVIDERS`** in prod (SEC-4).
- **Global error handler** (WEB-1) + **CORS prod guard** (WEB-3) + **X-Forwarded-Proto** (NGINX-1).
- **Tighten login rate-limit + per-username** (MONEY-7/WEB-2).
- **Make tournament payout atomic** (SCH-2) and decide on **dual-control / match-result binding** for tournament winners.

**🛠️ Next (this sprint)**
- External-API **retry + circuit-breaker** (WEB-7); withdrawal **destination re-validation at approval** (MONEY-8).
- **Accessibility:** SR game announcements (A11Y-4), contrast (A11Y-5), labels (A11Y-1), menu keyboard (A11Y-2).
- **DB:** missing FK/indexes, money CHECK constraints, multi-instance withdrawal race (SCH-1/4/8, IDX-*).
- **Perf:** memoization + socket backoff (PERF-1/2/3/4); **bound `finalizedMatches`** (ARCH-2).
- **Tests:** `paymentMonitor` recovery (TEST-7), `presence`/`redisAdapter` (TEST-4), deposit-cap boundary race (TEST-5).
- **Docker** image pinning + client healthcheck + `stop_grace_period`; observability docs + alert rules (OBS-2/4/6).

**🌱 Later (backlog / gated)**
- **🔴 Compliance build (gated by the licensing decision):** integrate a KYC/AML provider, build a
  transaction-monitoring service, and ship GDPR export/deletion + a privacy policy. **This is the gate for
  scaling real-money to new jurisdictions** — large, partly legal/business, but it is the true blocker.
- **Gateway refactor** — extract handlers (ARCH-1); de-duplicate bot combo logic (CODE-1).
- **API docs/OpenAPI** (OBS-5), **runbook** (OBS-3), **log aggregation**, **client error tracking** depth.

---

## 7. What I Did NOT Cover (scope statement)

- **Live-host state is unverified** — this was a read-only repo audit. The four Item-4 checks
  (`TRON_DEPOSIT_XPUB`, live `DATABASE_URL`, secret rotation, backup cron) require shell access to the VPS
  (`149.33.29.224`) and are flagged as **needs-verification**, not confirmed.
- **No DB was queried** — no `EXPLAIN`/runtime query analysis; index/N+1 findings are from reading
  `schema.prisma` + `prismaRepositories.ts`, not measured plans.
- **`npm audit` is prod-only** (`--omit=dev`) and reported **0 vulnerabilities**; dev-dependency CVEs and
  deep transitive license review were not exhaustively assessed.
- **No dynamic/runtime testing** — no live pen-test, no fuzzing, no load test, no real Lighthouse run;
  performance/a11y findings are static-analysis + heuristic.
- **Legal sufficiency is out of scope** — I can identify *missing* compliance machinery but cannot advise
  on which licences/policies satisfy a given jurisdiction; consult a gambling-compliance lawyer.
- **Sampling note:** the money, auth, gateway, engine, DB, and client view layers were reviewed in depth;
  tournaments, clubs, ranked, and anti-cheat were reviewed at the flow level (mapped + spot-checked), not
  line-by-line.

A deeper pass would add: a live-host config + secrets audit, DB `EXPLAIN`-based query profiling, a runtime
pen-test of the deposit/withdraw/admin paths, and a real Lighthouse/axe-core accessibility run.

---

### Appendix — Notable Strengths (keep these)

Engine/shared are genuinely pure (no IO leakage); **idempotent deposits via `providerRef` UNIQUE**;
**atomic settlement via `UnitOfWork`** with a per-match `sum(ledger)==0` invariant; **crash recovery**
refunds orphaned escrows at boot + every 5 min; **claim-finalize Set** prevents double-settlement on
normal-vs-forfeit races; **Argon2id + pinned-HS256 JWT + refresh rotation/reuse-detection**; **per-user
TRON HD deposit addresses** (claim-jacking closed); **bot-seating guard triple-checked to `stakeCents===0`**
(no bots in money games); **Zod validation at every HTTP + socket boundary**, no mass-assignment, no
`child_process`/`eval`; **immutable audit log** (Restrict FK); **provably-fair shuffle** (commit-reveal,
HMAC-RNG, tested); **404 passing tests** with strong money/engine coverage; **code-split client** with
`lazyWithRetry`, memoized seats, reduced-motion support; **pino with header redaction** + **money-safety
Prometheus counters**. This is a strong foundation — the remaining work is hardening and compliance, not a rewrite.
