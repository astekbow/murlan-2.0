# 🔬 Crypto-Murlan — Ultra Forensic Audit
_Read-only review · 2026-07-01 · 61 findings (0 refuted in adversarial verification) · Overall 77/100_

## 1. Executive Summary

Crypto-Murlan is a live, real-money card-game PWA, and this audit finds it to be in genuinely good health: a disciplined, security-aware codebase that is well above the norm for a solo-operated money platform. Across twelve dimensions we kept **61 findings** after adversarial re-verification, with **0 refuted** — every issue below was confirmed against the actual code — for an **overall score of 77/100**. The strongest areas are the money engine itself (idempotent, atomic, claim-jack-proof deposits and exactly-once settlement), authentication/session handling, and the test suite, all of which score 8+/10. The most serious code-level risk is a single-direction fund-loss path on failed auto-payouts that no reconciler catches (a player could be silently left short), alongside several full-table ledger scans that run every 5 minutes and will degrade the live server as data grows. The lowest-scoring dimension by a wide margin is **Conversion / Trust / Business (5.5/10)**: the very first screen a visitor sees has no value proposition, no trust signals, and — most importantly for a gambling product — **no 18+ age gate or terms acceptance at signup**, which is both a conversion killer and a compliance/liability exposure. A handful of controls (anti-drain payout caps, in-flight guards) are also correct only because the app is pinned to a single server instance, and the production image scanner is currently set to report-only, so known CVEs can ship unblocked. None of these are actively losing money today, but the fund-loss path, the age gate, and the disabled CVE gate are the items that should be closed before scaling.

## 2. Health Scorecard

| Dimension | Score | Justification |
|---|---|---|
| Architecture & Code Quality | 7.5/10 | Clean enforced layering, DI, no dead code, clean typecheck; dragged down by a 2637-line gateway god class and a `row: any` Prisma boundary. |
| Correctness & Robustness | 8/10 | Exactly-once atomic settlement and crash recovery; one silent single-direction fund-loss path and an unbounded in-transaction ledger scan. |
| Security — Auth / AuthZ / Session | 8.5/10 | Revocation-aware JWTs, atomic refresh rotation, Argon2id, granular anti-escalation RBAC; no critical IDOR. Missing admin MFA. |
| Security — Web / Injection / Input | 8/10 | Zod at every boundary, safe Prisma, HMAC webhooks bound to intent; one blind SSRF via the web-push endpoint. |
| Financial Integrity (real money) | 8.5/10 | Integer cents, unique-providerRef idempotency, DB-enforced no-overdraw, exact settlement conservation; a few AML caps fail open on read error. |
| Database & Data Layer | 7.5/10 | Strong FK/cascade policy, atomic conditional writes, self-checking reconcile; full-table ledger scans and a default-5s tx timeout on connection_limit=1. |
| UI/UX & Accessibility | 8.5/10 | First-class a11y (skip-link, focus trap, reduced-motion, 44px touch floor); incomplete tab pattern and a few sub-44px controls. |
| Mobile / iOS / Android / PWA | 7.5/10 | Systematic safe-area insets, production-grade touch, conservative service worker; Android back-button double-fire and ~145 lines of dead rotation CSS. |
| Performance | 7/10 | Aggressive code-splitting and demand-scaled polling; two unbounded 5-min server scans and a lobby broadcast to every socket. |
| Tests | 8.5/10 | Money conservation, concurrency, and adversarial scenarios tested against real Postgres in CI; thin client-UI coverage. |
| DevOps / Config / Docs | 7.5/10 | Digest-pinned images, pre-deploy DB dumps, fail-closed secrets; Trivy scan is report-only and some DR knobs are undocumented. |
| Conversion / Trust / Business | 5.5/10 | Honest, dark-pattern-free money flows; but no landing value prop, no legal pages, and no 18+/terms gate at signup. |
| **Overall: 77/100** | | |

## 3. Top 10 Priorities

| # | Sev | Finding | Dimension | Effort | Why now |
|---|---|---|---|---|---|
| 1 | 🔴 | Auto-payout definite-failure swallows both the refund credit and the reversal, with no reconciler backstop → silent single-direction fund loss (`withdrawals.ts:340-345`) | Correctness | S | A player can be permanently left short with zero visibility, and no automated check will ever surface it. |
| 2 | 🔴 | No 18+ age gate or terms/responsible-gaming acceptance at signup (`AuthView.tsx`, `authRoutes.ts`) | Conversion / Trust | M | A live gambling product lets unverified minors register and deposit with no recorded consent — direct legal/compliance exposure. |
| 3 | 🔴 | reconcile()/matchLedgerSums() load the entire transactions ledger into JS every 5 minutes + N+1 per-user balance reads (`walletService.ts:438`, `prismaRepositories.ts:507`) | Performance / DB | M | Cost grows without bound on the forever-growing money table and will eventually stall the event loop or OOM the single replica. |
| 4 | 🔴 | Trivy image scan is report-only (`exit-code: '0'`) so known HIGH/CRITICAL CVEs ship to production unblocked (`ci.yml:121-149`) | DevOps | S | The primary CVE gate for the real-money server is disabled while the pipeline claims "only clean images" reach the registry. |
| 5 | 🔴 | Auth/landing screen has no value proposition, trust signals, or social proof (`AuthView.tsx:73-84`) | Conversion / Trust | M | The top of the funnel reads as unfinished/untrustworthy, directly suppressing signup and first-deposit conversion. |
| 6 | 🟠 | AML anti-drain caps (global/per-destination/transfer-in) fail OPEN on a read error, letting auto-payout exceed the hot-wallet budget (`walletRoutes.ts:309-315`) | Financial Integrity | S | A transient DB blip bypasses the exact controls meant to bound an unattended auto-drain; a one-line fail-closed flip fixes it. |
| 7 | 🟠 | Blind SSRF via the web-push subscription endpoint (no host/scheme allowlist) (`accountRoutes.ts:34-37`, `pushProvider.ts:58-64`) | Web Security | S | An authenticated user can coerce server-side POSTs to internal/metadata hosts; a small refine() closes the pivot primitive. |
| 8 | 🟠 | Money-critical anti-drain budgets, deposit serializer, and inFlight guard are single-instance-only in-process Maps/Sets (`walletRoutes.ts`, `walletService.ts`, `moneyService.ts`) | Financial Integrity | L | Correctness rests entirely on the replicas:1 ops pin; any scale-up or rolling deploy silently corrupts money invariants. |
| 9 | 🟠 | Android hardware-Back at the table both closes a modal AND triggers the leave-table prompt (`useModalBack.ts`, `useExitGuard.ts`) | Mobile | M | A normal action (open a profile, press Back) can bounce a player out of a live staked game on every Android device. |
| 10 | 🟠 | gateway.ts is a 2637-line god class driving money settlement, timers, bots and tournaments (`gateway.ts`) | Architecture | L | The highest-churn, hardest-to-reason-about file sits directly on the money path, raising regression odds on every gameplay change. |

The JSON is complete and verified. I'll write the findings directly.

## 4. Detailed Findings

### Financial Integrity (real money) — 8.5/10

**Strengths:** Integer-cents everywhere behind a single WalletService choke-point; immutable append-only ledger with a UNIQUE `providerRef` (`INSERT ... ON CONFLICT DO NOTHING`) making retried webhooks/settles at-most-once; atomic conditional decrement (`balanceCents >= -delta`) closing overdraw/double-spend; per-player watch-only HD addresses make deposits claim-jack-proof; ambiguity-aware (definite/duplicate/ambiguous) withdrawal model that never double-pays; exact settlement conservation (payouts + rake == pot) with a self-checking `reconcile()`.

**🟠 Global / per-destination / transfer-in AML caps fail OPEN on a read error (auto-payout can exceed the hot-wallet-drain budget)** · verified
- Location: `packages/server/src/http/walletRoutes.ts:309-315`
- Evidence: The anti-drain cap reads swallow errors to `0` — `withdrawals.autoPaidSince(dayAgo).catch(() => 0)`, `autoPaidSince(dayAgo, rec.destination).catch(() => 0)`, `wallet.transferredInSince(caller.userId, dayAgo).catch(() => 0)` — and `priorTodayCents` uses `.catch(() => [])` (line 295). `classifyWithdrawal` then treats `usedToday` as 0, making the withdrawal look UNDER every cap and eligible for the 'auto' tier. Contrast the transfer cap 40 lines up (lines 200-204), which was deliberately made fail-CLOSED: `catch { return reply.code(503) ... 'cap_check_failed' }`.
- Why it matters: When auto-payout is enabled (real provider + `autoWithdrawMaxCents>0`), a transient DB/query error during cap reads bypasses the global hot-wallet budget, per-destination cap, and P2P-received-funds-to-manual guard — the exact controls meant to bound an unattended auto-drain / chip-dump cash-out. Latent today because payouts are manual by default, but it is the failure mode these caps exist to prevent.
- Fix: Make the auto-pay cap reads fail-closed, mirroring the transfer cap. Wrap the `Promise.all` in try/catch and on error force tier `'manual'` (route the row to operator review) instead of defaulting the count to 0. Apply the same to the per-user `priorTodayCents` read (line 295).
- *walletRoutes.ts:309-315 swallows the global/dest cap and transfer-in reads to 0 via `.catch(() => 0)` (and line 295 uses `.catch(() => [])` for the per-user prior), and withdrawalPolicy.ts:45-62 treats those 0s as "under cap"/no-transfer-in, so a transient read error routes an auto-eligible payout to the 'auto' tier and bypasses the anti-drain caps — fail-open, in direct contrast to the deliberately fail-closed transfer-out cap at lines 200-204; medium is right since auto-payout is off by default today.*

**🟠 Anti-drain caps, deposit-cap serializer and settle/refund in-flight guard are single-instance-only — a second replica silently corrupts money invariants** · verified
- Location: `packages/server/src/http/walletRoutes.ts:112,128`; `packages/server/src/money/walletService.ts:115`; `packages/server/src/money/moneyService.ts:42,76-85`; DB advisory lock at `packages/server/src/db/prismaRepositories.ts:1205-1206`
- Evidence: Multiple money-critical guards are in-process Maps/Sets, not DB-backed. Withdrawal serialization: `const withdrawChain = new Map<string, Promise<unknown>>();` and `let globalWithdrawChain: Promise<unknown> = Promise.resolve();` ('Single-instance only ... multi-instance needs a DB lock'). Deposit-cap serializer: `private readonly depositChain = new Map<string, Promise<unknown>>();`. Settle/refund overlap guard: `private inFlight = new Set<string>();`. Only the deposit CAP itself is backed by `pg_advisory_xact_lock`; the global/dest auto-payout budget reads have NO cross-instance lock.
- Why it matters: The system is correct ONLY because it is pinned to `deploy.replicas:1`. If that ops constraint is violated (scale-up, rolling deploy briefly running two containers, a k8s migration), two instances can both read the same stale global/per-destination auto-payout total and each auto-pay past the shared hot-wallet budget, and overlap settle/refund across processes. Core idempotency + overdraw guards survive multi-instance; the AML/anti-drain BUDGETS do not.
- Fix: Either (a) enforce the single-replica invariant in code (a startup leader-election `pg_advisory_lock` on a fixed key the process must hold, refusing money routes otherwise), or (b) back the global/per-destination auto-payout budget with a DB-side windowed SUM computed inside the same tx that claims the withdrawal row, gated by an advisory lock keyed to 'global-payout'. Document the single-replica requirement in the deploy manifest.
- *Every cited mechanism is genuinely an in-process Map/Set (walletRoutes.ts:112,128; walletService.ts:115; moneyService.ts:42) with explicit "single-instance only" comments, only the deposit CAP is DB-backed via pg_advisory_xact_lock, and deployment is pinned to replicas:1 (docker-compose.deploy.yml:58) — so under a second replica the shared auto-payout budget reads and settle/refund inFlight guard lose atomicity exactly as described; verdict is adjusted only because the DB-lock file path is db/prismaRepositories.ts (the finding omitted the db/ directory), and the risk is correctly medium since these anti-drain budgets default OFF and core idempotency/overdraw guards survive multi-instance.*

**🟡 $transaction runs at the DB default isolation (READ COMMITTED) — correctness leans on advisory locks + conditional writes, not snapshot isolation** · verified
- Location: `packages/server/src/db/prismaRepositories.ts:1189-1210`
- Evidence: `PrismaUnitOfWork.transaction` wraps `this.db.$transaction((tx) => fn({...}))` with no isolation-level option, so it uses Postgres' default READ COMMITTED. The deposit-cap read is protected by taking `pg_advisory_xact_lock` FIRST (walletService.ts:141) so concurrent capped deposits for one user serialize. The global/per-destination auto-payout budget reads (`autoPaidSince`) run OUTSIDE any transaction/lock and rely solely on the in-process chain.
- Why it matters: For the paths that DO take the advisory lock or use conditional `updateMany`, READ COMMITTED is sufficient and correct. The residual risk is confined to the un-locked aggregate reads already captured above. Flagging separately so a future maintainer who removes/reorders the advisory lock understands the isolation level is doing none of the heavy lifting — the lock and the conditional writes are.
- Fix: No change strictly required today. If the deposit-cap advisory lock is ever removed or the cap read is moved before the lock, switch that specific transaction to `{ isolationLevel: 'Serializable' }` and add retry-on-40001, or keep the advisory-lock-first ordering and add a code comment/test asserting the lock is acquired before the deposits-today read.

**🟡 Deposit auto-credit poller is TTL-scoped to 'active depositors' — a transfer arriving after the 30-min watch window is never auto-credited (silent, but recoverable)** · inferred
- Location: `packages/server/src/money/depositPoller.ts:17,29-52`; `packages/server/src/money/tronDeposit.ts:11-12,104`
- Evidence: The poller only watches addresses of players who opened the deposit screen within `DEFAULT_WATCH_MS` (30 min): `markWatching` sets `until: this.now() + this.ttlMs` and `active()` drops expired entries. TronGrid queries are capped at `limit=200` ('the deposit must be claimed before 200 newer incoming transfers bury it'). A deposit that confirms after the 30-min TTL (slow chain, user walks away) is not in the watched set.
- Why it matters: Not a loss-of-funds bug — the money is on the user's own HD address, the unclaimed-deposit sweep alerts the operator, and the user can still submit the TxID manually (idempotent). But it is a UX/operational trap: a legitimately-deposited user may see no credit and no clear signal for up to the reconcile interval, generating support load and mistrust on a real-money product.
- Fix: Extend the watch TTL for an address as long as a deposit intent is outstanding, or add a lightweight periodic sweep over all assigned addresses with recent activity at a low cadence. At minimum, surface a clear 'deposit detected, crediting shortly / submit TxID if not credited in N minutes' state in the client.

