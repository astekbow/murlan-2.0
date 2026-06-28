# Murlan Red-Team Report

> Authorized adversarial security audit (owner-requested). 55 agents across ~24 attack
> surfaces → 142 raw findings → 30 critical/high/exploitable verified adversarially → 28
> confirmed. Code-level threat-model (no live exploitation of production).

## Executive summary

Murlan's **core money math is genuinely well-built** and was not breakable: balances cannot be minted, double-spent, or overdrawn. Every debit is a single atomic conditional `UPDATE` (`balanceCents >= -delta`), every credit is idempotent on a DB-unique `providerRef` (`ON CONFLICT DO NOTHING`), settlement/rake/refund conserve to zero, deposit credits are bound to a server-recorded intent (never the webhook body), and game settlement is computed strictly from authoritative engine state. JWT signing, refresh-token rotation/reuse-detection, game-cheat surfaces (out-of-turn, card forgery, hidden-hand leakage), and SQL/XSS/CSRF surfaces all held up under probing.

The real risk concentrates in **two systemic gaps plus operator-config foot-guns**: (1) **access tokens are not revocation-aware** — a banned/suspended/logged-out user keeps full REST authority (including the cash-out path) for the access-token TTL (~15 min), because `verifyAccess` does no account-state or token-version check and the withdraw route is the one money endpoint that never re-checks account state; and (2) an **anti-escalation hole in admin RBAC** lets a scoped `manage_admins` admin mint a full money-powered admin. The single most urgent item is **closing the withdraw/REST account-state gap** (a banned fraudster can still pull funds), followed by the RBAC promotion fix. Two high-severity issues are *config-conditional* rather than code-default: the **claim-jackable legacy shared deposit address** (only if deployed without an xpub) and the **reverse-proxy IP collapse** that flattens all rate-limiting to one bucket (app-wide DoS + lost forensics). Compliance/AML controls on **P2P transfers** are intentionally absent (owner-acknowledged) and remain the largest non-code gap before scaling.

---

## 🔴 Confirmed Critical / High

### 1. Banned / logged-out / password-reset users keep full REST access — including the withdraw cash-out path — for the access-token TTL (`auth-jwt` / `account-state` / `session-revocation`)

**Impact:** A banned fraudster, a logged-out user, or a victim who just changed their password is *not actually cut off* from the HTTP API for up to ~15 minutes (default `ACCESS_TTL=15m`). They can keep reading wallet balance/history and other-user data, and — most dangerously — **submit a withdrawal**, debiting their balance into a pending payout the ban was meant to freeze. Small KYC-verified amounts can even auto-pay irreversibly on-chain.

*Exploit:*
1. Log in normally, capture the access token (a stateless JWT carrying only `{sub, username, type:'access'}` — no `ver`, no `jti`).
2. Get banned/suspended (admin or Telegram bot), or log out, or reset the password. All of these only bump `tokenVersion` (which gates the *refresh* path) and kick live sockets — none touch the already-minted access token.
3. Within the TTL, `POST /api/wallet/withdraw` (and `GET /api/wallet`, `/api/wallet/transactions`, `/api/auth/me`) with `Authorization: Bearer <still-valid-token>`. `requireAuth → verifyAccess` accepts it with no DB lookup, no `tokenVersion` check, no account-state check.

*Evidence:*
- `auth/tokens.ts:60-62` — `issueAccess` signs only `{username, type:'access'}`, no `ver` claim.
- `auth/tokens.ts:83-108` / `auth/authService.ts:489-496` — `verifyAccess` checks only signature/iss/aud/type; no DB/state lookup.
- `http/authRoutes.ts:49-63` — `requireAuth` returns immediately after `verifyAccess`.
- `http/walletRoutes.ts:159-216` — withdraw gates **only** on `deps.compliance?.enabled`; it never calls `auth.checkAccountRealMoney` (contrast deposit `walletRoutes.ts:137-138`, transfer `:111-114`, txid `:264` which all do).
- `auth/authService.ts:436-441` — `setAccountState → revokeAllSessions` bumps `tokenVersion` (refresh-only) + kicks sockets; comment at `:433` admits access tokens "lapse within their short TTL".
- The socket path *does* re-check via `auth.checkLogin` at `gateway.ts:223-227` — proving the team knew of the window for live play but left the REST money path unguarded.

