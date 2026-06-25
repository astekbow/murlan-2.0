# Security Red-Team — 2026-06-25

Adversarial security/correctness audit of the **live real-money** Murlan codebase.
Method: a 519-agent workflow — 77 probe agents (subsystem × attacker-lens, static code analysis,
read-only) → each crit/high/med finding adversarially verified by 2 independent skeptics
(prosecutor + defender) to kill false positives. **221 findings → 177 confirmed → ~24 distinct issues**
(the cross-product surfaced each bug from many angles). Raw output:
`tasks/wc90jqypv.output` (302 KB JSON, in the session temp dir).

Severity legend: 🔴 crit · 🟠 high · 🟡 med. "votes" = how many of 2 verifiers confirmed real+exploitable.

---

## ✅ FIXED

### Batch 1 — commit `ad5da6b` (4 crit + 2 high)
1. 🔴 **Admin self-approve own withdrawal** (`withdrawals.reject`/`payoutNow`). No `caller ≠ owner`
   check → a scoped `approve_withdrawals` operator could approve their own payout. Guard added at the
   service layer (covers HTTP + Telegram). *Note: a solo owner now cannot self-approve — needs a 2nd admin.*
2. 🔴 **room:join private-room bypass** (`roomManager.joinRoom` + gateway). Sequential room ids +
   no `private` gate let anyone with a guessed id walk into a private staked game. Added a server-side
   `invited` allow-list (set by `onInvite` + `onJoinByCode`); tournament/clubwar keep their own gate.
3. 🔴 **ClubWar cancel on a running war / by the opponent founder** (`clubWarRoutes` + `clubWarService.cancel`).
   The challenged club's founder could void a war going against them (refund drain), and cancel raced
   `settle()` into a double-pay. Cancel is now `registering`-only **and** challenger-(A)-founder-only.
4. 🔴 **ClubWar settle/save non-atomic double-pay** (`clubWarService.reportResult`). Now persists
   `status='finished'` **before** moving money; payout is split out + idempotent (safe to re-run).
5. 🟠 **TronGrid deposit not confirmation-gated** (`tronDeposit.fetchTransfers`). Added `only_confirmed=true`
   so an unconfirmed/reverted transfer can never be credited.
6. 🟠 **Withdrawal destination stored untrimmed** (`walletRoutes`). A padded address passed request-time
   validation then failed payout-time validation → stuck. Now stored trimmed.

### Batch 2 — commit `915eec0` (2 high)
7. 🟠 **Club War had no real-money/RG gate** (`clubWarRoutes`). Frozen/banned/self-excluded/over-loss-cap
   players could buy in. Now runs `checkRealMoneyAccess` (same gate as tournaments/shop) on paid
   create + register; buy-in bounded to $10k/player (was unbounded/NaN-coercible).
8. 🟠 **In-game `chat` bypassed mute + sanitizer** (`gateway`). A globally-muted user could still chat and
   text skipped profanity/length/control-char cleaning. Routed through `chat.isMuted` (shadow-mute) +
   `sanitizeChat`.

### Batch 3 — commit `bffdfa4` (1 high + 3 med)
9. 🟠 **Prisma `addXp` non-atomic** — read-modify-write lost an increment under concurrency. Now an atomic
   DB-side `{ increment }` (delta clamped ≥0; spending uses `xpSpent`, never a negative addXp).
10. 🟡 **p2p transfer daily-cap failed OPEN** (`walletRoutes`) — a ledger hiccup (`.catch(()=>0)`) bypassed
    the AML cap. Now fails CLOSED (503).
11. 🟡 **Password length uncapped** (`authService`) — Argon2id DoS. Capped at 128 (register/login/reset).
12. 🟡 **`onReady`/`onClubWarPlay` raw ack + no guard/limit** — TypeError crash on omitted ack; `onClubWarPlay`
    also lacked a payload guard + rate limit. Now `safeAck` + type-guard + rate-gate.

### Batch 4 — commits `3bcd2b3` (sweep) + `e88eb8a` (RBAC)
13. 🟠 **ClubWar stale-sweep** — abandoned/stuck wars stranded buy-ins (after cancel was restricted).
    `sweepStaleWars` refunds abandoned wars / finishes stuck-decided ones (idempotent), on the sweep timer.