**🔵 P2P wallet transfer has no KYC / hold / velocity controls beyond a friends check and an optional (default-off) daily cap — owner-acknowledged AML surface** · verified
- Location: `packages/server/src/http/walletRoutes.ts:165-218`
- Evidence: The route documents the gap: 'NOTE (owner-acknowledged): no KYC / daily cap / hold here by request — a known AML/fraud surface on a real-money app; revisit with compliance before scaling.' The only rails are friends-only, a real-money account/compliance gate on both parties, and a per-user 24h transfer-OUT cap that DEFAULTS to 0 = UNLIMITED (`const cap = deps.dailyTransferCapCents ?? 0; if (cap > 0) {...}`). Received-then-withdraw is routed to manual review.
- Why it matters: With the transfer cap left at its default (unlimited), a ring of friend-accounts can move balance freely with no velocity limit or hold, enabling chip-dumping and layering of deposited funds before cash-out. The mechanics are money-correct (atomic, no minting); the risk is compliance/AML.
- Fix: Before scaling / opening to real jurisdictions: set a non-zero default `dailyTransferCapCents`, add a short hold on received funds before they are withdrawable, and gate transfers behind the same KYC threshold used for withdrawals. Track this as a compliance blocker rather than a code bug.

### Security — Auth / AuthZ / Session — 8.5/10

**Strengths:** Revocation-aware auth end-to-end — every access token carries a `ver` claim checked against live `tokenVersion` at the REST guard, socket handshake, AND socket re-auth, plus a live-socket kick on ban/suspend/reset; refresh-token rotation with ATOMIC compare-and-revoke (`updateMany where revoked:false` → count===1) reuse-detection + family revocation; JWT verification pins `algorithms:['HS256']` and binds issuer+audience (defeats alg-confusion/alg:none); anti-escalation admin RBAC (a scoped admin can't mint/demote a full admin or grant scopes it lacks, owner protected); Argon2id at OWASP cost with a per-email escalating lockout and timing-oracle equalization.

**🔵 Any authenticated user can create a global buy-in tournament (no admin gate)** · verified
- Location: `packages/server/src/http/tournamentRoutes.ts:146-166`
- Evidence: `app.post('/api/tournaments', ...)` — the only guard is `requireAuth`. A `clubId` tournament requires club founder (lines 153-158), but a GLOBAL tournament (clubId absent) has NO ownership/admin check. `createSchema` allows `buyInCents` up to `1_000_000_00` ($1,000,000) and capacity 2/4/8. The money-moving report/confirm/cancel routes ARE admin-gated (`requirePermission 'void_matches'`), and registrants escrow their own buy-in.
- Why it matters: An ordinary player can spam arbitrary global tournaments (each an unmoderated real-money pool) into the public list, and set an eye-watering buy-in. No direct fund theft, but it is an unmoderated money-pool + list-pollution surface on a real-money app.
- Fix: Gate global (clubId-absent) tournament creation behind an admin permission (a new `manage_tournaments` scope or reuse `void_matches`), the same way report/cancel already are: `if (!clubId) { const c = await admin(req, reply); if (!c) return; }` before `tournaments.create(...)`. Keep the founder path for club tournaments.

**🔵 No MFA/2FA on the money-powered admin panel (single-factor password auth)** · verified
- Location: `packages/server/src/auth/authService.ts:287-322` (login); `packages/server/src/http/adminRoutes.ts` (all admin routes)
- Evidence: `login()` verifies only email+password (Argon2) and issues a full session; there is no second factor. The resulting admin/owner session can adjust balances (adminRoutes.ts:169), approve withdrawals (:470), ban users (:226), and manage admins (:256). No `mfa`/`totp`/`webauthn` code path exists anywhere. The Telegram admin bot adds a dual-control confirm for its money commands, but the web admin panel does not require a second factor to sign in.
- Why it matters: A single compromised admin/owner password (phish, reuse, malware) yields full control of the money rails. For a live real-money platform, password-only admin auth is below the expected bar; the login throttle and revocation are good but do not substitute for a second factor on privileged accounts.
- Fix: Add TOTP (or WebAuthn) as a required second factor for `role:admin` accounts (and the owner). Minimal: a `totpSecret` on the user, an enrollment flow, and a `login` branch that, when the resolved user is an admin, issues a short-lived 'mfa-pending' token exchanged only after a valid TOTP code. Enforce before any admin session is minted.

**⚪ Socket connection-rate guard keys on the proxy IP (handshake.address), not the real client IP** · verified
- Location: `packages/server/src/realtime/gateway.ts:286-287`
- Evidence: `const ip = socket.handshake.address || 'unknown'; if (!this.allowHandshake(`${userId}|${ip}`)) ...`. Socket.IO's `handshake.address` is the direct TCP peer, which in the single-nginx-hop topology is the proxy, not the client (unlike Fastify's `req.ip`, which honors the bounded trustProxy). So the IP component collapses to one value for all users.
- Why it matters: Low/none in practice: the guard's PRIMARY key component is `userId` (an authenticated, token-verified value), so the per-user reconnect-flood throttle still works; only the IP sub-key is degraded. There is no cross-user collapse.
- Fix: If per-IP socket throttling is desired, read the client IP from the forwarded header consistent with Fastify's trustProxy (parse `socket.handshake.headers['x-forwarded-for']` with the same hop-trust rules). Otherwise document that the socket guard is intentionally per-user.

**⚪ verifyRefresh does not enforce a numeric `ver` claim (relies on the downstream jti check)** · verified
- Location: `packages/server/src/auth/tokens.ts:92-103` vs `105-117`
- Evidence: The private `verify()` (used by verifyAccess) rejects a token whose `ver` is not a number (tokens.ts:113). `verifyRefresh()` does NOT apply that guard — it defaults `ver: typeof decoded.ver === 'number' ? decoded.ver : 0`. A legacy stateless refresh token (no jti, ver possibly absent) would parse with ver=0.
- Why it matters: Not exploitable as written: `authService.refresh()` independently rejects any token without a jti and requires `claims.ver === user.tokenVersion` against a live user. This is a defense-in-depth inconsistency, flagged so the two verify paths stay aligned if the jti check is ever refactored.
- Fix: Mirror the access-token guard in verifyRefresh: reject when `typeof decoded.ver !== 'number'` (and when `jti`/`family` are missing) rather than silently coercing to 0.

### Security — Web / Injection / Input — 8/10

**Strengths:** Zod at every trust boundary with bounded string/number limits; Prisma used safely (no string-built SQL — the only raw usages are a constant `nextval` and correctly parameterized tagged templates); exact-origin CORS with credentials, wildcard refused in prod; zero `dangerouslySetInnerHTML` in the SPA plus a strong nginx CSP; both webhooks verify HMAC/secret over the RAW body with constant-time compares and bind credits to a recorded intent (never body-controlled); SSRF on the money rails contained to fixed TronGrid/Binance hosts with a strict 64-hex TxID regex.

**🟡 Blind SSRF via Web-Push subscription endpoint (no host/scheme allowlist)** · verified
- Location: `packages/server/src/http/accountRoutes.ts:34-37,130`; `packages/server/src/push/pushProvider.ts:58-64`
- Evidence: Schema accepts ANY URL: `const pushSubSchema = z.object({ endpoint: z.string().url().max(2000), keys: ... })`. The value is stored verbatim (`push.subscribe(caller.userId, { endpoint: parsed.data.endpoint, ... })`) and later the reengagement job POSTs to it: `await webpush.sendNotification({ endpoint: sub.endpoint, ... }, ...)`. `z.string().url()` accepts `http://169.254.169.254/latest/meta-data/`, `http://localhost:6379/`, even `file:///etc/passwd` — there is NO allowlist to the real push hosts.
- Why it matters: An authenticated user can register an internal/metadata URL as their push 'endpoint'. When any server-side nudge fires (`notifyTurn`/`notifyFriendRequest`/`notifyMatchReady`), the server issues an outbound POST to that host from inside the deployment network — a blind SSRF probing/pivot primitive (internal Redis/Postgres/admin ports, cloud metadata). Only exploitable when a real web-push provider is configured (VAPID keys set).
- Fix: Allowlist the endpoint host at the schema boundary before persisting:
```
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /(^|\.)web\.push\.apple\.com$/];
endpoint: z.string().url().max(2000).refine(u => { try { const h = new URL(u); return h.protocol === 'https:' && PUSH_HOSTS.some(re => re.test(h.hostname)); } catch { return false; } }, 'unsupported push endpoint')
```
Reject non-https and any private/loopback/link-local host.
- *Verified in-repo: pushSubSchema uses z.string().url() with no scheme/host allowlist (accountRoutes.ts:35), the endpoint is persisted verbatim (accountRoutes.ts:130 → pushService.subscribe → repo.add) and later POSTed via webpush.sendNotification({endpoint: sub.endpoint,...}) driven by notifyTurn/notifyFriendRequest/notifyMatchReady (pushProvider.ts:60-62, pushService.ts:28-67); a grep of the push module found zero host/private-IP/allowlist checks, so an authenticated user can register an internal/metadata URL and coerce a blind outbound POST — real HTTP only when VAPID keys are set (app.ts:734-747), exactly as the finding's caveat states, so medium severity and the cited locations are accurate.*

**🔵 CSP disabled at the API origin (helmet contentSecurityPolicy:false)** · verified
- Location: `packages/server/src/app.ts:209-212`
- Evidence: `await app.register(helmet, { contentSecurityPolicy: false, hsts: ... })` — CSP is explicitly off on the Fastify server, with a comment that the SPA host owns CSP.
- Why it matters: The SPA is served by nginx (which DOES set a strong CSP), so the primary XSS defense exists. But the API origin serves a few HTML-ish/document responses (e.g. `/api/install/ios.mobileconfig`) with no CSP and no frame-ancestors, and any future HTML endpoint on the API host would ship unprotected. Defense-in-depth, not an active vuln.
- Fix: Set a locked-down CSP even for the API origin: `contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } }`. A JSON API needs almost nothing, so `default-src 'none'` is safe.

**⚪ Webhook source-IP allowlist depends on trustProxy being configured correctly** · inferred
- Location: `packages/server/src/http/walletRoutes.ts:455-462`; `packages/server/src/app.ts:185`
- Evidence: `if (webhookIps.length > 0 && !webhookIps.includes(req.ip)) { ... return reply.code(403) ... }`. `req.ip` is derived from Fastify `trustProxy: deps.config.trustProxy`. The comment notes it 'Requires Fastify trustProxy so req.ip is the real client behind the reverse proxy.'
- Why it matters: The IP allowlist is only defense-in-depth on top of the HMAC (the real auth). If TRUST_PROXY is misconfigured (too broad), a client could spoof X-Forwarded-For to satisfy the allowlist — but only bypassing the secondary control, since the HMAC + intent-binding still gate the credit. `config.ts` refuses `TRUST_PROXY=true` in prod, which mitigates this.
- Fix: No code change strictly required (HMAC is authoritative). Optionally document that `webhookIps` is meaningless unless trustProxy is pinned to the exact proxy hop, and consider dropping the IP allowlist to avoid a false sense of a second gate.

### Correctness & Robustness — 8/10

**Strengths:** Exactly-once finalize by construction (`claimFinalize` Set + synchronous `inFlight` claim before any await, no interleaving await in the `markFinished`→`settle` window); transactionally atomic and idempotent money movements with deterministic providerRefs; robust crash/lifecycle recovery (`recoverOrphanedMatches` at boot, on a 5-min sweep, and on SIGTERM drain, with idempotent refunds); a careful pure Match/SingleGame state machine (idempotent forfeit, gone seats excluded from winners, all-gone → void+refund guarding divide-by-zero); deliberate non-silent error isolation on fire-and-forget audit writes (counted + logged).

**🟠 Auto-payout DEFINITE-failure swallows both the refund credit and the reversal, with no reconciler backstop → silent single-direction fund loss** · verified
- Location: `packages/server/src/money/withdrawals.ts:340-345`
- Evidence:
```
// DEFINITE failure → idempotent refund + reverse out of completed (player made whole).
await this.wallet.credit(rec.userId, rec.amountCents, {
  type: 'admin_adjust', reason: 'rikthim: auto-pagesa dështoi', providerRef: `withdrawal_refund:${id}`,
}).catch(() => {});
await this.repo.markReversed(id).catch(() => {});
return { outcome: 'failed', error: r.error };
```
- Why it matters: On a definite provider failure the player was already debited and the row CLAIMED to 'completed'. If the compensating refund credit throws (transient DB blip) it is swallowed, yet `markReversed` still flips the row to 'rejected'. The player is left short with no credit. `reconcileFailedWithdrawals` only re-acts on rows still `status==='completed'` (paymentMonitor.ts:53), so a reversed-but-unrefunded row is skipped forever, and `wallet.reconcile()` won't flag it (the debit exists in both balance and ledger, so they agree). The loss is invisible. The manual sibling `payoutNow` (withdrawals.ts:298-301) does NOT swallow, so this asymmetry is almost certainly unintended.
- Fix: Do not swallow on the DEFINITE-failure path. Either (a) await refund + markReversed without `.catch`, leaving the row 'completed' so `reconcileFailedWithdrawals` retries; or (b) only `markReversed` AFTER the refund credit succeeds — if the credit throws, leave the row 'completed' so the reconciler re-credits idempotently (the providerRef makes it safe). Add a `settlementFailures.inc()` + error log if either step throws.
- *Verified end-to-end: withdrawals.ts:341-344 fires the refund credit and markReversed as two independent .catch(() => {}) statements, so a thrown credit is swallowed while markReversed still flips the CLAIMED-'completed' row to 'rejected'; the only backstop reconcileFailedWithdrawals acts solely on status==='completed' (paymentMonitor.ts:53) and reads Binance withdraw history which a DEFINITE 4xx failure (binancePayout.ts:179+) never enters, and wallet.reconcile() (walletService.ts:438-450) can't see it because the original debit stays in both balance and ledger (they agree) — a genuine, undetectable single-direction fund loss, matching the manual payoutNow sibling (lines 298-301) which does NOT swallow.*

**🟡 Deposit-cap check loads the depositor's ENTIRE ledger into memory inside the money transaction on every capped deposit** · verified
- Location: `packages/server/src/money/walletService.ts:191-196` (scan via `packages/server/src/db/prismaRepositories.ts:494-496`; unused bounded aggregate at :516)
- Evidence:
```
if (opts.depositCapCents != null) {
  const used = depositsToday(await ledger.listByUser(userId), Date.now(), opts.providerRef);
  ...
}
// prismaRepositories.ts: async listByUser(userId, opts?) { if (!opts) return (await this.db.transaction.findMany({ where: { userId } })).map(toTx); }
```
- Why it matters: Every deposit that carries a daily cap (webhook, TxID, auto-credit poller) runs an UNBOUNDED `findMany({ where: { userId } })`, maps every historical transaction to JS, then filters to today — all inside the deposit's DB transaction (which also holds a per-user advisory lock). For a heavy long-lived depositor this scan grows without bound, inflating transaction/lock duration and heap on a hot money path. The code already has a bounded DB aggregate (`sumByUserTypesSince`, :516) used elsewhere, but it is not used here — the wrinkle is that this check must EXCLUDE the current providerRef from the sum.
- Fix: Replace the full-ledger scan with a bounded aggregate: add `sumByUserTypeSince(userId,'deposit', startOfUtcDay)` and compute `used = aggregate − (amount of the row for THIS providerRef if it already exists)`. Since the current providerRef row is inserted by the same transaction AFTER this check, the aggregate naturally excludes it on a fresh credit; on a replay the code short-circuits at the `!created` return, so subtract a single `findByProviderRef(providerRef)?.amountCents`.
- *Verified: walletService.ts:191-196 calls ledger.listByUser(userId) with no opts inside the capped-deposit path, which run() executes within the UoW DB transaction while holding a per-user advisory lock (line 141), and listByUser(userId) with no opts is an unbounded findMany({where:{userId}}).map(toTx) (prismaRepositories.ts:494-496) that depositsToday then filters to today in JS — while the bounded sumByUserTypesSince aggregate (line 516) exists but is unusable as-is due to the current-providerRef exclusion; only the cited file path is wrong.*