*Fix:* Make access-token authorization revocation-aware. Preferred: add a `ver: user.tokenVersion` claim to `issueAccess` and have `requireAuth` resolve the user once per request and reject when `claims.ver !== user.tokenVersion` (mirror `refresh()`). At minimum, in `requireAuth` call `auth.checkLogin(userId)` after `verifyAccess` (the same cheap gate the socket layer already uses) so banned/suspended are blocked immediately, **and** add a state gate to the withdraw route. Note: `frozen` accounts are *intentionally* allowed to withdraw their own funds (`accountStateService.ts:11-13`), so gate on `checkLogin` (blocks banned + suspended only), **not** `checkRealMoney`. Also shorten `ACCESS_TTL` (2–5m) and validate its bound (`config.ts:24` has no upper limit).

---

### 2. Scoped `manage_admins` admin can mint a FULL admin (anti-escalation bypass) (`admin-rbac`)

**Impact:** Privilege escalation from a narrowly-scoped admin to a full admin with money powers — `adjust_balance`, `approve_withdrawals`, `void_matches`. Directly monetizable.

*Exploit:* A `permissions=['manage_admins']` admin registers a throwaway account, then `POST /api/admin/users/<altId>/role` `{"role":"admin"}`. The alt becomes `role='admin'` with `permissions=[]`, which RBAC treats as a **FULL** admin (`hasPermission([],…)===true`).

*Evidence:*
- `http/adminRoutes.ts:181-194` — `/role` guarded only by `requirePermission('manage_admins')` + self-demote guard; `setRole` with no anti-escalation check.
- Contrast `adminRoutes.ts:207-215` — the sibling `/permissions` route 403s a scoped admin trying to mint an empty/full list (tested `permissions.test.ts:106`). No equivalent for `/role`.
- `permissions.ts:41-44` — `hasPermission([], …)` returns `true`; new users default `permissions=[]`.

*Fix:* Apply the `/permissions` anti-escalation rule to `/role`: a scoped admin must not promote anyone to `admin`, or have `setRole('admin')` stamp a non-empty default permission set. Add a regression test.

---

### 3. Legacy single shared deposit address is claim-jackable — any user can steal another player's on-chain deposit (`money-deposit`) — *config-conditional*

**Impact:** Direct theft of other players' real-money deposits. **Only reachable if deployed with `TRON_DEPOSIT_ADDRESS` set and no `TRON_DEPOSIT_XPUB`** (legacy foot-gun config).

*Exploit:* Shared-address mode → `resolveDepositAddress()` returns the same address for everyone. Victim sends USDT; attacker grabs the victim's TxID off TronScan and `POST /api/wallet/deposit/txid` first; `verify(txId, myAddress)` passes (same address) and credits the **attacker**.

*Evidence:* `http/walletRoutes.ts:231-237,276,298` (binds verify to the shared address, credits `caller.userId`, never references `v.from`); `walletService.ts:142-161` + `schema.prisma:253` (first-submitter-wins, `providerRef` `@unique` with no user component); `config.ts:51` labels it "claim-jackable"; boot guard only `console.warn`s (`app.ts:520,550-551`).

*Fix:* Refuse to start (or hard-disable the TxID routes) in production when `TRON_DEPOSIT_ADDRESS` is set without `TRON_DEPOSIT_XPUB`.

---

### 4. Reverse-proxy chain destroys the real client IP — all IP-keyed rate-limits collapse to one bucket (`headers-transport`)

**Impact:** App-wide DoS from a single IP (everyone shares one rate-limit bucket → 300 req/min from one source 429s *everyone*), and all IP logging records the proxy's IP — crippling abuse attribution.

*Evidence:* `deploy/nginx.conf:29,42` uses `proxy_set_header X-Forwarded-For $remote_addr;` (replaces, not `$proxy_add_x_forwarded_for`); `app.ts:172` global `rateLimit` with no `keyGenerator` (keys on `req.ip`); `config.ts:76` trusts RFC1918 → `req.ip` resolves to Caddy's container IP for every external request.

*Fix:* `$proxy_add_x_forwarded_for` in nginx; set `TRUST_PROXY` to the exact hops; add a `keyGenerator` on the resolved client IP; add a two-IP test. (Also re-enables the payment-webhook IP allowlist, currently unenforceable.)

---

## 🟡 Medium