14. 🟡 **RBAC scope gaps** — financial/PII read endpoints used the bare `admin` guard. Now scoped:
    `/users`→manage_accounts, `/users/:id/transactions`→manage_accounts (`__house__`→view_revenue),
    `/withdrawals`→approve_withdrawals, `/chat-reports`→moderate_chat. (Full admin passes all; only scoped sub-admins restricted.)

### Batch 5 — commit `71482d7` (2 med)
15. 🟡 **Block-unblock authz** — a BLOCKED user could delete the block edge via unfriend and un-block
    themselves. `remove()` now refuses `status:'blocked'` rows (both repos); blocks lift only via `unblock()`. +test.
16. 🟡 **Rate-limits** — `GET /users/search` (30/min/IP, enumeration + DB scan) + `POST /auth/refresh`
    (stricter login limiter, refresh-token brute-force).

### Batch 6 — commit `b3af916` (1 high + med cluster)
17. 🟠 **Reward/shop claim TOCTOU** — concurrent claims of the same reward double-granted (XP/cosmetic/charge).
    New `withUserLock` serializes claimDaily/Challenge/DailyQuest/WeeklyQuest/LevelReward/VipGift + the
    real-money `buy()`. +concurrency regression test. (`buyXp` already deducts+grants in one atomic op.)

### Batch 7 — commit `7201750` (med)
18. 🟡 **DM anti-spam** — `POST /api/dm/:id` per-IP rate-limited (40/min); `lobby:list` raw-ack crash guarded;
    DM unread badge map filtered to CURRENT friends (an unfriended sender no longer lingers/leaks).

### Verified FALSE POSITIVES (re-checked against the real code — no change needed)
- **"Shuffle seed leak"** — `serverSeed` is correctly withheld until match-end reveal in BOTH the HTTP
  endpoint and the socket; `clientSeed` alone (the player's own public contribution) can't reconstruct a deal.
- **"No admin self-credit guard"** — `checkAdjustGovernance` already blocks crediting your own account.
- **"Dual-control is a no-op"** — intentional stub kept OFF so the solo owner isn't locked out (documented in the policy).
- **"Admin self-DEBIT not blocked"** — intentional + explicitly tested: self-debit LOSES money (no fraud gain).
  Self-CREDIT (the actual fraud) IS blocked. Left as-is by design.

---

## ⏳ REMAINING (marginal — single-host)
- 🟡 **`leaderboard:watch/unwatch` flood + admin ledger pagination** — cheap in-memory / read ops; low
  impact. *Fix:* light per-user gate on the watch loop + `LIMIT` the admin `/users/:id/transactions` + revenue reads.
- 🟡 **Username search / public profile reveal a blocker** (you can infer someone blocked you by their
  absence). Marginal — the DM-unread leak is already filtered (batch 7).

## 🧊 DEFERRED — infra / needs migration (NOT exploitable on current single-host deploy)
- 🔴/🟠 **Multi-instance double-pay races** — tournament/clubwar `cancel`+`finish`/`register` use **in-process**
  locks; two instances could double-settle. The deploy is **single-host Docker today**, so not currently
  exploitable. *Fix before horizontal scaling:* optimistic `version` column (migration) + `SELECT … FOR UPDATE`
  / `pg_advisory_xact_lock` in the settlement transactions. Same root for `moneyService.inFlight` (cross-process).
- 🟠 **UoW atomicity** — withdrawal `reject`/`autoPayout` refund ordering, ClubWar `register`/`settle`, shop
  `buy` move money then write status/grant without a single transaction. Mitigated (idempotent refs + ordering
  in batch 1), but a crash mid-step can strand (not double-pay). *Fix:* thread `UnitOfWork` through these paths + tests.
- 🟠 **Login throttle in-memory** (`authService`) — resets on restart / not shared across instances; owner
  email lockable by anyone who knows `ADMIN_EMAIL`. *Fix:* move throttle to DB/Redis; don't lock by known email.
- 🔴 **`tools/tron-scan.mjs` prints private keys in plaintext** — *operator recovery tool, not server-reachable.*
  *Fix:* never print keys to stdout (write 0600 file / use a hardware wallet). Add a warning header.

---

*Generated by the red-team workflow; each item carries a file:line + fix in the raw output. Fix order:
Batch 3 (shuffle-seed first) → Batch 4 → infra cluster (with the next DB migration).*