**🔵 Per-user/global serialization chains (deposit + withdraw) are Maps/promises that are never pruned → slow unbounded memory growth** · verified
- Location: `packages/server/src/money/walletService.ts:115-121`; `packages/server/src/http/walletRoutes.ts:112-118`
- Evidence:
```
private readonly depositChain = new Map<string, Promise<unknown>>();
private serializeDeposit<T>(userId, fn) {
  const prev = this.depositChain.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  this.depositChain.set(userId, next.catch(() => undefined)); // never deleted
}
// walletRoutes.ts: const withdrawChain = new Map<string, Promise<unknown>>(); // never .delete()'d
```
- Why it matters: On a live app running for months, `depositChain` and `withdrawChain` accumulate one permanent Map entry per distinct user who has ever deposited/withdrawn. Never shrinks. A genuine leak, bounded by total user count with tiny entries — gradual, not a near-term crash, but it should not grow forever on a single long-lived replica.
- Fix: After the chained op settles, delete the entry when it is still the tail: capture `tail` and `next.finally(() => { if (this.depositChain.get(userId) === tail) this.depositChain.delete(userId); })`. Same for `withdrawChain`.

**🔵 joinCodeLimiter and the handshake throttle buckets are never released, unlike the main per-user limiter** · verified
- Location: `packages/server/src/realtime/gateway.ts:211` (joinCodeLimiter) & `216` (handshake); cf. release at `gateway.ts:422`
- Evidence: `private readonly joinCodeLimiter = new RateLimiter(6, 0.2);` and `private readonly handshake = new HandshakeThrottle();`. `onDisconnect` releases ONLY the main limiter (`this.limiter.release(userId)`); there is no `joinCodeLimiter.release` / handshake eviction on disconnect.
- Why it matters: The main intent limiter is freed on the user's last disconnect, but `joinCodeLimiter` (keyed by userId) and the per-(userId+IP) handshake throttle accumulate a bucket per key and are never evicted, so their internal Maps grow with unique users/IPs over the process lifetime. Low impact but inconsistent with the deliberate cleanup of the main limiter.
- Fix: In `onDisconnect`, when the user has no sockets left, also call `this.joinCodeLimiter.release(userId)` and evict the user's handshake entries (add a `release(userId)` to HandshakeThrottle), or give both a time-based idle eviction.

**🔵 settle() returning null emits match:end with payoutCents=null; safe only by an upstream invariant, with no defensive guard if that invariant ever breaks** · inferred
- Location: `packages/server/src/realtime/gateway.ts:2018-2020`; `packages/server/src/money/moneyService.ts:139-148`
- Evidence: `const settlement = await this.money.settle({ matchId, winnerSeats }); ... if (settlement) payoutCents = settlement.payouts.reduce(...)`. `settle()` returns null on `inFlight.has`, on `!record || record.status !== 'active'`, and on `winnerSeats.length === 0`.
- Why it matters: If `settle` returns null, the code proceeds to emit a normal `match:end` with `payoutCents=null` (winners shown as unpaid) instead of the settlement-failure branch. Today unreachable in the winning path because `claimFinalize` guarantees exactly one settle call with an 'active' record. But it is a latent trap: any future change letting settle be reached twice, or with a non-'active' record, would silently emit a paid-looking match with no payout and no alert.
- Fix: After the settle call, if `this.money && matchId && room.stakeCents > 0 && settlement == null`, treat it like the throw branch: increment `settlementFailures`, log loudly, emit `settlement_delayed`, and return without the normal match:end.

### Database & Data Layer — 7.5/10

**Strengths:** Integer-cents money columns with a documented int4 ceiling and a DB CHECK `balanceCents >= 0`; immutable append-only ledger with idempotent credits gated on a UNIQUE providerRef; a proper UnitOfWork wrapping balance + ledger writes in one `$transaction`; atomic conditional balance updates and status-guarded compare-and-set transitions; a well-considered FK/cascade policy (RESTRICT on audit/founder/war refs, CASCADE on chat/push, SET NULL on soft links) with orphan-cleanup-before-FK and NOT VALID patterns safe to apply live.

**🔴 reconcile()/matchLedgerSums() load the ENTIRE transactions ledger into JS every 5 minutes (and on the Telegram /health command) via unbounded ledger.all()** · verified
- Location: `packages/server/src/db/prismaRepositories.ts:507-509` (all()); `packages/server/src/money/walletService.ts:439` (reconcile), `458` (matchLedgerSums); `app.ts:1108/1150` (5-min sweep, RECONCILE_MS); `app.ts:1000-1003` (health closure — Telegram admin /health command only, adminBot.ts:807, NOT the Docker liveness probe at app.ts:268)
- Evidence: `PrismaLedger.all()`: `return (await this.db.transaction.findMany()).map(toTx);` — no where, no take, no cursor. `reconcile()` does `const all = await this.ledger.all();` then sums in JS. This runs in the 5-min sweep (`const rec = await wallet.reconcile();`) AND on the health closure. `matchLedgerSums()` also calls `ledger.all()`.
- Why it matters: The transactions table is the immutable, forever-growing core of a real-money app. Loading every row into Node memory on a 5-minute timer is O(total ledger size). At a few hundred thousand rows it is already slow; at millions it spikes memory, blocks the event loop during the `map()`, and eventually OOMs the single-replica server — precisely on the reconcile path that is the safety net. It also holds the `connection_limit=1` pool connection for the duration.
- Fix: Compute reconcile and match-conservation as DB-side aggregates. Balances: `SELECT "userId", SUM("amountCents") FROM transactions GROUP BY "userId"` compared to `users.balanceCents` in SQL (or an incremental reconcile keyed on `createdAt`). For matchLedgerSums use `groupBy({ by:['matchId'], _sum:{ amountCents:true }, where:{ matchId: { not: null } } })`. Keep `ledger.all()` only for tests.
- *Core claim verified: PrismaLedger.all() (prismaRepositories.ts:507-509) does an unbounded findMany().map(toTx), and both reconcile() (walletService.ts:439) and matchLedgerSums() (:458) load the entire append-only transactions ledger into JS, with reconcile() firing on the 5-minute sweep (app.ts:1150, RECONCILE_MS=5*60*1000) — genuinely O(ledger size) memory/event-loop/connection cost on a connection_limit=1 single replica, and notably the codebase already moved sibling paths to DB aggregates (sumByUserAndType/sumByUserTypesSince, :510-523, "no whole-table JS scan"); only the "every health check / per health probe" framing is overstated, since the reconcile-bearing health() closure is invoked by the manual Telegram admin /health command (adminBot.ts:807), not the cheap Docker liveness probe at app.ts:268.*

**🟡 Money-critical interactive $transaction runs with Prisma's default 5s timeout against a connection_limit=1 pooler** · verified
- Location: `packages/server/src/db/prismaRepositories.ts:1189-1210` (PrismaUnitOfWork.transaction — no options); `packages/server/src/db/prismaClient.ts:8-13`; `packages/server/src/money/moneyService.ts:156-170` (settle loops); `.env.example:170` (connection_limit=1)
- Evidence: `return this.db.$transaction((tx) => fn({...}))` is called with NO `{ timeout, maxWait }` — Prisma defaults to maxWait 2s / timeout 5s. `settle()` runs a per-payout loop of sequential awaits (credit + recordRake + markSettled) all inside that one interactive transaction, and `escrow()` loops per player. PrismaClient is constructed with no pool tuning; the documented prod URL is the Supabase pooler with `connection_limit=1`.
- Why it matters: If a settlement's sequential round-trips exceed 5s under latency/load, Prisma aborts the transaction (P2028) and rolls the whole settlement back. The match stays 'active' and must be re-settled by the sweep — recoverable, but an availability gap on the pay-the-winner path. With `connection_limit=1`, any other in-process DB work queues behind the held transaction.
- Fix: Pass explicit options: `this.db.$transaction(fn, { timeout: 15000, maxWait: 5000 })`, and reduce round-trips inside the tx (batch ledger inserts with `createMany`). Consider a slightly higher `connection_limit` (2-3) so a held money transaction doesn't starve health/read queries.
- *Verified: PrismaUnitOfWork.transaction (prismaRepositories.ts:1189) calls $transaction with no {timeout,maxWait} so Prisma's 5s default applies, settle()/escrow() run per-payout/per-player sequential awaits inside that one interactive transaction (moneyService.ts:117-124,156-170), PrismaClient is built with no pool tuning (prismaClient.ts:10), and .env.example:170 documents the prod pooler URL as connection_limit=1 — so under latency the settlement can hit P2028 and roll back (recoverable via the sweep, matching the stated medium-severity availability gap).*

**🔵 Advisory deposit lock uses hashtext() (32-bit), so distinct users' deposit keys can collide** · verified
- Location: `packages/server/src/db/prismaRepositories.ts:1205-1206`
- Evidence: `await (tx...).$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`` where `key = `deposit:${userId}``. `hashtext()` returns int4 (32-bit signed). Two different userIds can hash to the same value.
- Why it matters: A hash collision would make two unrelated users' capped-deposit transactions serialize against each other (a minor, harmless slowdown) — the lock is per-user for correctness of one user's own daily-cap read, so a collision never lets a wrong deposit through. Not a money-correctness bug, but an avoidable sharp edge if lock scope is ever widened.
- Fix: Prefer the two-argument advisory lock with a stable namespace + a full 64-bit key: `pg_advisory_xact_lock(hashtextextended(${key}, 0))` (bigint) or `pg_advisory_xact_lock(<lockClass:int4>, hashtext(${key}))`.

**🔵 Pure-stats applyMatchResult opens a second interactive $transaction per match-end, adding contention on the single pooled connection** · verified
- Location: `packages/server/src/db/prismaRepositories.ts:241-261`
- Evidence: `applyMatchResult` wraps a read-modify-write (currentStreak/biggestPotCents can't be pure `{increment}`) in `this.db.$transaction(async (tx) => { const cur = await tx.user.findUnique(...); return tx.user.update(...); })`. Runs at every match end, separately from the money settle transaction.
- Why it matters: Correct (the comment explains the RMW-atomicity motive), but it is a second serialized round-trip transaction per match completion, competing for the `connection_limit=1` pool alongside settlement. Under concurrency it compounds the pool pressure. Cosmetic stats, off the money path.
- Fix: Fold the streak/biggestPot RMW into a single conditional/GREATEST UPDATE: `UPDATE users SET currentStreak = CASE WHEN <won> THEN currentStreak+1 ELSE 0 END, biggestPotCents = GREATEST(biggestPotCents, <pot>), gamesPlayed = gamesPlayed+1, wins = wins + <wonInt>, xp = xp + <xpGain> WHERE id = <id>` (one atomic statement, no tx).

**🔵 Several status/type/role/category columns are free-text with no enum or CHECK constraint** · verified
- Location: `packages/server/prisma/schema.prisma:292` (Match.type), `:355` (GameAction.type), `:370` (SupportTicket.category), `:543` (ClubMember.role), `:498` (ChatReport.reason free by design)
- Evidence: `type String // '1v1' | '1v1v1' | '2v2'`, `type String // 'play' | 'pass' | ...`, `category String // 'match' | 'payment' | ...`, `role String // 'founder' | 'member'`. The money-state machines (Tournament.status, ClubWar.status) DID get DB CHECK constraints precisely because a typo could strand escrow — but these adjacent columns did not.
- Why it matters: A typo or drift in a code path writing these values is not caught by the DB. For `ClubMember.role` a bad value misrenders founder-vs-member ordering; for `Match.type`/`GameAction.type` it degrades replay/analytics. None currently strand money, so severity is low — but the protection is only where someone remembered to add it.
- Fix: Add narrow CHECK constraints in an additive migration (mirrors the `tournaments_status_check` pattern): `ClubMember.role IN ('founder','member')`, `Match.type IN ('1v1','1v1v1','2v2')`, `SupportTicket.category IN ('match','payment','account','other')`, `GameAction.type IN ('play','pass','switch','forfeit')`.

**🔵 Schema-invisible CHECK/FK-NOT-VALID constraints create silent drift risk if anyone ever runs `prisma db push` instead of `migrate deploy`** · inferred
- Location: `packages/server/prisma/schema.prisma` (no CHECK/NOT VALID representation); migrations 20260614000000:27-28, 20260624010000:23-25, 20260626001000, 20260628000000:11-22, 20260628010000
- Evidence: The `balanceCents>=0` CHECK, tournaments/club_wars status CHECKs, the distinct-clubs CHECK, and the NOT VALID FKs exist ONLY in raw SQL migrations; the comments note 'CHECK is invisible to Prisma's diff ... adds no schema drift.' `schema.prisma` has no way to express them, so `prisma db push` or a `migrate diff` baseline would consider a DB WITHOUT these constraints 'in sync'.
- Why it matters: As long as the team only uses `prisma migrate deploy`, the constraints persist. But the safety net is invisible to Prisma's own drift detection: a contributor who resets with `db push`, or a fresh environment provisioned from `schema.prisma`, would silently lose the balance-nonneg guard, the status CHECKs, and the club-war FKs. No automated test asserts the constraints exist.
- Fix: Add a startup/integration assertion querying `pg_constraint` for the critical constraints (`users_balanceCents_nonneg`, `tournaments_status_check`, `club_wars_status_check`, `club_wars_clubAId_fkey`, etc.) and fail-closed/alert if missing. Document explicitly that `prisma db push` must never be used against a real DB. Optionally VALIDATE the NOT VALID FKs in a follow-up migration.

**⚪ DepositIntent.userId and other soft-link tables have no FK, so an intent can reference a non-existent/anonymized user** · verified
- Location: `packages/server/prisma/schema.prisma:581-590` (DepositIntent), `:390-404` (SuspicionFlag), `:493-505` (ChatReport), `:508-515` (UserMute)
- Evidence: `model DepositIntent { providerRef String @id  userId String ... }` has no `user User @relation`. Same for SuspicionFlag/ChatReport/UserMute — all documented as 'soft string ids (no FK)'.
- Why it matters: Informational / by-design: these are ephemeral or analytics tables, users are anonymized (row retained) not hard-deleted, and DepositIntents are short-lived and swept. No orphaned-money risk (the ledger — not the intent — is authoritative, and it DOES FK userId). Flagged so the intentional asymmetry is on record: if a hard-delete path is ever added, these rows would orphan silently.
- Fix: No action required now. If a hard-delete user path is ever introduced, either add ON DELETE CASCADE FKs or ensure the delete flow purges intents/flags/reports for that user.

### Architecture & Code Quality — 7.5/10

**Strengths:** Clean, enforced package layering (engine imports NOTHING, shared has no cross-package deps, both repos implement shared interfaces with in-memory + Prisma parity, no circular deps); excellent 'why' comments documenting race-safety reasoning; zero TODO/FIXME/HACK markers and zero dead code across all four packages; strong boundary validation (a dedicated `realtime/validation.ts` treating the client as untrusted, Zod on HTTP routes, clean `tsc --noEmit`); magic numbers mostly named constants with unit suffixes.

