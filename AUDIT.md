# Murlan Online — Full Production-Readiness Audit

> Generated 2026-06-01 by a 14-area multi-agent audit (51 agents, ~2.3M tokens, 728 file reads).
> Every page, every button, and the whole-project logic (rules, money, realtime, security) were reviewed,
> then every falsifiable finding was adversarially re-verified against the real code.
> **100 findings survived verification; 0 were refuted as false positives.**

## Verdict

**NOT production-ready for real money — but the hard core is genuinely strong.**

What's solid (verified):
- **Rules engine + match state machine are correct and well-tested** (43 server + 47 engine assertions pass).
  The KEY RULE (all-pass → winner leads → ANY valid combo), power order, combos, trick resolution, opening "3",
  target/extension, and the card switch all behave correctly.
- **Money is integer cents end-to-end** with a proven conservation/reconcile invariant, idempotent credits on a
  UNIQUE providerRef, atomic conditional decrement on withdraw, and an inFlight/status lock preventing double-pay.
- **Gateway is server-authoritative** with per-seat hand redaction (no card leaks).
- **Provably-fair commit/reveal is cryptographically sound and un-grindable.**
- No money-minting, double-spend, negative-balance, hand-leak, or auth-bypass hole was confirmed in the
  intended single-process happy path.

What blocks launch: several confirmed defects break real gameplay/money safety today, and whole categories
required for a licensed real-money launch are entirely missing (real payments, durable fair audit, admin
audit trail, KYC binding, email verify/reset, security headers, error boundary).

---

## 🔴 Blockers (confirmed — fix before any real-money use)

1. **Client never refreshes the 15-minute access token.** 15m after login every REST call 401s and any socket
   reconnect fails the handshake permanently — in a live match this runs out the abandon grace timer and the
   player **loses their stake**. A valid 7-day refresh cookie exists but is never used; the server's `auth`
   re-auth socket event is never emitted.
   `api.ts:33-50`, `authStore.ts:60-69`, `socket.ts:9-18`, `gameStore.ts:137-146`, `gateway.ts:104-119,203-217`

2. **No crash-recovery sweeper.** A mid-match server crash leaves the Postgres match row `active` with stakes
   debited into escrow and no live room to ever settle/refund — funds stranded forever. No startup/periodic job
   scans `matches WHERE status='active'`.
   `moneyService.ts:130-184`

3. **escrow/settle/refund are NOT atomic** despite the header claiming they must be. `settle()` does one
   `$transaction` per winner + one for rake (a 2v2 settle = 4 independent commits). A crash between them pays
   some winners but not others, with no rollback.
   `moneyService.ts:8-13,143-159,172-179`

4. **Self-excluded users are blocked from withdrawing their own funds** (responsible-gaming violation).
   `walletRoutes.ts:67-76`, `complianceService.ts:63`

5. **No admin audit trail.** Balance adjustments + KYC changes record no acting admin, IP, cap, or second
   approver — the #1 fraud/AML control is absent.
   `adminRoutes.ts:55,67`, `walletService.ts:172-177`

6. **Malformed socket payloads throw inside handlers → ack never fires → client stalls 8s.** Untrusted input
   (`game:play/pass/switchGive`, `room:join`) is forwarded straight into the engine with zero validation and no
   try/catch.
   `gateway.ts:240,289-303`, `roomManager.ts:232-251`, `singleGame.ts:328-343`

7. **`room:create` does not validate `type`** → an invalid type creates an undismissable 0-seat zombie room
   that can never be left or joined and pollutes the lobby forever.
   `roomManager.ts:120-135`, `gateway.ts:228-242`

8. **Provably-fair seeds are never persisted.** They live only in memory; the Prisma `Game` model exists but no
   code writes it. A restart/missed reveal destroys all audit data — deals become unverifiable, contradicting
   the "retained for auditing" claim.
   `gateway.ts:75,468,663-669`, `schema.prisma:169-185`

9. **No real payment provider** — only `MockPaymentProvider`; PayPal is advertised in the UI but unimplemented.
   No real funds can move in or out.
   `paymentProvider.ts`, `walletRoutes.ts:97-124`, `WalletView.tsx:90`

---

## 🟠 High priority

1. **Refresh tokens are stateless** — logout doesn't kill the session; a stolen/old refresh token stays valid
   7 days; no rotation/reuse-detection; no per-user `tokenVersion` to force-logout a banned/self-excluded user.
2. **Concurrent forfeit + normal-end both finalize the same match** → duplicate `match:end`, double cosmetic XP,
   loser emit can overwrite the result with `payoutCents=null`. (Money stays safe; overlay + XP corrupt.)
3. **Presence ref-count leak** — N tab opens = N adds but 1 remove, so users show online forever after closing
   all tabs.
