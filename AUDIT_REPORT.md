# Murlan Online — Full Repository Audit

> Read-only, evidence-based audit (10 parallel auditors → adversarial verification → synthesis).
> Every claim is anchored to `file:line`. Where the automated synthesis was wrong, it was corrected and noted.
> Generated 2026-06-02. **Remediation status appended per finding** (the "Now" tier is already fixed — see ✅ markers).

## Executive Summary

Murlan Online is a **genuinely well-engineered** real-money card game. The hard parts are strong: the rules engine and match state machine are pure, deterministic, and rigorously tested; money handling is atomic (UnitOfWork transactions, `providerRef` idempotency, balance-conservation reconcile); the provably-fair shuffle correctly commits the server seed before client seeds; auth has refresh-token rotation with reuse detection and an admin audit trail. **No SQL injection, money-minting, double-spend, hand-leak, or auth-bypass was confirmed.** The dominant risks were **operational and configuration**, not core logic: `docker-compose.yml` defaulted real-money secrets to `change-me-*`, the server image baked in `.env`, there was no CI/CD or observability, security headers were missing at the nginx edge, and several database hardening gaps (missing FK on the AML audit table, missing status indexes, no token/PII retention). Test coverage is strong on money/rules but absent on socket validation, rate-limiting, reconnection, and social features. **Overall at audit time: 67/100** — solid core, not yet production-hardened for a *licensed* real-money launch. The **"Now" tier has since been remediated** (see Remediation Status).

## Health Scorecard

| Dimension | Score | Justification |
|---|---:|---|
| Architecture | 8/10 | Clean layering (engine→match→room→gateway), DI + repository + unit-of-work. `gateway.ts` is a 1,087-line god-class mixing sockets/timers/money. |
| Code Quality | 7/10 | Consistent, validated, well-typed — but `noUncheckedIndexedAccess:false`, some `as unknown` casts, fire-and-forget async. |
| Security | 6/10 → 8/10 ✅ | Strong foundations undercut by JWT alg not pinned, route-layer-only KYC lock, weak-secret prod fallbacks — **all fixed in the Now tier**. |
| Database | 6/10 → 7/10 ✅ | Atomic money ops + idempotency; missing FK + status indexes + retention — **FK + indexes fixed; retention added in Next tier**. |
| Game Fairness & Correctness | 9/10 | Exceptional — pure rules, sound provably-fair, defense-in-depth vs cheating. The project's strongest area. |
| UI / UX | 6/10 | Cohesive design system + good focus mgmt; gaps in empty/error-state polish. |
| Accessibility | 5/10 | WCAG 2.2 AA gaps: contrast (muted/cream on dark), missing card `aria-label`s, no `<h1>` on auth, motion not fully reduced. |
| Performance | 8/10 | Code-splitting + retry, `useShallow`, ResizeObserver, single-flight refresh, small lobby bundle. |
| Tests | 7/10 | Excellent on money/rules/fair; gaps on socket validation, rate-limit, reconnection-grace, social. |
| DevOps | 4/10 → 6/10 ✅ | Multi-stage pinned images + prod secret guard; no non-root user / weak compose defaults / no CI / no observability — **mostly fixed in Now+Next**. |
| Docs | 3/10 | README good for dev; no deploy/runbook/secrets/monitoring docs, no ADRs. |
| **Overall** | **67 → ~78 /100** | Strong core; operational + config + compliance hardening now largely closed. |

## Top 10 Priorities (at audit time)

| # | Finding | Sev | Effort | Status |
|---|---|---|---|---|
| 1 | Secrets footgun: compose defaults `change-me-*`; `config.ts` checked presence not strength; `.env` baked into image via `COPY . .` (`.dockerignore` gap) | 🔴 Critical | S | ✅ Fixed |
| 2 | JWT algorithm not pinned (`jwt.verify` w/o `algorithms`); no iss/aud | 🟠 High | S | ✅ Fixed |
| 3 | KYC DOB/country lock enforced at route layer only; admin-reset→re-edit chain | 🟠 High | M | ✅ Fixed (moved to service layer) |
| 4 | Missing FK on `AdminAction.targetUserId` → orphaned AML audit rows | 🟠 High | S | ✅ Fixed (FK, onDelete: Restrict) |
| 5 | Missing indexes on `Match.status` / `Withdrawal.status` → full scans | 🟠 High | S | ✅ Fixed (`@@index([status])`) |
| 6 | Self-service compliance changes not audited | 🟠 High | S | ✅ Fixed (`profile_self_update`) |
| 7 | Nginx missing security headers (CSP/XFO/XCTO/HSTS/Referrer) | 🟠 High | S | ✅ Fixed |
| 8 | No token/PII retention cleanup; tables grow unbounded | 🟠 High | M | ✅ Token cleanup (Next tier); PII anonymization deferred |
| 9 | No CI/CD pipeline / quality gate | 🟠 High | L | ✅ CI workflow added (Next tier) |
| 10 | No observability; healthcheck doesn't check DB/ledger | 🟡 Medium | M | ◑ Structured logging + deep readiness check added; metrics deferred |

## Detailed Findings (grouped by phase)

