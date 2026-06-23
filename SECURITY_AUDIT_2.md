# Murlan Deep Red-Team Report — Real-Money Platform
**Date:** 2026-06-23 · **Scope:** full surface (~109 probes, 218 agents) · **Method:** fan-out probing + adversarial per-finding verification against source · 426 raw → 108 verified → 106 confirmed

## Executive summary

Murlan's **core money correctness is solid**: balance debits are an atomic conditional UPDATE (no overdraw race), credit idempotency rests on a UNIQUE `providerRef` + ON-CONFLICT-DO-NOTHING (no double-credit), settle/refund use deterministic idempotency keys + status-guarded transitions (no double-pay), and on-chain deposit attribution is bound to per-player xpub addresses (claim-jacking closed). **Every one of the five recent hardening fixes held up** under deeper probing on the surface it targeted — *except the access-token-revocation fix, which was only applied to REST and is bypassed on the WebSocket plane* (a genuine regression-class gap, SOCKET-1/AUTH-2/AUTH-7/AUTH-9, same root cause).

The **biggest residual money risk is the withdrawal/auto-payout subsystem**: a confirmed **CRITICAL double-pay** when an operator clicks "Approve" on an already-auto-sent (stranded-pending) withdrawal (the system's own alert text tells them to), plus two **HIGH** double-pay races. The **second theme is AML/responsible-gaming**: P2P transfer has no cap/velocity/self-exclusion gate and, with the per-user-only auto-payout cap, forms a mule-ring fan-out. The **third theme is the admin RBAC boundary**: scoped admins can ban/neuter/demote the owner via `/account-state` and `/permissions` (the owner guard exists only on `/role`).

Most "HIGH" items are insider/operator/multi-instance-conditional rather than anonymous-attacker-reachable; the genuinely no-precondition externally-reachable holes are narrower (token-in-URL reset leak, private-club joinCode IDOR, spectate IDOR, replay leak). The money is **not currently being silently drained**, but the withdrawal double-pay vectors and the AML rails are real and should be closed before/while live.

---

## 🔴 Confirmed Critical / High

### CRITICAL — Auto-paid (pending) withdrawal + operator Approve = double-pay (money-16)
**Impact:** Direct, unrecoverable double-spend (on-chain USDT sent **and** in-app balance refunded). The system's own operator guidance triggers it.
*Exploit:* A tier-`auto` withdrawal auto-sends crypto while the row is still `pending`; if the 3 `approve()` retries all hit a transient DB error the row stays `pending` and the alert says "U dërgua, por shënoje Approve te paneli". The operator clicks Approve → `payoutNow` re-sends → Binance dedupe-rejects (non-2xx) → collapsed to `{ok:false}` → treated as failure → **refund + markReversed**. Reconciler ignores Binance status 6, never repaired.
*Evidence:* autoPayout.ts:57-69; adminBot.ts:82; adminRoutes.ts:382; binancePayout.ts:137; withdrawals.ts:243-249; paymentMonitor.ts:51-53.
*Fix:* Parse Binance's duplicate-order code → `{ok:false,duplicate:true}` (mark completed, no refund). Better: claim the row before `provider.payout()` so panel Approve sees not-pending; replace "click Approve" with a mark-paid-only action.

### HIGH — Auto-payout sends crypto BEFORE claiming the row → concurrent reject double-pays (money-13)
*Exploit:* `autoPayout.ts` calls `provider.payout()` first, marks complete after; an out-of-band reject during the seconds-long send window flips pending→rejected + refunds while the crypto is on-chain. (payoutNow claims-first; the auto path omits it.)
*Evidence:* autoPayout.ts:57-72 vs withdrawals.ts:231; reject refund withdrawals.ts:195-199.
*Fix:* `setStatusIfPending(id,'completed')` BEFORE the send; if claim fails, don't send; idempotent refund via `withdrawal_refund:<id>`.

### HIGH — Ambiguous Binance failure refunds a payout that actually succeeded (money-17)
*Impact:* On a timeout/5xx where Binance already queued the withdrawal, `payoutNow` refunds + markReversed → player keeps crypto AND balance. (Admin-gated; loss class real.)
*Evidence:* binancePayout.ts:128-143 (single-shot, no timeout, collapses 4xx/5xx/throw); withdrawals.ts:234-249; paymentMonitor.ts:51-53.
*Fix:* tri-state `{ok:false,ambiguous:true}` → leave row completed + alert; AbortController timeout; reconciler confirms SUCCESS rows.

### HIGH — Socket handshake ignores tokenVersion → logout-all / reset doesn't revoke the realtime session (auth-2/7/9, socket-1) ⚠️ REGRESSION
*Impact:* After logout-all / password-reset on a leaked token, a thief keeps a live authorized socket (staked play, hand data) for ~15m and can open fresh sockets. The token-revocation fix was REST-only.
*Evidence:* gateway.ts:232/280/408 (verifyAccess, `ver` discarded) vs authService.ts:545; revokeAllSessions never calls disconnectUser.
*Fix:* resolve user + reject on `ver` mismatch in handshake + onReAuth; `disconnectUser` from `revokeAllSessions`; bust the 3s handshake cache on a version bump.

### HIGH — Scoped admin can ban/suspend the owner via /account-state (+ /kyc) (admin-1/3)
*Impact:* A `manage_accounts` scoped admin bans `ADMIN_EMAIL` → revokes owner sessions → locks owner out permanently (survives restart).
*Evidence:* adminRoutes.ts:162-183 (no owner guard, contrast /role :206-211); same on /kyc :150-160.
*Fix:* centralize `isProtectedOwner`, apply on /account-state + /kyc; exempt owner in checkLogin.

### HIGH — Scoped/peer admin can strip the owner's powers via /permissions (admin-1/2)
*Impact:* Any admin overwrites the owner's `permissions=[]` (full) with a narrow scope; recovery needs DB surgery (boot resets role only).
*Evidence:* adminRoutes.ts:223-245; app.ts:604-615.
*Fix:* mirror the /role owner guard on /permissions; forbid writing perms onto an admin holding scopes the caller lacks; reset owner perms to [] on boot.

### HIGH — Manual balance-adjust uncapped, no dual-control, self-target allowed (admin-6)
*Impact:* One admin (or stolen token / over-scoped support) credits up to **$20M/call**, repeatedly, to self, then withdraws; negative deltas wipe balances. Telegram /credit /debit is a 2nd uncapped surface.
*Evidence:* adminRoutes.ts:51,132-148; walletService.ts:267-272; adminBot.ts:431-451.
*Fix:* bound deltaCents to a small ceiling; per-admin 24h cumulative cap; dual-control above a threshold; block self-target; same for Telegram.

### HIGH — Tournament money actions bypass RBAC scopes + single-admin result override (authz-7, admin-4)
*Fix:* gate /report /confirm /cancel behind `requirePermission`; reconcile manual /report against the recorded room outcome; four-eyes on manual finals.

### HIGH — Public replay endpoint leaks the redacted tribute card of a LIVE match (authz-8)
*Impact:* The winner's deliberately-hidden card-switch return card + full live move-log of an in-progress staked/ranked match is served by unauthenticated `GET /api/replay/:matchId` — a cheating edge.
*Evidence:* gateway.ts:1467-1480 vs 609/651-657; replayRoutes.ts:30-46 (no finished gate).
*Fix:* gate `actions` (≥ the switch cards) behind a finished/`revealed` check.

### HIGH — Mule fan-out defeats the per-user auto-payout cap (no global ceiling) (money-7)
*Impact:* The daily auto-payout cap is per-user only; N funded accounts auto-cash-out N×cap/day. Amplified by uncapped P2P. (Conditional on auto-payout enabled.)
*Fix:* global rolling-24h auto-payout budget (DB aggregate) → manual on breach; per-destination-address cap; treat recently-`transfer_in` funds as manual-tier; velocity gate on first-deposit-to-cashout.

### HIGH — P2P transfer is an uncapped, self-exclusion-bypassing AML rail (money-4/6)
*Impact:* `/transfer` never calls `compliance.checkRealMoney`, so self-exclusion/KYC/geo aren't enforced on either party; no daily cap/velocity/hold; $1M/call. (Self-exclusion bites only when responsibleGaming is on.)
*Evidence:* walletRoutes.ts:147-176 (gates only checkAccountRealMoney); contrast deposit :192-196.
*Fix (cheapest high-value):* run `compliance.checkRealMoney` on BOTH parties; add a DB-enforced per-user 24h cap + velocity; KYC/hold above a threshold.

### HIGH — Production ships ws@8.20.1 (GHSA-96hv-2xvq-fx4p memory-exhaustion DoS) (deps-1)
*Fix:* `npm audit fix` to ws ≥8.21.0; `npm ls ws`; nginx per-IP connection limits.

### HIGH — Reset/verify token delivered in URL query string (auth-4/11) *(verifier→medium)*
*Impact:* The single-use reset secret rides in `?resetPassword=` → browser history, nginx access logs, same-origin Referer to the API. (Strict referrer policy + CSP narrow it.)
*Fix:* deliver via URL fragment (`#resetPassword=`); synchronous `replaceState`; don't log query strings.

### HIGH — Settle/refund not gated on status-transition row count (money-18) *(latent — multi-instance only)*
*Impact:* On a 2nd instance, a settle + a refund can both commit (~2× pot drain). Not reachable on the current single host.
*Fix:* status transition authoritative inside the tx (`updateMany` first, throw on count===0, or SELECT…FOR UPDATE).

---

## 🟡 Medium (selected)
- Admin manual credit of an unclaimed Binance deposit has no providerRef → a later player TxID claim double-credits the same deposit (money-2). *Fix:* accept the TxID on /adjust → `tron:<txid>`, or track claimed TxIDs.
- Scoped `manage_admins` can demote every other full admin (only owner protected) (admin-1/2).
- Privileged action + audit record not atomic (admin-5); Telegram support_resolve swallows the audit error.
- `GET /api/clubs/:id` leaks private-club roster + joinCode to any authenticated non-member → joinByCode (authz-4).
- Spectate IDOR — `room:spectate` has no privacy gate on private/ranked/tournament rooms (socket-5/6).
- Telegram OR-based auth (chat.id OR from.id) + group-chat misconfig makes every group member a money admin (telegram-2/3). *Fix:* authorize on from.id only; reject group chat ids at boot.
- MAX_AMOUNT_CENTS ($20M) > int4 ceiling → a credit on a >$1.47M balance aborts the tx (money-22). *Fix:* lower to ~$1M or BigInt.
- HOUSE rake `getBalance()` always 0 → treasury masks a rake siphon (money-23).
- Avatar data-URL validated by prefix only, not magic-bytes (authz-2) — latent stored-XSS.
- /metrics fails open to loopback when METRICS_TOKEN unset + server published on 127.0.0.1:3000 (infra-6).
- TRUST_PROXY: no fail-closed guard against `=true`/blank in prod (infra-8).
- Unbounded `listByUser`/reconcile on hot paths + uncapped P2P row-bloat → O(ledger) money ops (db-6, dos-2).
- Refresh rotation non-atomic (find→revoke) → concurrent replay mints two sessions without tripping family revocation (auth-3).
- Bundled Postgres `murlan:murlan` + hardcoded backup creds (infra-3/5) — loopback-bound today.
- Unbounded club member list + N+1 (dos-1).

## 🟢 Low / Hardening (selected)
P2P no daily cap/velocity (owner-acknowledged) · login throttle fixed-window non-escalating + in-memory · no throttle on forgot-password/verify-request (mail-bomb) · registration enumeration oracle · public profile unauthenticated (biggestPot exposed) · custom JSON parser bypasses proto-poisoning guard (no sink today) · Engine.IO handshake bypasses Fastify rate-limit · fair:clientSeed entropy-suppressible (no advantage) · support ticket listByUser unbounded · 2v2 collusion chip-feeding · unpinned base images · owner-protection silently off if ADMIN_EMAIL unset.

## ✅ Verified solid (probed deeply — don't worry)
- Balance double-spend / overdraw — atomic conditional UPDATE; no negative balance.
- Credit idempotency — UNIQUE providerRef + ON CONFLICT DO NOTHING; TxID lowercased both paths.
- Settle/refund/withdraw-resolve — deterministic providerRefs + status-guarded CAS; single-instance race-safe (multi-instance caveat = money-18).
- On-chain claim-jacking — bound to caller's xpub address; legacy shared address refuses to boot. **Deposit-address fix held.**
- Webhook intent-binding — credit from recorded intent, never the body; HMAC + anti-replay.
- **REST access-token revocation — `ver !== tokenVersion` enforced on every guarded route. Fix held on REST** (gap is socket-only).
- Quitter/forfeit/void — excluded from winners; void permission-gated, audited, refund-only.
- JWT alg pinning (HS256 allowlist); prod refuses placeholder secrets.
- Engine integrity — combo/ownership/turn-order/conservation; non-sticky pass; no force-win.
- Provably-fair commit-reveal — serverSeed committed before clientSeeds, fresh per match; unbiased Fisher-Yates.
- Hands secrecy — private hands only to personalRoom; public DTO counts-only.
- No SQL injection (Prisma everywhere; the one $queryRawUnsafe is a static literal); no mass-assignment; no ReDoS.
- Client — token in memory only; no DOM-XSS sinks; strict CSP; no secrets/sourcemaps in bundle.
- CSRF — token-in-header (CSRF-immune); refresh cookie httpOnly+SameSite=Strict; CORS exact origin.
- **nginx XFF append — forged X-Forwarded-For can't move req.ip. Proxy-IP fix held.**
- **Per-user withdraw serialization closes the auto-pay cap race single-instance. Withdraw-race fix held.**

## Top fixes (do first)
1. **Withdrawal double-pay (money-16/13/17):** claim the row before `provider.payout`; distinguish Binance duplicate / ambiguous (timeout/5xx) from definite failure so `payoutNow` never refunds a sent payout; AbortController timeout; replace "click Approve" with mark-paid-only. **Live unrecoverable money loss.**
2. **Socket tokenVersion (auth-2/7/9, socket-1):** thread `ver` into handshake/onReAuth + reject on mismatch; `disconnectUser` from `revokeAllSessions`. Closes the regression.
3. **Admin owner-protection (admin-1/2/3):** `isProtectedOwner` on /account-state, /kyc, /permissions; forbid scoped/peer demotion of full admins; reset owner perms to [] on boot.
4. **adminAdjust governance (admin-6):** bound deltaCents; per-admin 24h cap; dual-control above threshold; block self-target; same on Telegram.
5. **P2P transfer compliance + caps (money-4/6):** `compliance.checkRealMoney` on both parties; DB-enforced daily/velocity cap; transfer_in funds → manual-tier.
6. **Auto-payout global ceiling (money-7):** DB-aggregate 24h global budget + per-destination cap → manual on breach; require positive DAILY_AUTO_WITHDRAW_CAP_CENTS when auto-pay is on.
7. **Tournament RBAC + result reconciliation (authz-7, admin-4).**
8. **Replay/spectate/club IDORs (authz-8, socket-5, authz-4).**
9. **Reset token out of URL (auth-4/11).**
10. **ws bump (deps-1).**

---

*Generated by a 218-agent deep adversarial red-team (109 attack surfaces → adversarial verify → report). Code-level threat model; production was not attacked live.*