**🟡 gateway.ts is a 2637-line god class coordinating 16 services + settlement, timers, bots and tournaments** · verified
- Location: `packages/server/src/realtime/gateway.ts:1` (whole file); largest method `tryBeginMatch` spans ~157 lines from line 1300
- Evidence: File is 2637 lines — the single largest source file in the repo. It holds 16 injected service fields, 27 `socket.on` handlers (gateway.ts:366-413) and 93 method-level members. Biggest methods: `tryBeginMatch` 157 lines, `applyResult` 132, `settleAndEmitMatchEnd` 100 — and `tryBeginMatch` alone interleaves compliance gating, RG loss checks, escrow, provably-fair dealing, seed persistence and match start in one function (lines 1313-1452).
- Why it matters: This is the highest-churn, hardest-to-reason-about file and it drives money settlement. A single class owning intent-routing + timers + settlement + bot-driving + tournament pairing means every gameplay change touches it, raising the odds of a regression in the money path. It's the main scalability/onboardability drag.
- Fix: Continue the decomposition already in flight (14 helpers exist in `realtime/`). Extract the match-lifecycle out of the socket class: (a) a `MatchStartCoordinator` owning `tryBeginMatch`'s compliance→RG→escrow→deal→start pipeline; (b) a `SettlementCoordinator` for `settleAndEmitMatchEnd`/`applyResult`. Leave the gateway a thin socket↔coordinator translator. Target: no method >60 lines, gateway <1000 lines.
- *Verified directly: gateway.ts is 2637 lines (largest source file in the repo), holds ~18 injected service/repo fields (finding said 16, a slight undercount that if anything strengthens the point), 27 socket.on handlers (gateway.ts:366-413), and tryBeginMatch (1297-1452, ~155 lines) genuinely interleaves account/compliance gating, RG loss caps, escrow, provably-fair dealing, seed persistence and match start in one method, with applyResult (~131) and settleAndEmitMatchEnd (~99) matching the cited sizes — a real maintainability drag on the money path, correctly rated medium (not a live bug), and the code even carries its own audit-2026-06-28 decomposition note at line 1963.*

**🟡 Prisma repository layer discards generated types via ~35 `row: any` mappers → silent schema-drift instead of compile errors** · verified
- Location: `packages/server/src/db/prismaRepositories.ts:52,59,381,429,526,584,721,798,810,886,956,980,998,1027,1056,1085,1239,1261` (toUser at :59 is representative)
- Evidence: Row mappers are typed `any`: `function toUser(row: any): User {` then read `row.balanceCents`, `row.tokenVersion ?? 0`, `row.dailyAnchor`. Prisma generates precise result types, but they're thrown away. JSON columns are force-cast: `cards: (a.cards ?? undefined) as any`, `bracket: t.bracket as any`. The team knows the right pattern — `db/jsonValidators.ts` (`parseBracket`/`parseWarPairings`) exists — but it's applied selectively while the User/Match/Withdrawal/Tournament mappers stay `any`.
- Why it matters: If the Prisma schema and the domain type drift (a renamed/removed column, a nullability change), `toUser` silently substitutes the `?? default` fallback at runtime rather than failing at compile time. In a money app, a mistyped balance/ledger field surfacing as a silent default is exactly the class of bug you want the compiler to catch. It weakens the otherwise-clean `tsc --noEmit` guarantee at the most critical boundary.
- Fix: Replace `row: any` with Prisma's generated row types (`import type { User as DbUser } from '@prisma/client'; function toUser(row: DbUser): User`). For JSON columns, route through `jsonValidators.ts` instead of `as any`. Do the ledger/wallet-adjacent mappers (toUser, toTx, toWithdrawal, toMatch) first.
- *Verified: prismaRepositories.ts defines row mappers typed `any` (toUser at :59 reading `row.balanceCents` with no fallback, toMatch/toWithdrawal/toTx/toTournament etc.), and JSON validation is applied selectively — read-side uses parseBracket/parseWarPairings/parseStringArray (:1060-61,:1242) while write-side force-casts `bracket: t.bracket as any` (:1251,:1275) — so Prisma's generated result types are discarded exactly at the money boundary, making schema drift a silent-runtime-default risk rather than a compile error; medium severity is apt (latent, drift-triggered, not presently exploitable), though the "~35 mappers" count is inflated (≈14 named row: any mappers) and several cited line numbers (721,886,956,980,998,1085,1239,1261) don't map to any/as-any sites in the current file.*

**🔵 No logging abstraction — 62 raw console.* calls with scattered eslint-disable suppressions in prod paths** · verified
- Location: `packages/server/src` across app.ts, authService.ts, gateway.ts, telegram/adminBot.ts, push/pushProvider.ts (62 total; ~24 `// eslint-disable-next-line no-console` in non-test code)
- Evidence: 62 `console.(log|warn|error)` hits outside tests, each individually silenced. E.g. `gateway.ts:1403 console.warn('[fair] staked match dealt with no post-commit client entropy', { roomId });` — a security-relevant anomaly logged as a bare `console.warn` with no level/structure/correlation-id.
- Why it matters: No structured logging means no consistent levels, no request/match correlation id, and no single place to route logs to the monitoring stack (Loki/Grafana are in the deploy profile). Security- and money-relevant events are emitted as free-text console lines that are hard to alert on. The 24 eslint-disable comments are a rule the codebase constantly opts out of.
- Fix: Introduce a thin logger (pino is idiomatic with Fastify and already available via `app.log`) with a `log.warn({ roomId, event: 'fair.no_entropy' })` shape, and remove the no-console exceptions by routing through it. Wire the same `app.log` instance into the gateway/services via DI.

**🔵 createGameServer is a ~966-line composition root wiring 31 services in one function** · verified
- Location: `packages/server/src/app.ts:449-1415` (createGameServer); 86 import statements at top of file
- Evidence: `createGameServer` runs from line 449 to ~1415 (966 lines) and instantiates 31 `new XService/Repository/...`. The same function inlines the background-job timers: `sweepTimer` (setInterval at :1134), `gaugeTimer` (:1285), `depositPollTimer` (:1331). app.ts imports 86 modules.
- Why it matters: A centralized composition root is the RIGHT pattern, so this is deliberately low severity. But at 966 lines it mixes three concerns — service construction, REST route registration, and background-timer scheduling — making wiring order hard to follow and the timers hard to test in isolation.
- Fix: Keep the single composition root but split its body: extract `wireServices(deps)` (the 31 constructions → a typed container), `registerRoutes(app, container)`, and `startBackgroundJobs(container)` (the three setInterval blocks) as separate functions called in sequence. No behavior change, ~3 smaller testable units.

### Tests — 8.5/10

**Strengths:** Money covered end-to-end with conservation invariants (`settlement.test.ts:52-64` sweeps pot×rake asserting paid+rake===pot), atomic idempotency under real Promise.all races, the ambiguous-vs-duplicate-vs-definite payout taxonomy, claim-jack prevention as an explicit attacker scenario, and HD-wallet derivation pinned to real TronWeb vectors; a Postgres integration suite (`pgConcurrency.test.ts`) actually runs in CI against a real DB (caught the `__house__` FK regression); no `.only`/`.skip`/`.todo` pollution; the engine test gates CI (verified: exits 1 on an injected failure).

**🟡 Client UI is largely untested (2 of 17 views, 4 of 42 components) — WalletView deposit/withdraw UX has no coverage of failure states** · verified
- Location: `packages/client/src/views` (17 *.tsx, 2 *.test.tsx: AdminView, WalletView); `packages/client/src/components` (42 *.tsx recursive, 4 *.test.tsx: Hand, ui/AvatarFace, ui/ConfirmDialog, ui/useConfirm); untested failure branches in `packages/client/src/views/WalletView.tsx` lines 82,92,138,142,172,190
- Evidence: 17 views vs 2 tests (AdminView, WalletView); 42 components vs 4 tests. The client lib/store layer is well tested, but the money-handling *views* — where a player copies a deposit address, enters a withdrawal amount, and sees error toasts — have almost no rendering/interaction tests.
- Why it matters: On a real-money PWA the client is where users trigger deposits/withdrawals. A regression that shows the wrong balance, mis-formats a withdrawal amount, submits the wrong destination, or silently swallows a 402/422 would pass CI. Server-side money is bulletproof; the surface the user touches is not.
- Fix: Add React Testing Library tests for the money-critical flows: WalletView withdraw form (min/max validation message, insufficient-funds 402 surfaced, held-balance shown), deposit address copy + TxID submit (`already_used` 409 and `not_verified` 400 rendered), balance formatting via the tested `money.ts`. Prioritize WalletView, AuthView, and the game table's stake/settlement banners over cosmetic components.
- *Counts verified exactly (17 views / 2 view tests: AdminView + WalletView; 42 components / 4 component tests), and WalletView.test.tsx tests only the happy-path withdrawal-confirmation gate, leaving all failure branches in WalletView.tsx untested — invalid TxID (line 82), amount <= 0 (line 138), destination too short (line 142), and the ApiError catch/error-toast paths (lines 92, 172, 190) — so a money-UX regression in those error states would pass CI, justifying medium severity.*

**🔵 Engine (core card rules) is validated by a bespoke console harness, not a standard runner — fragile and easy to author a silently-passing check** · verified
- Location: `packages/engine/src/engine.test.ts:6-9,118-119`; `packages/engine/package.json:13`
- Evidence: The rules engine is tested by `function check(name, cond){ if(cond){pass++}else{fail++...} }` run via `tsx src/engine.test.ts` with `if (fail > 0) process.exit(1)`. It DOES fail CI (injected `!B(...)` → exit 1), so not a silent-pass today. But every assertion is a hand-rolled boolean; a typo like `check('x', identifyCombo(bad))` (truthy object instead of `=== null`) passes with no error, and there are no negative-path guarantees a framework gives.
- Why it matters: The engine decides who wins every hand and therefore every payout. A future edit that weakens a check into an always-true expression would be invisible. Lower severity because the current file is correct and gates CI, but the pattern invites a silent hole in the most correctness-critical module.
- Fix: Port `engine.test.ts` to `node:test` (as the rest of the server uses) or vitest, replacing each `check(name, cond)` with `assert.ok(cond, name)` / `assert.equal(...)`. Mechanical change; adds real failure diffs + per-test isolation. Consider a couple of property-based checks (random legal hands → `beats()` is a strict total order; `deal()` partitions exactly 54 cards).

**🔵 Auth timing-oracle test relies on a wall-clock ratio (takenMs >= freshMs * 0.25) — load-dependent flakiness on CI** · verified
- Location: `packages/server/src/auth/authService.test.ts:91-109`
- Evidence: `const t0 = performance.now(); await auth.register(...fresh); const freshMs = ...; assert.ok(takenMs >= freshMs * 0.25, ...)`. This compares two Argon2 hash timings on a shared CI runner. Under noisy-neighbor load or GC pauses, the fresh timing can be inflated and the taken timing under-sampled, flipping the ratio and failing a correct build.
- Why it matters: A spurious red build on a real-money repo where CI is the merge gate erodes trust in the suite and can block hotfix deploys. The property being tested (no early return before the hash) is valuable, but the timing assertion is the wrong tool.
- Fix: Replace the timing measurement with a behavioral probe: inject a counting/spy password-hasher into AuthService and assert `hash` was CALLED on the taken-email path (call count == 1). That proves 'the hash runs before the uniqueness check' deterministically with zero flakiness.

**🔵 Background jobs (reconcile sweep, graceful-drain escrow refund, orphan recovery on boot) are only partially covered — the periodic sweep + SIGTERM drain are not exercised** · inferred
- Location: `packages/server/src/app.ts` (5-min reconcile/void/refund sweep + SIGTERM drain); tests: `moneyService.test.ts:194-221` covers `recoverOrphanedMatches()` the unit, but no test drives the app-level timer sweep or the graceful-drain path
- Evidence: `moneyService.test.ts:194-221` tests `recoverOrphanedMatches` as a pure function (boot recovery), which is good. But the composition root's setInterval sweep (refund orphaned matches, void stale tournaments/club-wars, reverse failed Binance withdrawals, treasury-underfunded alerts) and the SIGTERM graceful-drain-refunds path have no test asserting they fire and settle money correctly.
- Why it matters: These jobs are the safety net that returns escrowed player funds after a crash or during deploy (single-replica in-process timers). If a refactor breaks the sweep's wiring or the drain's ordering, escrow could be stranded and no test would catch it. Lower severity because the underlying units are individually tested.
- Fix: Add an app-level test that constructs the server with a tiny sweep interval and an in-memory money stack, escrows a match with no live room, awaits one sweep cycle, and asserts the stake was refunded and `reconcile().ok`. Separately unit-test the graceful-drain handler with an in-flight escrowed match, asserting funds are refunded and the ledger conserves.

**⚪ No coverage that the Postgres integration suite is actually running (not silently self-skipping) in CI** · verified
- Location: `packages/server/src/money/pgConcurrency.test.ts:25-26`; `.github/workflows/ci.yml:36-37`
- Evidence: `pgConcurrency.test.ts` self-skips unless `DATABASE_TEST_URL` is set: `const skip = PG_URL ? false : 'set DATABASE_TEST_URL...'`. CI sets it and spins a postgres service, so it should run — but `node:test` reports skipped tests as PASS, so if the env var were ever dropped the suite would go green while exercising zero real-DB guarantees. No assertion guards against skip.
- Why it matters: The Postgres suite is the ONLY place real `$transaction` races and the `__house__` FK are proven. A silent regression to skipped-mode (env var typo, workflow edit) would remove that safety with no red signal. Info-level because it's currently wired correctly.
- Fix: Add a guardrail test that fails when `DATABASE_TEST_URL` is unset in a CI context (`if (process.env.CI && !process.env.DATABASE_TEST_URL) assert.fail('pg integration tests must run in CI')`), or parse the runner summary in CI to assert a nonzero count of pg tests executed.

### Performance — 7/10

**Strengths:** Aggressive correct code-splitting (14 heavy views lazy-loaded via `lazyWithRetry`, sourcemaps off, vendor manualChunks); hot-path client re-renders contained via `useShallow` and a scoped `s.log` selector in TableView; the deposit auto-credit poller only polls the WATCHED set (idle cost is zero TronGrid calls); fonts tuned with preconnect + display=swap; the RG/VIP money aggregates already migrated to DB-side `aggregate()` queries — showing the team knows the right pattern.