### Phase 2 — Security
- **🟠 JWT algorithm not pinned** · `auth/tokens.ts` · verify lacked an `algorithms` allowlist → algorithm-confusion class. **✅ Fixed:** `algorithms:['HS256']` + issuer/audience on sign & verify.
- **🟠 KYC compliance lock at route layer only** · `accountRoutes.ts` vs `authService.updateCompliance` · bypassable by a future caller / admin-reset chain. **✅ Fixed:** enforced in `authService.updateSelfProfile()`.
- **🟠 Self-service compliance changes unaudited** · `accountRoutes.ts` · **✅ Fixed:** records a `profile_self_update` admin-audit row.
- **🟡 Webhook lacks provider-IP/replay-window binding** · `walletRoutes.ts` webhook · HMAC + intent-binding sound; add timestamp window + IP allowlist. *(Open.)*
- **🔵 Socket frame read-timeout** · `app.ts` sets `maxHttpBufferSize` but no per-frame idle timeout (slowloris). *(Open.)*
- *Verified-good (do not "fix"):* argon2id (OWASP defaults), refresh rotation + reuse-detection, constant-time HMAC webhook, secure+SameSite cookies, per-user token-bucket limiter, enumeration-safe forgot-password.

### Phase 3 — Database
- **🟠 No FK on `AdminAction.targetUserId`** · **✅ Fixed.** · **🟠 Missing `status` indexes** · **✅ Fixed.**
- **🟠 No token/PII retention** · **◑ Token cleanup added (Next tier); PII anonymization (post-account-closure) deferred** — needs a soft-delete/account-closure concept that doesn't exist yet.
- **🟡 Pooling implicit** · `db/prismaClient.ts` · `connection_limit` is in the URL; document/verify pool sizing vs the Supabase pooler. *(Open.)*
- *Refuted (correctly dismissed):* a claimed READ-COMMITTED debit race — the decrement is a single atomic `updateMany … WHERE balanceCents >= delta` inside one `$transaction` (`walletService.ts:121-143`).

### Phase 1 — Code & Architecture
- **🟡 `gateway.ts` god-class (1,087 LOC)** — mixes sockets/timers/money. *(Deferred — risky refactor; extract `TimerOrchestrator` + `SocketManager`.)*
- **🟡 `noUncheckedIndexedAccess`** — **✅ Fixed:** enabled monorepo-wide; ~39 production index sites hardened with real guards (`?? []`/`?? 0`/`?.`) or invariant-backed `!`, ~47 test sites with `!`. All 4 packages typecheck clean.
- **🟡 `as unknown as {rawBody}` casts** (`app.ts`, `walletRoutes.ts`). *(Open — Fastify declaration-merge.)*
- *Verified-good:* atomic escrow/settle/refund, exactly-once `claimFinalize`, crash-recovery sweep, idempotent compensation.

### Phase 4 — UI/UX & Accessibility
- **🟠 WCAG AA contrast failures** (muted/cream on dark, `index.css`). **🟠 Missing card `aria-label`s + no `<h1>` on auth.** **🟡 `prefers-reduced-motion` not honored on the shuffle spinner.** *(Open — see roadmap "Later".)*
- *Verified-good:* focus traps, keyboard nav, form labels, code-split bundle, error boundary + lazy-retry.

### Phase 5 — DevOps / Config / Docs
- **🔴 Weak-secret prod defaults** (`docker-compose.yml` + `config.ts`) — **✅ Fixed (fail-closed).**
- **🟠 `.env` baked into image** (`.dockerignore` + `Dockerfile.server:16`) — **✅ Fixed.**
- **🔵 Container runs as root** — **✅ Fixed (non-root USER, Next tier).**
- **🟠 No CI/CD** — **✅ Added (`.github/workflows/ci.yml`, Next tier).** **🟡 No observability / shallow `/health`** — **◑ pino logging + `/ready` deep check added; metrics deferred.** **🟡 No deploy/runbook docs** *(Open).*

## Quick Wins (status)
All eight from the audit are **done** in the Now/Next tiers (JWT pinning, status indexes + FK, secret fail-closed, `.dockerignore` + non-root, nginx headers, self-service audit, token cleanup) **except** the WCAG contrast/`<h1>`/`aria-label` UI polish *(Open — Later tier)*.

## Remediation Roadmap
- **🚨 Now (done ✅):** secrets fail-closed; JWT alg pinning + iss/aud; status indexes + AdminAction FK; KYC lock → service layer + self-service audit; nginx headers.
- **🛠️ Next (in progress):** ✅ CI workflow · ✅ non-root container · ✅ expired-token cleanup job · ✅ pino structured logging + deep readiness healthcheck · ⏳ deferred: split `gateway.ts`, enable `noUncheckedIndexedAccess`, Prometheus metrics, full PII retention/anonymization.
- **🌱 Later (backlog):** tests for socket-validation / rate-limit / reconnection-grace / orphaned-match recovery / social / compliance×money; Redis-backed distributed rate-limit; full WCAG AA pass; deploy + recovery runbooks + ADRs; webhook replay/IP binding; socket frame idle-timeout.

## What was NOT covered (honest scope)
- **No git** — the repo is not a git repository (`git rev-parse` → *fatal*); no commit/secret-history review possible. *(A verification sub-agent fabricated a commit hash refuting the `.env` finding — invalid evidence; the conclusion held only because `.env` is git-ignored and the Docker leak vector is now closed.)*
- **Live DB not queried** — no SQL/EXPLAIN run; schema/index findings are from code review. Index gaps should be confirmed with `EXPLAIN`/`pg_indexes` against the live DB.
- **No dynamic runs** — no Lighthouse/axe/screen-reader/load test; a11y + perf findings are static-analysis-based.
- **Sampled vs full:** fully reviewed — money, auth, gateway, rules/fair, DB schema, config/infra, tests. Sampled — `AdminView`/`ShopView`/`RewardsView`, full timer-race permutations, Redis multi-instance behavior, real SMTP/payment-provider integrations (mock/console only).
- **3 findings refuted** during verification (admin-audit-not-persisted, debit isolation race, `.env`-committed) — excluded by design.