### 5. P2P transfers have no KYC / daily cap / velocity limit / hold (`money-transfer`, owner-acknowledged)
AML / fund-mule / chip-dumping / collusion cash-out + responsible-gaming-limit bypass (money is still conserved — not theft of others' funds). Single mutual-accept is the only gate; floor $1, ceiling $1M/call, no aggregate cap. *Fix:* per-user daily transfer cap + velocity limit, run the compliance gate (esp. self-exclusion, #6), track net-transferred-in as a withdrawal-review signal, consider a clearing hold. `walletRoutes.ts:97-124`, `walletService.ts:222-223`.

### 6. Self-exclusion is NOT enforced on P2P transfers (`account-state`)
A self-excluded player can shuffle their balance to a confederate. `/api/account/self-exclude` sets `selfExcludedUntil` but does not freeze; the transfer route never calls `compliance.checkRealMoney` (unlike deposit/txid/shop/staked gate). *Fix:* run the compliance gate for the sender in the transfer route. `accountRoutes.ts:106-117`, `complianceService.ts:62-64`.

### 7. Daily auto-payout cap has a TOCTOU race and is off by default (`money-withdraw`/`money-race`) — *conditional on auto-payout enabled*
Concurrent sub-threshold withdrawals each read `priorTodayCents≈0` (computed in a detached un-awaited async, after row creation, no lock) → each auto-pays, bypassing the 24h ceiling. Doesn't mint money (each backed by a real atomic debit) but defeats the anti-drain/structuring control. *Fix:* classify inside the withdrawal transaction or take a per-user advisory lock; make the daily cap mandatory when auto-payout is on. `walletRoutes.ts:183-208`, `withdrawalPolicy.ts:33`, `config.ts:44-45`.

### 8. Responsible-gaming daily DEPOSIT cap has no DB backstop — bypassable under multi-instance (`money-race`) — *latent (single replica today)*
`serializeDeposit` is a per-process Map; the cap reads a SUM then writes at READ COMMITTED. Breaks the moment a 2nd replica runs. (The deposit *credit* itself is multi-instance-safe; only the cap check isn't.) *Fix:* SERIALIZABLE tx with retry, or a per-user advisory lock. `walletService.ts:95-101,148-153`.

### 9. Demoted/banned admin keeps admin REST powers for the access-token TTL (`session-revocation`)
A *banned* rogue admin still passes `requireAdmin` (checks only `role==='admin'`, no `checkLogin`, no token version) for the TTL. Role *demotion* is reflected live; account-state is the gap. *Fix:* `checkLogin` in `requireAdmin`/`requirePermission`; combine with #1. `authRoutes.ts:67-79`.

### 10. TELEGRAM_WEBHOOK_SECRET is exempt from the prod secret-strength check (`telegram-bot`)
The webhook secret is the sole auth boundary for the bot's money commands; it's not length/placeholder-checked like the other prod secrets. Medium (not high): bot is opt-in, no weak default ships, `.env.example` instructs a long random string — requires deliberate misconfig. *Fix:* add it to the prod fail-closed list when the bot is enabled. `config.ts:147-155`, `telegramRoutes.ts:29-39`. (The compare itself is already constant-time.)

---

## 🟢 Low / Hardening

- **Money routes have no per-route rate limit** — `/transfer`, `/withdraw`, `/deposit/txid` inherit only the loose global 300/min/IP. No theft; the lever is burning the TronGrid verify quota. *Fix:* tight per-route limits keyed by `userId`.
- **Self-demotion guard on `/role` trivially bypassable** — two admins can demote each other / the owner. Insider griefing, not money. *Fix:* protect the `ADMIN_EMAIL` owner; log+alert.
- **Single admin can redirect a tournament final prize** — `TOURNAMENT_DUAL_CONTROL` off by default; `reportResult` validates the winner is a finalist, not who won. Audited. *Fix:* enable dual-control with a 2nd admin.
- **Unbounded per-user ledger read** (`listByUser`, no `take`) on `/wallet/transactions`, `/account/export` — self-inflicted heap/pool pressure (indexed + self-scoped, not cross-tenant). *Fix:* cursor pagination + `take`.
- **Periodic reconcile loads the whole transactions table every 5 min** (`ledger.all()`). *Fix:* SQL `GROUP BY SUM`.
- **Unauthenticated socket flood → 2 uncached DB reads per (re)connect.** *Fix:* connection-rate guard + short account-state cache.
- **User-enumeration timing oracle** on `/forgot-password` + login (bounded by per-IP throttle). *Fix:* fire-and-forget email; constant-time dummy verify.
- **Password-reset token not invalidated when a newer one is requested** (older link valid for its 1h TTL). *Fix:* invalidate prior un-consumed tokens.
- **No "log out all devices" control.** *Fix:* self-service `revokeAllSessions`.
- **Config foot-guns:** non-constant-time `METRICS_TOKEN` compare; `/metrics` RFC1918 fallback; `TRUST_PROXY=true` would enable IP spoofing; cookie `Secure` gated only on `NODE_ENV`; `CLIENT_ORIGIN` defaults to localhost; unauthenticated `/api/client-errors` + `/api/replay/:matchId` (no auth/pagination); suspension `durationMs` has no `.max()`.

---

## ✅ Defended well (probed, found solid — do NOT worry about these)

- **Core money integrity / double-spend.** Atomic conditional `UPDATE` (`balanceCents: { gte: -delta }`) — overdraw + concurrent double-spend impossible under READ COMMITTED and across instances. Transfers compose debit+credit in one `$transaction`. Verified vs `pgConcurrency.test.ts`.
- **Idempotent credits.** Dedup on `@unique` `providerRef` with `INSERT … ON CONFLICT DO NOTHING`; delta applied only on `created=true` — replay/retry/webhook+poller races credit at most once.
- **Settlement conservation.** Engine-derived winner/stake/rake; `sum(payouts)+rake === pot` exactly; forfeiters structurally excluded; negative/overflow rejected.
- **Deposit forgery.** Exact-contract check, `tx.to !== dest` rejection, integer decimal math, intent-binding (webhook userId/amount from the recorded intent, not the body). *(Exception: legacy shared-address, #3.)*
- **JWT signing & refresh tokens.** HS256 with explicit `algorithms` allowlist + iss/aud (no alg-confusion); prod fail-closed on weak/equal secrets. Refresh tokens rotate, single-use, family-revoked on reuse, version-pinned. **The weakness is entirely the *access* token (#1), not refresh.**
- **Game-cheat surfaces.** Seat resolved server-side from the authenticated `userId` (no seat in payloads); engine re-validates ownership + combo legality every move; private hands only to the player's personal room; win/settle/void server-internal; provably-fair shuffle commits `serverSeed` before client seeds.
- **Authorization / IDOR.** Wallet, friends, club, tournament, realtime actions derive identity from the verified token + enforce membership/role server-side.
- **SQL injection.** Only 3 raw queries, all constant strings; no `$executeRaw`/`Prisma.raw`, no mass-assignment, no orderBy/limit injection.
- **XSS / CSRF.** No DOM-injection sink in the SPA (React text nodes, zero `dangerouslySetInnerHTML`); outputs escaped/plain-text. Money/admin endpoints are Bearer-header (CSRF-immune); the lone cookie is `HttpOnly + SameSite=Strict`.
- **Boot fail-closed guards.** Prod refuses to start with placeholder/short/equal secrets, missing compliance flags, bare stub providers, missing DB, no real deposit rail. No secrets logged.
- **Telegram bot money path & socket limits.** Bot reuses the audited idempotent `withdrawals.payoutNow`; Socket.IO enforces 16KB frames, ping/connect timeouts, per-user token buckets, join-code bucket, spectator cap, one-room-per-user.

---

## Top fixes (do first)

1. **Make access-token auth revocation-aware (#1, #9).** Add `ver: tokenVersion` to `issueAccess`; in `requireAuth` resolve the user + reject on mismatch + `checkLogin`. Same `checkLogin` gate in `requireAdmin`/`requirePermission`. Shorten + bound `ACCESS_TTL`.
2. **Gate the withdraw route on account state (#1).** `auth.checkLogin(caller.userId)` at the top of `POST /api/wallet/withdraw` (blocks banned/suspended, allows frozen).
3. **Close the RBAC promotion hole (#2).** Block scoped admins from promoting to `admin` (or stamp a non-empty default); add a regression test.
4. **Refuse legacy shared-address deposit mode in prod (#3).** Require `TRON_DEPOSIT_XPUB` for any TxID-credit path.
5. **Fix the proxy IP chain (#4).** `$proxy_add_x_forwarded_for`, exact `TRUST_PROXY`, rate-limit `keyGenerator`, two-IP test.
6. **Serialize the auto-payout cap + make the daily cap mandatory (#7).**
7. **Add P2P transfer AML controls + self-exclusion gate (#5, #6).**
8. **Add `TELEGRAM_WEBHOOK_SECRET` to the prod strength check (#10).**
9. **Back the deposit cap with a DB lock before multi-replica (#8).**
10. **Hardening sweep:** per-route money rate limits, ledger pagination + SQL-aggregate reconcile, reset-token invalidation, timing-oracle equalization, "log out all devices," config foot-guns.

---

*Generated by a 55-agent adversarial red-team (24 attack surfaces → verify → report). Code-level threat model; production was not attacked live.*