**🔴 reconcile() loads the entire transaction ledger into JS + N+1 getBalance() per user, every 5 minutes** · verified
- Location: `packages/server/src/money/walletService.ts:438-450` (reconcile) and `:457-465` (matchLedgerSums); `ledger.all()` = unbounded `findMany()` at `packages/server/src/db/prismaRepositories.ts:507-509`; getBalance N+1 at `walletService.ts:123-126`; sweep every RECONCILE_MS=5min via `app.ts:1134/1150/1279`
- Evidence: `reconcile()`: `const all = await this.ledger.all();` where `all()` is `this.db.transaction.findMany()` (NO where, NO take, unbounded). Then per distinct user: `const balanceCents = await this.getBalance(userId);` inside `for (const [userId, ledgerSum] of sums)`, and getBalance is `await this.users.findById(userId)` — one SELECT per user. So each 5-min sweep = 1 full-table scan materialized in Node + M individual user SELECTs.
- Why it matters: On a LIVE money app the transaction table only grows. Every 5 minutes the process pulls the whole ledger into a JS array and issues one DB round-trip per distinct user. At tens of thousands of ledger rows and thousands of users this becomes hundreds of ms of event-loop-blocking JS reduce + a burst of serialized queries every sweep, degrading socket/HTTP latency, and grows without bound.
- Fix: Reconcile in SQL. Add a repo method returning per-user ledger sums: `db.transaction.groupBy({ by: ['userId'], _sum: { amountCents: true } })`, and fetch balances in one batch `db.user.findMany({ select: { id, balanceCents } })` (or a single JOIN/raw query returning only mismatched rows). Keep the in-memory implementation for tests behind the same interface.
- *Verified exactly as described — reconcile() calls this.ledger.all() (findMany() with no where/take, prismaRepositories.ts:507-509) into a JS array, then issues one findById per distinct user via getBalance (walletService.ts:124), all driven by a 5-min setInterval (app.ts:1279 RECONCILE_MS), and matchLedgerSums() reuses the same full scan; only the cited file path is wrong (it's src/db/, not src/money/), and severity is fairly "high" given the unbounded-growth trajectory even though current volumes make the impact latent (contrast: sumByUser* already use DB aggregate at prismaRepositories.ts:510-514).*

**🟡 Treasury liability check loads all ~5000 users into JS to sum balances, in the 5-min sweep** · verified
- Location: `packages/server/src/app.ts:1196` (sweep, every RECONCILE_MS=5min at app.ts:1279); `auth.listUsers()` -> `users.list()` -> `packages/server/src/db/prismaRepositories.ts:238`; also `app.ts:901-912` (digest) and `adminBot.ts:577,593`
- Evidence: `const liabilities = (await auth.listUsers()).filter((u) => u.role === 'user').reduce((s, u) => s + u.balanceCents, 0);` — `listUsers()` -> `users.list()` -> `this.db.user.findMany({ orderBy: { createdAt: 'desc' }, take: 5000 })`. Same full-user-list pattern in the admin digest and telegram digest.
- Why it matters: Every sweep (and every digest) materializes up to 5000 full User rows just to sum one integer column, then discards them. Blocks the event loop for the map/filter/reduce, and is capped at 5000 so past that the liability figure is silently WRONG (truncated) — a correctness risk in the treasury-underfunded alert.
- Fix: Replace the scan with a DB aggregate: `db.user.aggregate({ where: { role: 'user' }, _sum: { balanceCents: true } })` returns liabilities in one indexed query with no row materialization and no 5000 cap. Do the same for the digest's player count (`count`) and liabilities.
- *app.ts:1196 sums balanceCents by calling auth.listUsers() -> users.list() -> findMany({ take: 5000 }) (db/prismaRepositories.ts:238) inside the 5-min sweep (RECONCILE_MS = 5*60*1000, app.ts:1279), and the same full-list pattern recurs in the admin digest (app.ts:901-912) and telegram digest (adminBot.ts:577,593); the 5000 cap does silently truncate the liability figure past 5000 users, a real correctness risk in the treasury-underfunded alert — the only inaccuracy is the file path, which is packages/server/src/db/prismaRepositories.ts.*

**🟡 lobby:state is broadcast to EVERY connected socket on every room lifecycle event** · verified
- Location: `packages/server/src/realtime/gateway.ts:2488-2490` (broadcastLobby), called at lines 509,543,576,1019,1451,1601,1997,2010,2032,2149...
- Evidence: `private broadcastLobby(): void { this.io.emit('lobby:state', this.rooms.listLobby()); }` — `this.io.emit` hits ALL sockets, with no lobby-scoped room (only `leaderboard:refresh` is scoped to `LEADERBOARD_ROOM`). `broadcastLobby` is invoked on create, joinByCode, join, leave, match start, and every match end.
- Why it matters: Players actively at a table (who never render the lobby list) receive a full recomputed lobby snapshot on every room churn anywhere on the server. Fan-out is O(total connected sockets) × (create/join/leave/start/end rate). With the Redis adapter this multiplies cross-instance chatter. It fires unthrottled (a burst of joins = a burst of full broadcasts).
- Fix: Scope lobby updates: have sockets join a `LOBBY` room only while viewing the lobby (emit on lobby-enter, leave on room-enter/spectate) and `this.io.to(LOBBY).emit(...)`. Additionally coalesce: mark dirty and flush at most every ~250-500ms via a single timer instead of emitting synchronously on each mutation. Both are backward-compatible with the existing client.
- *Verified: broadcastLobby (gateway.ts:2488-2490) does this.io.emit('lobby:state', this.rooms.listLobby()) with no lobby room — socket.join is only used for personal/club/leaderboard/game-room scopes — and it fires on every create/join/leave/match-start/end across 20+ unthrottled call sites, so every connected socket (including players at a table who never render the lobby) receives a freshly recomputed full snapshot, amplified cross-instance by the Redis adapter.*

**🔵 LobbyView and RoomView subscribe to the ENTIRE game store (no selector), re-rendering on unrelated updates** · verified
- Location: `packages/client/src/views/LobbyView.tsx:133` and `packages/client/src/views/RoomView.tsx:25`
- Evidence: LobbyView: `const { lobby, live, createRoom, joinRoom, joinByCode, refreshLobby, findRanked, spectate } = useGameStore();` — bare `useGameStore()` with no selector subscribes to the whole store. RoomView: `const { mySeat, setReady, leaveRoom } = useGameStore();` — same. Contrast TableView which correctly uses `useShallow`.
- Why it matters: Any write to the game store — toast set/dismiss, chat bubble add/expire (3.5s/4.5s timers), presence, socket connect flags, log appends, incoming `lobby:state` — re-renders the full LobbyView (its room list) or RoomView (friends list + invite buttons). Not catastrophic, but unnecessary reconciliation of list-heavy components on frequent unrelated store churn, undercutting the otherwise-careful selector discipline.
- Fix: Wrap both in `useShallow` with the exact fields used, mirroring TableView: `useGameStore(useShallow((s) => ({ lobby: s.lobby, live: s.live, createRoom: s.createRoom, ... })))`. Action functions are stable references so including them is cheap.

**🔵 Render-blocking third-party Google Fonts stylesheet on the critical path (LCP/CLS risk)** · inferred
- Location: `packages/client/index.html:31-39`
- Evidence: `<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@900&family=Oswald:wght@600;700&family=Outfit:...&display=swap" />` followed by the same URL as `rel="stylesheet"`. Three families / many weights fetched from a cross-origin as a render-blocking stylesheet.
- Why it matters: First paint depends on a round-trip to a third-party origin (DNS/TLS/redirect to gstatic), adding LCP latency on cold/mobile connections and a font-swap CLS shift. `display=swap` + preconnect mitigate FOIT but the stylesheet fetch itself is still render-blocking and off the app's own origin (and leaks user IPs to Google). Felt on first load for a landscape mobile game.
- Fix: Self-host the trimmed woff2 subsets under the app origin and `<link rel="preload" as="font" ... crossorigin>` the 1-2 fonts needed for above-the-fold text, defining `@font-face` with `font-display:swap` in bundled CSS. If keeping Google Fonts, at minimum load the stylesheet non-blockingly (media=print onload swap).

**⚪ Unused 1.7MB logo.svg and other oversized static assets shipped in the deploy image** · verified
- Location: `packages/client/public/logo.svg` (1.7MB), `packages/client/public/icon-512.png` (256KB)
- Evidence: `du -h public/*`: logo.svg = 1.7M, icon-512.png = 256K. `logo.svg` is referenced ONLY by `scripts/gen-icons.mjs` (a build-time icon generator), never by any src file or the manifest. `icon-512.png` (256KB PNG) is referenced by the manifest for install icons.
- Why it matters: Not on any user critical path (logo.svg is never fetched by the running app), so no runtime LCP cost. But it bloats the client Docker image and deploy artifact by ~1.7MB of dead weight, and a 256KB 512px PNG icon is larger than needed.
- Fix: Move `logo.svg` out of `public/` into a non-served `assets/` or `scripts/` location (only needed by `gen-icons.mjs` at build time). Run `icon-512.png` through pngquant/oxipng to cut it well under 100KB. No app-code change.

### DevOps / Config / Docs — 7.5/10

**Strengths:** Supply-chain hygiene is strong — both Dockerfiles and every compose image pinned to `@sha256` digests, the Trivy action pinned to a commit SHA, non-root `node` user, multi-stage builds; deploy safety rails (pg_dump BEFORE boot-time `migrate deploy`, aborting on a failed `gzip -t` / <1KB dump, `set -euo pipefail`); config fails closed via compose `:?` guards + a CI `checkProdConfig.ts` gate; real observability (healthchecks, pino redaction of auth headers/cookies, IP redaction, Prometheus + Alertmanager→Telegram + Loki with money-integrity alerts); single-instance discipline with `deploy.replicas:1` and 127.0.0.1-only internal binds.

**🔴 Trivy image scan is report-only — known HIGH/CRITICAL CVEs ship to production unblocked, and the push step's 'only clean images' comment is false** · verified
- Location: `.github/workflows/ci.yml:126-149` (exit-code '0' at 132 & 139; misleading comment at 141; unconditional push gate at 144)
- Evidence: Both scan steps run with `exit-code: '0'` (lines 132, 139) and a comment: "REPORT-ONLY for now ... TODO(security): restore exit-code '1'". The push step (line 143) is gated only on `github.event_name == 'push' && github.ref == 'refs/heads/main'`, NOT on the scan result, yet its comment claims "Only CLEAN (Trivy-passed) images reach the registry" (line 141). Because Trivy can never fail, the pushed `:latest` image the VPS pulls may contain fixable HIGH/CRITICAL CVEs.
- Why it matters: The primary CVE gate for the images running the real-money server is disabled. A fixable HIGH/CRITICAL in the base or a shipped lib reaches production silently; the in-repo memory notes this was flipped off to avoid a pre-existing base CVE blocking the push. The misleading comment can lull an operator into believing images are scanned-clean when they are not.
- Fix: Restore `exit-code: '1'` on both Trivy steps (they run before push in the same job, so a non-zero exit aborts the push). To avoid wedging deploys on an unpatched upstream CVE, add a reviewed, time-boxed `.trivyignore` listing the specific CVE IDs with an expiry note, rather than disabling the whole gate. Keep `ignore-unfixed: true`. Update the line-141 comment to match reality until the gate is restored.
- *Both Trivy steps run with exit-code '0' (ci.yml:132,139) so the scan can never fail, and the GHCR push (ci.yml:143-149) is gated only on `github.event_name == 'push' && github.ref == 'refs/heads/main'` with no dependency on the scan, making the "Only CLEAN (Trivy-passed) images reach the registry" comment (line 141) false; fixable HIGH/CRITICAL CVEs ship unblocked to the real-money server.*

**🟡 .env.example omits the offsite-DR toggle and resource-sizing knobs the compose stack reads** · verified
- Location: `.env.example` (root); vars used in `docker-compose.deploy.yml:42-47,52,74,114,118`
- Evidence: Compose reads `BACKUP_REMOTE`, `RCLONE_CONFIG_DIR`, `POSTGRES_MEM_LIMIT`, `POSTGRES_MEM_RESERVATION`, `REDIS_MEM_LIMIT`, `SERVER_MEM_LIMIT`, `CLIENT_MEM_LIMIT` — `.env.example` has 0 hits for each. `BACKUP_REMOTE` gates the default-on `offsite-backup` service, flagged by the compose comment: "⚠️ OWNER ACTION: configure rclone + BACKUP_REMOTE before accepting more deposits — until then there is NO offsite copy of the money ledger".
- Why it matters: The single most operationally-important DR variable (`BACKUP_REMOTE`) and the mem-limits that protect the ledger DB on a ~1GB host are invisible to anyone provisioning from `.env.example`. An operator following the documented flow can run indefinitely with no offsite backup of the money ledger and never see a prompt to fix it. The mem-sizing knobs being undiscoverable means the 'TIGHT' 1GB defaults are unlikely to be raised on a bigger box.
- Fix: Add a commented DR + sizing block to `.env.example` documenting `BACKUP_REMOTE=remote:bucket`, `RCLONE_CONFIG_DIR`, and the `*_MEM_LIMIT` / `POSTGRES_MEM_RESERVATION` defaults with 'raise on 2GB+' guidance. Cross-reference `deploy/backup-offsite.sh` and the compose `offsite-backup` service.
- *Verified: `.env.example` has zero occurrences of all seven vars (BACKUP_REMOTE, RCLONE_CONFIG_DIR, POSTGRES_MEM_LIMIT/RESERVATION, REDIS/SERVER/CLIENT_MEM_LIMIT), while docker-compose.deploy.yml reads them (mem-limits at :42-43,47,52,74 with ~1GB-tuned `:-` defaults, and BACKUP_REMOTE at :114 gating the default-on offsite-backup that no-ops/sleeps until set — flagged by the "⚠️ OWNER ACTION ... NO offsite copy of the money ledger" comment at :108), so an operator provisioning solely from .env.example gets no offsite ledger backup and no way to discover the sizing knobs; medium is apt since the stack still boots and the compose comments do document rclone, making this a real DR/discoverability gap rather than an outage.*

**🔵 `apk upgrade --no-cache` in the runtime stages defeats the digest pin's reproducibility** · verified
- Location: `Dockerfile.server:26`; `Dockerfile.client:24`
- Evidence: The base is digest-pinned "for reproducible, tamper-evident builds" (Dockerfile.server:2), but the runtime stage runs `RUN apk upgrade --no-cache && apk add --no-cache openssl`. `apk upgrade` pulls whatever package versions the Alpine mirror serves at build time, so two builds of the identical pinned digest can produce different OS package sets.
- Why it matters: Mostly a tradeoff: the upgrade closes fixable CVEs between digest re-pins (part of why the Trivy gap feels acceptable to the author). But the digest pin no longer guarantees a bit-identical image, undermining tamper-evidence and making a bad-mirror or regressed-package build possible without any commit diff. It also adds an uncacheable network step to every build.
- Fix: Prefer rolling the base digest forward via `deploy/pin-images.sh` on a cadence and dropping the blanket `apk upgrade` (keep only `apk add openssl`). If you keep the upgrade for between-pin patching, document that the digest pin is now advisory-only and rely on Trivy (once restored) as the actual CVE gate — the two must not both be weakened at once.

**🔵 Docker build job rebuilds from scratch with no BuildKit layer cache — every push re-runs `npm ci` twice + vite build** · verified
- Location: `.github/workflows/ci.yml:117-120`
- Evidence: The `docker` job runs plain `docker build -f Dockerfile.server ...` and `docker build -f Dockerfile.client ...` with no `cache-from`/`cache-to`, no `setup-buildx-action`, and no registry cache. Each Dockerfile runs `npm ci` (server + client in separate images) and a full `vite build` on every push to main.
- Why it matters: Purely CI throughput/cost: every main push pays the full cold-build time with zero reuse, slowing the deploy loop the RUNBOOK sells as 'push → CI → pull-deploy in seconds'. No correctness or security impact.
- Fix: Use `docker/build-push-action` with `cache-from: type=gha` / `cache-to: type=gha,mode=max` (or a GHCR buildcache tag) and `setup-buildx-action`. Reuses the deps layer across pushes when `package-lock` is unchanged.

**🔵 Docs drift: RUNBOOK/README describe offsite backup and dev/Docker workflow that no longer match the shipped compose** · verified
- Location: `RUNBOOK.md:54-57`; `README.md:37-61`; `DEPLOYMENT.md:91`
- Evidence: `RUNBOOK.md:54` still labels offsite backup "(SET THIS UP — not automatic yet)" pointing only to the manual cron, but `docker-compose.deploy.yml:110-123` ships a DEFAULT-ON `offsite-backup` service. `README.md:37-41` tells devs the server runs on :3000 and client dev on :5173 and `docker compose up --build` 'just works', but `config.ts` defaults dev to :3100 and the base compose requires JWT/webhook secrets via `:?` so `docker compose up` fails without a populated `.env`. `DEPLOYMENT.md:91` lists `CLIENT_ORIGIN` default as :5173 while compose defaults it to :8080.
- Why it matters: Reproducibility/onboarding friction and a subtle DR confusion — an operator reading only the RUNBOOK may set up the manual cron AND the compose service (double sync) or assume offsite is manual-only and never notice the compose service is silently no-opping because `BACKUP_REMOTE` is unset. Stale ports/commands cost new-dev time.
- Fix: Update RUNBOOK §3 to reference the compose `offsite-backup` service as the primary path (manual script = fallback), align README dev/Docker instructions with the :3100 dev default and the `.env`-required Docker start, and reconcile the `CLIENT_ORIGIN` default across DEPLOYMENT.md and compose.

**🔵 Grafana defaults to admin/admin when GRAFANA_ADMIN_PASSWORD is unset (monitoring profile)** · verified
- Location: `docker-compose.deploy.yml:239-243`
- Evidence: `GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-admin}` with a comment that the default 'forces a change at login otherwise'. Grafana binds to `127.0.0.1:3000` and the profile is opt-in, so it is not publicly reachable — exposure requires an SSH tunnel or a host already compromised.
- Why it matters: Low and mitigated by localhost-only binding + opt-in profile: an attacker with host/tunnel access could reach Grafana with admin/admin if the operator skipped the password. Grafana reads Prometheus/Loki, so worst case is disclosure of ops/money-flow telemetry, not fund movement.
- Fix: Promote `GRAFANA_ADMIN_PASSWORD` to a `:?` required var when the monitoring profile is used, or set `GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION` and provision a user; at minimum document it in `.env.example`.

### UI/UX & Accessibility — 8.5/10

**Strengths:** Accessibility genuinely engineered — working skip-link to a focusable `<main>` landmark, a focus-trap with restoration and a `getClientRects()` visibility filter, focus-visible rings on every control (including a bespoke high-contrast ring for gold-on-gold buttons); reduced-motion respected in CSS AND JS (Confetti/CountUp); disciplined money UX (in-flight double-submit guards, ConfirmDialog for irreversible actions, first-load-only skeletons, role=alert/status messaging); a 44px `pointer: coarse` touch floor + 16px input floor to defeat iOS zoom; a coherent WCAG-tuned design-token system.

**🔵 Tab pattern is incomplete: role="tab" without role="tabpanel" or aria-controls anywhere** · verified
- Location: `packages/client/src/views/WalletView.tsx:279-291` (also ClubsView, SupportView, LobbyView, LeaderboardView)
- Evidence: `<div className="seg grid grid-cols-3" role="tablist" aria-label={...}> ... <button role="tab" aria-selected={walletTab === tab} ...>`. A repo-wide grep for `role="tabpanel"` and `aria-controls` returns "No files found" — the toggled `<section>`s carry neither `role="tabpanel"` nor an id referenced by the tab's `aria-controls`, and tabs lack roving tabindex / arrow-key navigation.
- Why it matters: Screen-reader users hear 'tab, selected' but the switched content is not announced as an associated panel, and there is no arrow-key navigation between tabs — the ARIA tab pattern is announced as present but behaves incompletely. Minor: the buttons still work and aria-selected conveys state.
- Fix: Either (a) complete the pattern: `role="tabpanel"` + `id` on each panel, `aria-controls={panelId}` + roving `tabIndex` with ArrowLeft/Right handlers; or (b) simpler and equally valid — drop `role="tablist"`/`"tab"` and render a plain button group with `aria-pressed`, which needs no panel association. A shared `<Tabs>` component fixes all call sites at once.

**🔵 Transaction filter chips fall below the 44px WCAG 2.5.5 touch-target minimum** · verified
- Location: `packages/client/src/views/WalletView.tsx:427-436`
- Evidence: Filter chips are hand-rolled, not `.btn-*`: `className={`text-xs rounded-full px-2.5 py-1 border ...`}`. The 44px touch floor (index.css:1138-1142) only targets `.btn-sm, .btn-xs, .seg-tab, .field, .iconbtn` — these raw chips match none, so at `py-1` (4px) + `text-xs` they render ~24-26px tall on touch.
- Why it matters: Six adjacent small tap targets (All/Deposits/Withdrawals/Bets/Payouts/Transfers) on the money screen are below 44px, so mis-taps are likely on phones — the exact device class this PWA targets.
- Fix: Add a shared `.chip-filter` class (or reuse `.btn-xs`) and include it in the `pointer: coarse` `min-height: 44px` rule, or bump to `py-2` and wrap the row so height ≥44px.

**🔵 English is the default language for an Albanian-first product** · inferred
- Location: `packages/client/src/lib/i18n.ts:1310-1314`
- Evidence: `function loadLang(): Lang { ... return localStorage.getItem(STORAGE_KEY) === 'sq' ? 'sq' : 'en'; }`. There is no detection of `navigator.language` — an Albanian visitor lands in English until they find the language toggle.
- Why it matters: The product is an Albanian card game with Albanian as the source language, yet first-time Albanian users see English. A product/UX mismatch adding friction for the core audience; deliberate (the comment states it) so impact is bounded.
- Fix: Detect on first run only: `return stored ?? (nav?.startsWith('sq') || nav?.startsWith('al') ? 'sq' : 'en')` — so an explicit choice always wins. Confirm the intended default with the owner.

**⚪ No RTL / dir handling and hardcoded directional glyphs; fine for sq/en but not future-proof** · verified
- Location: `packages/client/src/lib/i18n.ts:1314,1324` (sets `document.documentElement.lang` only)
- Evidence: `document.documentElement.lang = loadLang()` is set, but `dir` is never set and there is no `[dir='rtl']` styling. Directional affordances are hardcoded LTR in copy, e.g. `'common.backToLobby': { sq: '← Kthehu te lobi' }` — the arrow is baked into the string.
- Why it matters: Neither shipped language (sq, en) is RTL, so no user-facing bug today. It only matters if Arabic/Hebrew/Farsi is added, at which point baked-in ← arrows and LTR-only layout would need rework.
- Fix: When/if an RTL locale is added: set `document.documentElement.dir` alongside `lang`, move directional arrows out of translation strings into CSS logical properties or `::before` content flipped by `[dir='rtl']`, and audit `space-x`/`ml-`/`mr-`/`left`/`right` for logical-property equivalents.

**⚪ Toast reuses button hit-area for dismissal but the whole content is a single button — long messages are one giant tap target with a tiny visual ✕** · verified
- Location: `packages/client/src/components/Toast.tsx:34-45`
- Evidence: `<button type="button" onClick={onDismiss} className="flex items-center gap-2 ... text-left"><span>{message}</span><span aria-hidden ...>✕</span></button>` — the visible pill is a single button carrying no role; the dismiss affordance is a tiny non-interactive `aria-hidden` ✕ while the entire message is the click target.
- Why it matters: Minor UX ambiguity: an actionable error like 'Insufficient balance' is only dismissable, and the small ✕ can read as a close icon separate from the message. No accessibility defect (dismiss works by keyboard/tap; announcement is handled by dedicated live regions).
- Fix: Give the button an explicit `aria-label={t('common.close')}` and/or make the ✕ visually clearly the dismiss affordance while keeping the whole pill tappable.

### Mobile / iOS / Android / PWA — 7.5/10

**Strengths:** Safe-area handling is systematic (`viewport-fit=cover` + per-surface `env(safe-area-inset-*)` on table root, app shell, modals, and even the on-felt Pas/Luaj buttons); production-grade touch interaction (Pointer Events, `setPointerCapture`, `touch-action: none`, a 16px touch-slop tap-vs-drag threshold); the iOS input auto-zoom fixed at root (`font-size: 16px`) while pinch-zoom stays enabled; a deliberately conservative money-safe service worker (never intercepts non-GET/`/api`/`/socket.io`, network-first navigations, sanitized deep-links); genuine lifecycle care (wake-lock re-acquire, frozen-socket kick on visibility/online/focus, Android Back exit-guard).

**🟡 Android hardware-Back at the table both closes a modal AND triggers the leave-table prompt (double popstate consumers)** · verified
- Location: `packages/client/src/lib/useModalBack.ts:12-27`, `packages/client/src/lib/useExitGuard.ts:13-29`, `packages/client/src/views/TableView.tsx:893`
- Evidence: Both hooks register `window.addEventListener('popstate', ...)` and are mounted simultaneously at the table. `useExitGuard(!!room && !spectating, ...)` is active during a match. TableView renders its own ProfileModal, which uses `<Modal>` → `useModalBack(true, onClose)`. Sequence: exitGuard pushes sentinel A; opening the profile pushes sentinel B; one Back press pops B, and BOTH listeners fire — `useModalBack.onPop` closes the profile, while `useExitGuard.onPop` re-traps and calls its callback → App sets `backLeave`/leaves.
- Why it matters: Tapping an opponent avatar at the table (a normal action) then pressing Android Back to dismiss the profile also pops the 'leave the table?' confirm (or, on a waiting/finished room, immediately calls `leaveRoom`). A player trying to close a modal is nagged to leave — or bounced out of — a live/staked game. Reachable in ordinary gameplay on every Android device.
- Fix: Make the two guards cooperative. Simplest: when a modal's `useModalBack` is active, suppress the exit-guard's response to that same pop — have `useModalBack` set a short-lived global flag (`window.__modalBackActive`) that `useExitGuard.onPop` checks and early-returns on; or nest the guards through a single shared history-sentinel stack so only the top-most consumer handles a given Back. Add a regression test that mounts both hooks and asserts one popstate closes only the top overlay.
- *Both useModalBack (Modal.tsx:22, used by ProfileModal.tsx:106) and useExitGuard (App.tsx:143, active during a match) register unconditional global popstate listeners that fire their callbacks without checking event.state, so a single Android Back press to dismiss a table-opened ProfileModal (opened via TableView.tsx:468/893) both closes the modal AND triggers useExitGuard's onBack — nagging a 'leave the table?' confirm mid-match, or on a waiting/finished room immediately calling leaveRoom() and bouncing the player to the lobby.*

**🔵 ~145 lines of CSS-rotation ('force-landscape') dead code — the class and its measurement vars are never set by any JS** · verified
- Location: `packages/client/src/index.css:1230-1374` (and the `html.rotating` rule :1241), `packages/client/src/components/ui/Modal.tsx:46-49`
- Evidence: The entire `@media (orientation: portrait) { html.force-landscape #root { ... transform: rotate(90deg); ... } }` system depends on the class `force-landscape` and CSS vars `--app-w`/`--app-h`/`--app-rotating` being applied to `<html>`. A repo-wide search for JS that sets them found nothing. Orientation is instead handled by `useForceLandscapeApp()` → RotateOverlay, the 'rotate your phone' prompt adopted after abandoning CSS rotation.
- Why it matters: Large blocks of never-executed CSS still reference a rendering model that no longer exists. It misleads maintainers (`Modal.tsx:46-49` justifies portaling into `#root` 'so the modal sits INSIDE the CSS-rotated app frame' — a frame that never rotates), and risks a future partial re-activation rendering the whole app sideways. Pure maintenance/regression risk.
- Fix: Delete the force-landscape media block (index.css:1230-1374) and the `html.rotating` rule, and update the Modal.tsx portal comment to reflect that `#root` is used purely for stacking-context. If the rotation path might be revived, move it behind a clearly-labelled feature flag.

**🔵 Service worker uses a single never-versioned cache name; manifest, logo.svg and Google Fonts are cached cache-first indefinitely** · verified
- Location: `packages/client/public/sw.js` (`const CACHE='murlan-shell-v1'`; activate handler; fetch cacheable branch)
- Evidence: `const CACHE = 'murlan-shell-v1';` is hard-coded. The `activate` handler deletes only caches whose key !== CACHE, but CACHE never changes across deploys, so nothing inside it is ever evicted. The fetch handler caches cache-first: `.svg`/`.webmanifest` and the Google-Fonts branch — all cache-first with no expiry.
- Why it matters: After a deploy that changes `/manifest.webmanifest` (new icon set, name, orientation) or `/logo.svg`, an installed PWA keeps serving the stale cached copy until the browser independently revalidates — the install icon/name/manifest can lag a release. Hashed `/assets/*` are safe and navigations are network-first, so this is limited to the manifest/svg/fonts surface.
- Fix: Bump the cache name on releases (derive from the build hash: `const CACHE = 'murlan-shell-' + __BUILD_ID__` injected by Vite `define`) so `activate()` purges the old cache; or switch the manifest/svg to network-first. Icons already use `?v=` busting in index.html — apply the same discipline to the manifest/fonts.

**🔵 InstallModal close button is a 36px tap target (below the 44px WCAG/iOS floor)** · verified
- Location: `packages/client/src/components/ui/InstallModal.tsx:60-67`
- Evidence: `className="absolute top-3 right-3 w-9 h-9 grid place-items-center rounded-full ..."` — w-9/h-9 = 2.25rem = 36px. Unlike the shared Modal's close, which uses `.iconbtn` (bumped to 44px on touch), this custom button is not covered by that rule.
- Why it matters: A 36px dismiss control in the corner of a bottom-sheet is harder to hit accurately on a phone, especially near the screen edge. Minor; the modal is dismissible other ways (backdrop tap, 'don't remind me').
- Fix: Reuse `.iconbtn` for the close button (inherits the 44px touch floor), or add `min-w-[44px] min-h-[44px]`.

**🔵 Whole-app landscape lock blocks portrait for ALL tablets/phones, including wallet/deposit/KYC flows** · inferred
- Location: `packages/client/src/lib/useForceLandscapeApp.ts:12-55`, `packages/client/src/App.tsx:119,261`
- Evidence: `useForceLandscapeApp()` returns `mobile && portrait` where `mobile = isMobileOrTablet()` — true for iPads and any coarse-pointer/no-hover device. When true, App renders `<RotateOverlay/>` at `z-[200]` over everything, so in portrait the ENTIRE app — login, wallet, deposit address/QR, support — is blocked behind 'rotate your phone', not just the table.
- Why it matters: On an iPad or large phone held in portrait, users must rotate even to read a deposit address, copy a TxID, or submit KYC/support — surfaces that are naturally portrait-friendly and, for a real-money app, matter for compliance/readability. Intentional per the memory note, but forcing landscape on money/compliance screens is defensible-but-questionable.
- Fix: Consider scoping the rotate lock to the game table + high-density game screens and allowing portrait for wallet/deposit/support/auth/legal. If a global lock is a hard product decision, at least confirm the deposit QR/address and KYC/legal text render comfortably in the forced-landscape frame on the smallest supported device.

### Conversion / Trust / Business — 5.5/10

**Strengths:** Deposit/withdraw copy is unusually honest and trust-building (prominent irreversibility warnings, live TRON-address/64-hex-TxID validation, 'you receive after fee' math, honest payout-time estimates, a real Tronscan link); no dark patterns in the money flow (no fake confirmation counters, double-submit guards, double-confirmation on irreversible actions); retention hooks wired in (recent-winners ticker, friends-online duel, daily-streak, a good risk-free OnboardingModal); GDPR data-rights surfaced in the wallet with a 'no tracking, no ads' promise; high-quality warm microcopy throughout.

**🟠 No age (18+) gate or Terms/Responsible-Gaming acceptance at signup on a live real-money product** · verified
- Location: `packages/client/src/views/AuthView.tsx:108-130` (register form); `packages/server/src/http/authRoutes.ts:100-102` (register route)
- Evidence: The register branch collects only username/email/password: `else await register({ username, email, password });`. There is no age checkbox, no '18+' statement, and no Terms/Privacy acceptance anywhere in the register UI. A grep for `18|age|terms|kushtet|acceptTerms` returns zero signup-gate matches. The server even ships an `err.age_restricted` string ('You must be at least 18 years old.') but nothing on the client ever collects or asserts age.
- Why it matters: For a money-gambling PWA this is simultaneously a trust/conversion gap (serious players expect a real gambling site to gate age and show terms) and a compliance/liability exposure (unverified minors can register and deposit; no recorded consent to terms). It weakens the 'legitimate operator' first impression that drives deposit conversion.
- Fix: Add a required 18+/terms acknowledgement to the register form: a checkbox 'I am 18+ and accept the Terms & Responsible-Gaming policy' with links, gating the CREATE ACCOUNT button. Persist the acceptance (timestamp + terms version) server-side. Optionally collect DOB to enforce the existing `err.age_restricted` path:
```
{mode==='register' && <label className='flex gap-2 text-xs'><input type='checkbox' required checked={agree} onChange={..}/> {t('auth.age18Terms')}</label>}
```
and pass `agree` (plus `acceptedTermsAt`) to `register()`.
- *Verified AuthView.tsx:108-130 renders only username/email/password with a plain "CREATE ACCOUNT" submit (no 18+ checkbox, no Terms/Responsible-Gaming acceptance, no consent capture), and authRoutes.ts:100-102 just forwards req.body to auth.register with no age/consent fields; the post-signup OnboardingModal is educational only, DOB is only collectable later via self-service /api/account/profile with no verification, and MIN_AGE defaults to 0 — so a live real-money PWA has no signup age gate or recorded terms consent exactly as described.*

**🟠 Auth/landing screen has no value proposition, trust signals, or social proof — weak first impression** · verified
- Location: `packages/client/src/views/AuthView.tsx:73-84`
- Evidence: The only above-the-fold copy is a logo, `CARD CLUB` eyebrow, the wordmark `CRYPTO-MURLAN`, and the app-download buttons (`<div>CARD CLUB</div>` + `<h1>CRYPTO-MURLAN</h1>` + `{!isStandalone() && <AppDownload/>}`). The written tagline 'Play online for real' (i18n.ts:44 `auth.tagline`) is defined and unit-tested but NEVER rendered by any component. There is no 'why trust us', no security/provably-fair mention, no player-count / winnings social proof, and no legal/license line.
- Why it matters: The top of the funnel is where a real-money visitor decides whether the site is legit before creating an account. A bare form with no value prop, no reassurance, and no social proof suppresses signup conversion and reads as unfinished/untrustworthy versus competitors.
- Fix: Render `auth.tagline` under the wordmark, and add 2-3 trust chips ('Provably-fair replays', 'Instant USDT deposits', 'Withdraw anytime') plus a small recent-winners/online line reusing the existing LobbyLiveStrip data. Add footer links to Terms/Privacy/Responsible-Gaming. All copy infra already exists; mostly wiring existing strings + a small trust strip.
- *Verified: AuthView.tsx:73-84 renders only the logo, the "CARD CLUB" eyebrow, the "CRYPTO-MURLAN" wordmark, and the AppDownload buttons — no tagline, trust/provably-fair copy, social proof, or legal line; the defined `auth.tagline` key ("Play online for real", i18n.ts:44) is referenced only in i18n.test.ts:19 and never rendered by any component, exactly as described.*

**🟡 No Terms of Service, Privacy Policy, or Responsible-Gaming pages/links anywhere in the client** · verified
- Location: `packages/client/src` (no legal view exists); AuthView.tsx (footer absent); WalletView.tsx (deposit/withdraw)
- Evidence: There is no Terms/Privacy/legal view file (App.tsx route table lines 235-253 has no legal route). Grep for `terms|legal|privacy|licens` in client src finds only the cookie-notice string and social 'privacy toggle' — no policy links. The wallet handles real crypto but shows no link to withdrawal/AML terms.
- Why it matters: A money site with zero accessible legal terms erodes trust for cautious depositors and is a compliance gap. Users cannot review deposit/withdrawal terms, dispute policy, or responsible-gaming resources before funding — a known deposit-conversion blocker.
- Fix: Add a lightweight Legal view (static Terms / Privacy / Responsible-Gaming, even MVP text) reachable from a persistent footer link on AuthView and from Settings/Support. Link the signup acceptance to it. Small if the content is static markdown-in-TSX.
- *Verified: no Terms/Privacy/legal view file exists in packages/client/src/views, App.tsx's route table (lines 235-253) has no legal route, AuthView.tsx has no footer/legal links, and the only "privacy" references are the linkless cookie-acknowledgment (CookieNotice.tsx / consent.text i18n at i18n.ts:37-41) and the ClubsView privacy toggle — plus the WalletView comment (line 404) notes responsible-gaming controls were removed by owner decision, so a real-money crypto site ships with zero accessible ToS/Privacy/Responsible-Gaming/AML pages as stated.*

**🟡 Deposit tab shows no minimum, no fee statement, and no first-time reassurance — friction at the critical fund step** · verified
- Location: `packages/client/src/views/WalletView.tsx:296-359`
- Evidence: The deposit section renders the address, QR, auto-credit note, wait hint and a TxID fallback, but never surfaces `wallet.minDepositHint` ('Minimum $5. Use USDT (TRC-20) — lowest fees.', i18n.ts:230) — grep returns only the catalog entry, so it is defined but unused. There is also no 'deposits are fee-free' statement and no explicit 'send at least $X' guidance before the user copies the address.
- Why it matters: At the single highest-value conversion step (first deposit), the user is left guessing how much to send and whether there are fees. Missing minimum + missing fee-free reassurance increases hesitation and support tickets, and risks under-minimum sends that don't credit.
- Fix: Render the existing `wallet.minDepositHint` under the deposit steps and add a short 'Deposits are free — you pay only the TRON network fee' line: `<p className='text-xs text-muted'>{t('wallet.minDepositHint')}</p>` inside the deposit section near line 300.
- *The deposit section at WalletView.tsx:296-359 renders only the TronWarning (wrong-coin/network loss), deposit steps, auto-credit note, wait hint + Tronscan link, and TxID fallback — none state a minimum or that deposits are fee-free, and grep confirms wallet.minDepositHint ('Minimum $5... lowest fees') is defined at i18n.ts:230 but never referenced/rendered anywhere in src, so the described conversion/trust gap is genuinely present.*

**🟡 Product ships English by default despite being Albanian-first, with no language switch on the login screen** · verified
- Location: `packages/client/src/lib/i18n.ts:1311-1312`; `packages/client/src/views/AuthView.tsx` (no lang control)
- Evidence: `// English is the DEFAULT language; Albanian only if the user has explicitly chosen it.` and `return localStorage.getItem(STORAGE_KEY) === 'sq' ? 'sq' : 'en';`. The source language is Albanian (`sq default`, file header). AuthView renders no language toggle, so a first-time Albanian visitor lands in English with no visible way to switch before signing up.
- Why it matters: The core market is Albanian. Defaulting first-time visitors to English — and hiding the switch behind the settings menu that only appears after login — mismatches the audience and adds comprehension friction at the exact moment trust is being formed, lowering signup.
- Fix: Default to `sq` for the target market (or detect `navigator.language` starting with 'sq'), and expose a small SQ/EN toggle on AuthView. Verify EN completeness before hard-defaulting EN (some unmigrated views only have Albanian literals).
- *Verified all claims: i18n.ts:1311-1312 defaults first-time visitors to English ("English is the DEFAULT language"), the file header (line 3, 8) confirms Albanian is the source language, AuthView.tsx contains zero lang/language references, and the only language toggle lives in SettingsModal which is rendered exclusively inside TopBar within the authenticated Shell (App.tsx routes unauthenticated users to a bare AuthView), so an Albanian-first visitor lands in English with no reachable switch before signup.*

**🔵 Onboarding real-money step promotes deposits with no responsible-gaming framing at the point of first exposure** · inferred
- Location: `packages/client/src/components/ui/OnboardingModal.tsx:13-17`; `i18n.ts:1003-1004` (onb.s3)
- Evidence: The final onboarding step is `{ icon:'💰', titleKey:'onb.s3Title', bodyKey:'onb.s3Body' }` with copy 'When you're ready, join a staked table or create your own. Deposit crypto in your wallet and win for real.' It nudges toward depositing and 'win for real' with no 18+/play-responsibly line, though responsible-gaming copy exists elsewhere (`settings.sessionHint` 'Play mindfully… 🔞').
- Why it matters: Encouraging first deposit and 'win for real' without any responsible-gaming or age framing at the introductory moment is a soft trust/compliance risk and can deter cautious users; it also misses a cheap credibility signal legitimate operators include.
- Fix: Append a short 'Play responsibly · 18+ · you can set limits and self-exclude in your wallet' line to the `onb.s3` body (or as a persistent footnote in the modal), reusing existing responsible-gaming strings.

## 5. Quick Wins

- **Auto-payout DEFINITE-failure fund loss** — order refund credit before `markReversed` (or drop the `.catch`) so a failed refund leaves the row 'completed' for the reconciler — `packages/server/src/money/withdrawals.ts:340-345`
- **Make auto-pay AML cap reads fail-closed** — wrap the cap-read `Promise.all` in try/catch and force tier 'manual' on error, mirroring the transfer cap — `packages/server/src/http/walletRoutes.ts:309-315`
- **Prune the deposit/withdraw serialization Maps** — `next.finally(() => { if (chain.get(userId) === tail) chain.delete(userId); })` — `packages/server/src/money/walletService.ts:115-121`, `packages/server/src/http/walletRoutes.ts:112-118`
- **Release joinCodeLimiter + handshake buckets on last disconnect** — mirror the main limiter's `release(userId)` in `onDisconnect` — `packages/server/src/realtime/gateway.ts:211,216`
- **Guard the settle()===null-with-pot case** — treat null settlement on a staked match like the throw branch (increment `settlementFailures`, log, `settlement_delayed`) — `packages/server/src/realtime/gateway.ts:2018-2020`
- **Gate global tournament creation behind admin** — `if (!clubId) { const c = await admin(req, reply); if (!c) return; }` — `packages/server/src/http/tournamentRoutes.ts:146-166`
- **Enforce numeric `ver` in verifyRefresh** — mirror the access-token guard (reject non-number `ver` / missing jti+family) — `packages/server/src/auth/tokens.ts:92-103`
- **Allowlist the Web-Push endpoint host/scheme** — `.refine()` the Zod schema to https + real push hosts, rejecting private/loopback — `packages/server/src/http/accountRoutes.ts:34-37`
- **Lock down the API-origin CSP** — `contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } }` — `packages/server/src/app.ts:209-212`
- **Treasury liability via DB aggregate** — `db.user.aggregate({ where: { role: 'user' }, _sum: { balanceCents: true } })` (removes the 5000-row cap + truncation) — `packages/server/src/app.ts:1196`
- **Widen the advisory-lock key to 64-bit** — `pg_advisory_xact_lock(hashtextextended(${key}, 0))` — `packages/server/src/db/prismaRepositories.ts:1205-1206`
- **Add explicit money-tx timeout** — `$transaction(fn, { timeout: 15000, maxWait: 5000 })` — `packages/server/src/db/prismaRepositories.ts:1189-1210`
- **Fold applyMatchResult RMW into one atomic UPDATE** (CASE/GREATEST), removing the per-match transaction — `packages/server/src/db/prismaRepositories.ts:241-261`
- **Add CHECK constraints on free-text enums** (ClubMember.role, Match.type, GameAction.type, SupportTicket.category) in an additive migration — `packages/server/prisma/schema.prisma:292,355,370,543`
- **Restore Trivy `exit-code: '1'`** before the push with a time-boxed `.trivyignore`, and fix the false 'only clean images' comment — `.github/workflows/ci.yml:126-149`
- **Document DR + sizing vars in .env.example** (BACKUP_REMOTE, RCLONE_CONFIG_DIR, all `*_MEM_LIMIT`, POSTGRES_MEM_RESERVATION) — `.env.example`
- **Promote GRAFANA_ADMIN_PASSWORD to a required `:?` var** (or disable initial admin creation) — `docker-compose.deploy.yml:239-243`
- **Add GHA BuildKit layer cache** (`cache-from/to: type=gha`) to the docker job — `.github/workflows/ci.yml:117-120`
- **Scope LobbyView/RoomView to `useShallow`** with the exact fields used — `packages/client/src/views/LobbyView.tsx:133`, `packages/client/src/views/RoomView.tsx:25`
- **Delete the dead force-landscape CSS block** and fix the Modal portal comment — `packages/client/src/index.css:1230-1374`, `packages/client/src/components/ui/Modal.tsx:46-49`
- **Bump InstallModal close to 44px** (reuse `.iconbtn` or add `min-w/h-[44px]`) — `packages/client/src/components/ui/InstallModal.tsx:60-67`
- **Floor the transaction filter chips at 44px** (shared `.chip-filter` in the `pointer: coarse` rule) — `packages/client/src/views/WalletView.tsx:427-436`
- **Render the deposit minimum + fee-free line** (`wallet.minDepositHint`) — `packages/client/src/views/WalletView.tsx:296-359`
- **Render `auth.tagline` + trust chips on the landing screen** — `packages/client/src/views/AuthView.tsx:73-84`
- **Optimize/relocate oversized static assets** — move `logo.svg` out of `public/`, run `icon-512.png` through pngquant — `packages/client/public/`
- **Add responsible-gaming line to onboarding s3 body** — `packages/client/src/lib/i18n.ts:1003-1004`
- **Port the engine test to `node:test`** (`assert.ok(cond, name)`) for real failure diffs — `packages/engine/src/engine.test.ts`
- **Replace the flaky auth timing assertion** with a spy-hasher call-count probe — `packages/server/src/auth/authService.test.ts:91-109`
- **Add a CI guard that pg integration tests actually ran** (`if (process.env.CI && !process.env.DATABASE_TEST_URL) assert.fail(...)`) — `packages/server/src/money/pgConcurrency.test.ts:25-26`

I'll write the closing sections of the audit report based on the findings JSON.

## 6. Remediation Roadmap

### 🚨 Now (this week)

- **`correct-1` — Silent single-direction fund loss (HIGH):** Stop swallowing the DEFINITE-failure refund path in `withdrawals.ts:340-345`. Order `markReversed` after a successful refund credit (or drop the `.catch` and leave the row `completed` so `reconcileFailedWithdrawals` retries), and increment `settlementFailures` + log on error. A player can currently be left short with no backstop.
- **`money-1` — AML caps fail OPEN (MEDIUM):** Make the global/per-destination/transfer-in/prior-user cap reads (`walletRoutes.ts:295,309-315`) fail-closed like the transfer-out cap already does — force tier `manual` on any read error instead of defaulting the count to 0. These are the anti-drain controls; they must not evaporate on a DB blip.
- **`devops-1` — Trivy scan is report-only (HIGH):** Restore `exit-code: '1'` on both Trivy steps (`ci.yml:132,139`) before the GHCR push, use a time-boxed `.trivyignore` for the known pre-existing base CVE, and correct the false "only clean images reach the registry" comment.
- **`cro-1` — No 18+/Terms gate at signup (HIGH):** Add a required "I am 18+ and accept the Terms & Responsible-Gaming policy" checkbox gating the CREATE ACCOUNT button (`AuthView.tsx:108-130`) and persist acceptance (timestamp + terms version) server-side. Both a conversion-trust gap and a live compliance/liability exposure.
- **`websec-1` — Blind SSRF via push endpoint (MEDIUM):** Allowlist the push `endpoint` host/scheme (`accountRoutes.ts:34-37`) to https + the real FCM/Mozilla/WNS/Apple push hosts before persisting; reject private/loopback/link-local. Only latent until VAPID keys are set — close it before enabling push.

### 🛠️ Next (this sprint)

- **`db-1` / `perf-1` — Full-ledger reconcile scan (HIGH):** Replace `ledger.all()` in `reconcile()`/`matchLedgerSums()` with DB-side `groupBy` aggregates (the codebase already uses `sumByUserTypesSince` elsewhere) and batch the balance fetch to kill the N+1 `getBalance()`. This runs every 5 minutes on the live money host and grows unbounded.
- **`perf-2` — Treasury liability full-user scan (MEDIUM):** Swap the `listUsers().reduce()` (`app.ts:1196`) for `db.user.aggregate({ _sum: { balanceCents } })` — also fixes the silent truncation bug where liabilities are WRONG past 5000 users.
- **`perf-3` — Unscoped `lobby:state` fan-out (MEDIUM):** Scope broadcasts to a `LOBBY` socket room and coalesce to ~250-500ms; today every socket (including players mid-match) gets a full snapshot on every room churn.
- **`money-2` — Single-instance-only money guards (MEDIUM):** Add a startup leader-election advisory lock that refuses to serve money routes if a second replica is detected, or back the auto-payout budgets with a DB counter. Enforce the `replicas:1` invariant in code, not just ops convention.
- **`db-2` — Money `$transaction` default 5s timeout (MEDIUM):** Pass explicit `{ timeout: 15000, maxWait: 5000 }` and batch the per-payout ledger inserts; consider `connection_limit=2-3` so settlement doesn't starve reads.
- **`cro-2` / `cro-3` / `cro-4` — Landing/trust gaps (HIGH/MEDIUM):** Render the already-defined `auth.tagline`, add trust chips + a footer, ship static Terms/Privacy/Responsible-Gaming pages, and surface the unused `wallet.minDepositHint` + a "deposits are fee-free" line on the deposit tab.
- **`mobile-1` — Android Back double-fire (MEDIUM):** Make `useModalBack`/`useExitGuard` cooperative so one Back press closes only the top overlay instead of also nagging/leaving the table.

### 🌱 Later (backlog)

- **`arch-1` — Decompose `gateway.ts` (2637-line god class):** Extract `MatchStartCoordinator` + `SettlementCoordinator`; target no method >60 lines, gateway <1000 lines.
- **`arch-2` — Replace `row: any` Prisma mappers:** Adopt generated `@prisma/client` row types and route JSON columns through the existing `jsonValidators.ts`, starting with the wallet/ledger mappers.
- **`arch-3` / `arch-4` — Structured logging + composition-root split:** Introduce a pino logger via DI (remove the ~24 `no-console` suppressions); split `createGameServer` into `wireServices`/`registerRoutes`/`startBackgroundJobs`.
- **`authz-1` / `authz-2` — Admin hardening:** Gate global tournament creation behind an admin scope; add TOTP/WebAuthn MFA for admin/owner accounts.
- **`money-5` / `cro-6` — AML/RG follow-ups:** Set a non-zero default P2P transfer cap + received-funds hold before scaling; add 18+/responsible-gaming framing to the onboarding money step.
- **`tests-1` / `tests-2` — Test-surface gaps:** RTL coverage for WalletView/AuthView failure states; port the engine console harness to `node:test`.
- **Cleanup:** `mobile-2` (delete ~145 lines of dead force-landscape CSS), `mobile-3` (version the SW cache name), `db-3`/`db-4`/`db-5`/`db-6` (advisory-lock width, stats RMW, enum CHECKs, constraint-drift assertion), `correct-3`/`correct-4` (prune unbounded rate-limit Maps), `perf-4`/`perf-5`/`perf-6` (selector discipline, self-hosted fonts, drop the 1.7MB logo), `uiux-1`/`uiux-2`/`uiux-3` (tabpanel wiring, 44px chips, sq-default).

## 7. Final Verdicts

**Design/UX.** The in-product craft is excellent and above the bar for the category: accessibility is genuinely engineered (skip-link to a focusable landmark, real focus trap with restoration, `prefers-reduced-motion` honored in both CSS and JS, 44px touch floors, dual live-regions), the money flows are disciplined (in-flight guards, explicit confirm dialogs, honest fee math), and a coherent Obsidian-and-Gold token system with a WCAG-tuned contrast ladder ties it together. The gaps are top-of-funnel and touch-target polish — an incomplete tab pattern (`role="tab"` with no `tabpanel`), sub-44px filter/dismiss chips, English defaulting for an Albanian-first product, and a bare landing screen. None are severe and all are quick. **Verdict: Ready with fixes.**

**Security.** Auth/authz/session is genuinely strong (algorithm-pinned JWTs, `ver`-claim revocation checked at every boundary, atomic refresh-rotation with reuse-detection, Argon2id, per-email throttling, anti-escalation RBAC), web input handling is safe (Zod at every boundary, no raw SQL injection, no XSS sinks, HMAC-over-raw-body webhooks bound to recorded intents), and no critical broken-access-control or IDOR hole was found. The open items are one medium (blind SSRF via the push endpoint, latent until VAPID is set) plus low/info hardening (no admin MFA, unguarded global-tournament creation, CSP off at the API origin). The one operationally-serious security-adjacent item is `devops-1` — the disabled CVE gate — which is a deployment decision, not a code hole. **Verdict: Ready with fixes.**

**Technical.** The fundamentals are the best part of this codebase: exactly-once finalize by construction, a DB-enforced idempotent append-only ledger, atomic conditional balance writes that make overdraw impossible, clean package layering with a pure engine, a clean typecheck, and an exceptionally targeted test suite (conservation invariants, concurrency races, adversarial deposit/withdrawal scenarios, a real-Postgres CI suite). The launch-blocking technical risks are narrow but real and concentrated on the money hot path: the swallowed refund (`correct-1`) and the recurring full-ledger reconcile/treasury scans (`db-1`/`perf-1`/`perf-2`) that grow unbounded on a live single-replica host, plus the fail-open AML caps (`money-1`). These are all small, well-understood fixes. **Verdict: Launch-ready once the HIGH findings (`correct-1`, `db-1`/`perf-1`, `devops-1`) are closed — not before.**

**Business/Conversion.** This is the weakest dimension and the honest gate on paid traffic. The inner product is trustworthy and dark-pattern-free, but the first screen a paid visitor lands on has no value proposition, no social proof, no trust/legal signals, no Terms/Privacy links, and — critically — no 18+/terms gate, on a live real-money gambling product. Pouring paid acquisition into that funnel would burn spend on a landing page that reads as unfinished and carries compliance exposure. The fixes (`cro-1` through `cro-5`) are almost entirely wiring existing strings and adding a few static pages. **Verdict: Not ready for paid traffic until the signup age/terms gate and the landing trust layer ship.**

**Strongest part:** the financial-integrity core — the atomic, idempotent, conservation-checked money ledger and its exactly-once settlement, backed by adversarial and real-Postgres tests. **Weakest part:** the conversion/trust funnel — specifically the ungated, value-prop-less signup/landing experience.

## 8. Action Plan

### Immediate fixes (today)

- Fix `correct-1`: reorder refund→`markReversed` (or remove the `.catch`) so a failed withdrawal refund can never be silently lost; add a `settlementFailures.inc()` + loud log.
- Fix `money-1`: wrap the cap-read `Promise.all` in try/catch and force tier `manual` on any rejection; give `priorTodayCents` (`walletRoutes.ts:295`) the same treatment.
- Fix `devops-1`: restore Trivy `exit-code: '1'`, add a time-boxed `.trivyignore` for the known base CVE, correct the misleading push comment.
- Fix `cro-1`: add the required 18+/Terms checkbox to the register form and persist `acceptedTermsAt` + terms version server-side.

### 7-day plan

- Close `websec-1` (push-endpoint allowlist) before push is enabled.
- Land `db-1`/`perf-1` (SQL `groupBy` reconcile + batched balances) and `perf-2` (treasury `aggregate`, fixing the >5000-user truncation).
- Ship the landing trust layer: `cro-2` (render `auth.tagline` + trust chips + footer), `cro-3` (static Terms/Privacy/Responsible-Gaming pages), `cro-4` (deposit minimum + fee-free line via `wallet.minDepositHint`), `cro-5` (default `sq` / detect `navigator.language`, add an AuthView language pill).
- Fix `mobile-1` (cooperative Back handling) and add its regression test.
- Add `db-2` explicit `$transaction` timeouts and bump the pooler connection_limit.

### 30-day plan

- `money-2`: add the startup leader-election lock (or DB-backed auto-payout budget) so a second replica can't corrupt the anti-drain caps; document `replicas:1` as a hard invariant.
- `perf-3`: scope + coalesce `lobby:state` broadcasts.
- `arch-1`: begin the `gateway.ts` decomposition (extract the match-start and settlement coordinators).
- `arch-2`: convert the wallet/ledger Prisma mappers off `row: any` and route JSON through `jsonValidators.ts`.
- `authz-2`: add admin/owner MFA; `authz-1`: gate global tournament creation.
- `tests-1`/`tests-4`: RTL coverage for WalletView/AuthView failure states and an app-level test for the reconcile-sweep / graceful-drain refund path.
- `money-5`: set a non-zero P2P transfer cap + received-funds hold; track KYC threshold parity as a compliance blocker before opening new jurisdictions.

## 9. Launch Checklist

### iOS

- [ ] Verify safe-area insets on a real notched device (iPhone with Dynamic Island) — table root, modals, and on-felt Pas/Luaj buttons clear the notch in landscape.
- [ ] Confirm no input auto-zoom (16px input floor holds) while pinch-zoom stays enabled on deposit-address/amount/terms screens.
- [ ] Test "Add to Home Screen": correct cache-busted apple-touch-icon, name, and standalone launch (no Safari chrome).
- [ ] Validate wake-lock re-acquires after backgrounding and the Socket.IO transport revives on visibility/focus (frozen-transport kick).
- [ ] Confirm the forced-landscape "rotate your phone" overlay does not trap portrait-friendly money/KYC screens on iPad (`mobile-5`).
- [ ] Fix the 36px InstallModal close target to 44px (`mobile-4`).
- [ ] Bump the SW cache name so a new manifest/icon isn't served stale after deploy (`mobile-3`).
- [ ] Verify VoiceOver announces toasts (dual live-regions) and the deposit/withdraw confirm dialogs.
- [ ] Confirm the 18+/Terms gate (`cro-1`) renders and blocks signup on Safari.

### Android

- [ ] Fix and re-test the hardware-Back double-fire: one Back press closes a table-opened profile modal WITHOUT triggering the leave-table prompt (`mobile-1`).
- [ ] Verify the exit-guard still protects a staked match from silent abandonment via Back.
- [ ] Test PWA install (WebAPK): manifest icon/name correct, standalone display, splash.
- [ ] Confirm TalkBack announces toasts and money confirmations.
- [ ] Validate pointer-events hand interaction (tap-vs-drag 16px slop) on a range of screen sizes.
- [ ] Confirm wake-lock, haptics (reduced-motion gated), and keyboard-inset handling on the DM/chat composers.
- [ ] Verify the forced-landscape overlay behavior on a large phone / foldable.
- [ ] Confirm the 18+/Terms gate (`cro-1`) renders and blocks signup on Chrome.
- [ ] Bump the SW cache name and verify network-first navigation serves a fresh build after deploy.

## 10. What I did NOT cover

**Sampled vs fully reviewed.** The money core was reviewed in depth — `WalletService`/`MoneyService`/`withdrawals`/settlement, the Prisma repository money paths, the UnitOfWork, deposit attribution, and their tests were read closely and cross-checked. `gateway.ts` was read for the settlement/finalize paths but not every one of its 27 socket handlers was traced end-to-end. Auth, web-input, and DB-schema layers were reviewed broadly with representative deep-dives (e.g. `toUser`, the advisory-lock path, the webhook verifier); I did not read all ~35 Prisma mappers or every migration line-by-line. On the client, the money and auth views plus the accessibility/mobile primitives were reviewed closely; most of the 17 views and 42 components were sampled, not exhaustively read. Findings marked `confidence: inferred` (e.g. `correct-5`, `db-6`, `db-7`, `mobile-5`, `perf-5`, `cro-6`, `tests-4`) rest on code reading plus reasoning, not execution.

**What was blocked.** No live database access — I could not run the actual reconcile/aggregate queries, measure real ledger/table sizes, EXPLAIN the hot paths, or confirm which CHECK/FK constraints actually exist in production (`db-6` is precisely this blind spot). No device testing — every mobile/PWA finding (`mobile-1..5`, the iOS/Android checklist) is from source review, not a physical iPhone/iPad/Android handset; the Back-button double-fire, safe-area behavior, wake-lock, and install flows were reasoned from code, not observed. No Lighthouse/performance profiling — the perf findings are static analysis of algorithmic complexity and fan-out, not measured LCP/INP/TBT numbers or real load tests; the "hundreds of ms event-loop block" estimates are extrapolations, not benchmarks. No running instance — I did not exercise the live signup/deposit/withdraw funnel, so conversion findings are from reading the rendered components. No penetration testing — the SSRF, SSRF-adjacent, and auth findings were traced in code, not exploited against a running target. No dependency/CVE scan of my own — `devops-1` reports on the pipeline's disabled Trivy gate rather than an independent SCA I ran.

**What a deeper pass needs.** Live DB access to run the reconcile aggregates, measure real table growth, and assert the schema-invisible constraints; a real-device lab (notched iPhone, iPad, Android + foldable) to confirm the mobile/PWA findings and the launch checklist; a Lighthouse + load-test pass (settlement latency under the connection_limit=1 pooler, `lobby:state` fan-out under connection load) to turn the perf estimates into numbers; an independent SCA/container scan and a light pen-test of the SSRF/auth/webhook surfaces; and a full read of `gateway.ts`'s remaining handlers and every money-adjacent migration before treating the money path as fully cleared.

---
_Generated by a 12-dimension multi-agent audit with per-finding adversarial verification. Every finding cites file:line evidence; unverified items are labelled. No files or data were modified._