4. **Block-friend feature entirely missing** (spec requires add/accept/remove/**block**); declined requests are
   hard-deleted so a harasser can re-request with no cooldown.
5. **No React error boundary** — a render throw or a failed lazy-chunk import (common after a deploy) white-screens
   the whole app with no recovery.
6. **No security-header middleware** (no `@fastify/helmet`) — no HSTS/CSP/frameguard/noSniff.
7. **Compliance fields (DOB/country) are freely mutable** and never locked after KYC — age/geo gating sits on
   self-asserted data.
8. **Ready-check countdown is frozen** (never ticks down).
9. **Game-1 forced-lead (on timeout) relies on "3♠ is the weakest single" coincidence** rather than being
   opening-aware.

---

## 🟡 Medium priority

- Card-switch winner can return the **exact card just received**, nullifying the loser's penalty (rule-fidelity).
- Stale lobby/room balance — the "Pa fonde" gate never refreshes after a deposit.
- `onLeave` frees room membership only after the async forfeit settles → instant re-create hits "already_in_room".
- Deposit endpoint enforces **no min/max**; oversized intents become un-creditable after the user has paid.
- Deposit intents never expire/prune — a stale/replayed event can credit an old intent.
- Non-transactional `buy()` races → XP double-spend / duplicate cosmetic grant.
- Card-back cosmetic is effectively **invisible to its buyer**.
- Auth rate limit is per-IP only and generous; no per-account lockout/backoff.
- No in-flight guard on money + gameplay buttons (double-submit / double-tap → spurious red toast).
- Friends list + notifications never auto-refresh and aren't durable.
- No configurable stake policy (min/max/whitelist), unvalidated at the socket boundary.
- `uiStore.view` leaks across sessions on the same tab (new user can land on wallet/shop).
- Turn timer is hidden during the card-switch window even though the server auto-resolves + accrues an idle strike.
- Forfeit **win** shows a red "opponent left" error toast over the victory overlay.
- `respond` (friend) endpoint always returns `ok:true` and coerces garbage `accept` into a decline.
- Per-player client seeds aren't published in the reveal.
- No tab-close / navigate-away warning during a live paid match.

## ⚪ Polish (selected)

Login validation (`required`/`minLength`, `new-password`); distinguish "no session" vs "server unreachable";
quick-match create-on-fall-through only for room-full/not-found + cancel search; remove dead "Shiko" button;
prune `selected` on pass; **delete dead `SwitchPrompt.tsx`**; popover a11y (role=menu/dialog + focus); de-dupe
invite UX; persist user settings server-side; validate `id` on buy/equip; offline-aware play/pass; friendly 429;
2v2 team-select/host-kick UI; leaderboard pagination.

---

## Production roadmap (ordered)

1. **Stop the bleeding (client session):** 401→refresh→retry + proactive refresh + socket re-auth on reconnect;
   React error boundary + lazy-chunk retry. *(Difference between "app works" and "app dies after 15 min".)*
2. **Money durability & atomicity:** wrap escrow/settle/refund each in one transaction; crash-recovery sweeper;
   flip `room.status='finished'` synchronously before the settle await in both finalization paths.
3. **Continuous money invariants:** scheduled `reconcile()` + match-ledger-sum checks with operator alerting.
4. **Server input hardening:** boundary validation + try/catch on all socket handlers; validate type/team/stake;
   `maxHttpBufferSize`; reject the 0-seat zombie-room path.
5. **Real payments:** real provider (deposit + withdrawal rails), hardened webhook, deposit min/max + intent TTL.
6. **Compliance & responsible gaming:** allow self-excluded withdrawals; bind age/geo to verified KYC + lock
   DOB/country; deposit limits, cool-off, per-jurisdiction velocity limits.
7. **Auth & session security:** stateful refresh store w/ rotation+reuse-detection+revocation; `tokenVersion`;
   periodic socket re-validation; pin JWT alg/iss/aud; login lockout + CAPTCHA; `trustProxy`; strong secrets.
8. **Admin governance:** persist acting-admin + reason + timestamp on every adjustment/KYC change; caps + dual-approval.
9. **HTTP hardening:** `@fastify/helmet`; secure/SameSite cookies; rate-limit rewards/shop/friends; atomic `buy()`.
10. **Provably-fair for real money:** persist Game rows; publish per-player seeds + combine rule; durable public
    `GET /fair/match/:id` verification endpoint; real client-side verifier wired to the "fair" badge.
11. **Gameplay/rule fidelity:** card-switch can't hand back the just-received card + hand-size post-conditions;
    opening-aware forced lead; confirm scoring/extension tables against an authoritative Murlan source.
12. **Social & abuse:** block/unblock; chat moderation + mute/report; neutralize username enumeration; durable notifications.
13. **Realtime robustness:** fix presence symmetry; resolve room membership synchronously on leave; exempt
    `room:leave` from rate limiter; re-deliver switch state on reconnect; document the single-instance constraint
    (timers/idleStrikes/fairByRoom/presence are per-instance) before horizontal scaling.
14. **UX & polish:** ticking countdown; balance refresh on entry + after forfeit; `beforeunload` guard mid-match;
    in-flight button guards; differentiate forfeit-win toast; reset `uiStore.view` on logout; switch-timer countdown.
15. **Pre-launch gates:** email verification + password reset (absent today); tests for concurrent-buy double-spend,
    claim idempotency, restart-mid-match fair verifiability, crash-recovery settlement; external security +
    compliance review; jurisdiction licensing/legal sign-off before accepting real funds.
