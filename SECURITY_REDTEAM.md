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

---

## ⏳ REMAINING — Batch 3 (clear, single-host, mostly small)
- 🟠 **Shuffle seed leak (potential cheat)** — `fairRoutes:30` exposes `clientSeed` and `gateway:2082`
  emits `serverSeed` for **live unrevealed** matches. A player who reads them could compute the deal.
  *Fix:* never expose seeds for a match until it's revealed/finished. **VERIFY then fix — highest remaining priority.**
- 🟠 **Prisma `addXp` non-atomic** (`prismaRepositories.ts:266`) — read-modify-write loses/duplicates XP
  under concurrency. *Fix:* `update({ data: { xp: { increment: n } } })`.
- 🟡 **Rewards/shop claim TOCTOU** (`rewardsService` claimDaily/Challenge/Quest/Level/VipGift, shop `buy`) —
  double-XP / double-cosmetic / double-debit under concurrent calls. *Fix:* per-user serialize + atomic DB guards.
- 🟡 **p2p transfer-cap ledger error treated as zero** (`walletRoutes:195`) — fail-open. *Fix:* fail-closed.
- 🟡 **Password field no max-length** (`authService:28`) — Argon2id CPU DoS. *Fix:* cap at ~128 chars in the zod schema.
- 🟡 **Missing per-route rate limits + socket `safeAck`** — `/auth/refresh`, `/users/search`, `/api/dm/:id`,
  admin `/users/:id/transactions` + revenue (also unbounded ledger scans), `lobby:list`, `clubwar:play`,
  `leaderboard:watch`; `onClubWarPlay`/`onReady` miss `safeAck` (TypeError crash when ack omitted). *Fix:*
  add per-route limits + paginate the admin ledger reads + `safeAck` on those handlers.

## ⏳ REMAINING — Batch 4 (authz / leaks, moderate)
- 🟡 **RBAC scope gaps** (`adminRoutes`) — any `admin` (no specific scope) can list all users + PII, all
  pending withdrawals, any user's full tx ledger, the house rake ledger (`/users/__house__/transactions`),
  and chat-reports. *Fix:* gate each on its scope (`manage_accounts`/`approve_withdrawals`/`view_revenue`/`moderate_chat`).
- 🟠 **Admin governance** (`adminAdjustPolicy` + `adminRoutes`) — `ADJUST_DUAL_CONTROL` is a **no-op**; no
  self-credit guard; an admin can credit another admin; the owner's balance is adjustable; Telegram
  account-state path skips `isProtectedOwner`. *Fix:* enforce dual-control or block self/admin-to-admin/owner adjusts.
- 🟡 **Friends/block leaks** (`socialRoutes` + `prismaRepositories`) — `remove()` deletes block rows (a
  blocked user can lift their own block); username search + public profile reveal blockers/blocked;
  FK-error user-existence oracle on block. *Fix:* separate block deletion from unfriend; filter blocked from search.
- 🟡 **DM unread endpoint leaks historical sender ids** (`dmService:68`) without a friendship guard. *Fix:* filter to friends.
- 🟠 **ClubWar has no stale-sweep** (`clubWarService`) — buy-ins stranded in a crashed/stuck `running` war
  (now that user-cancel is `registering`-only). *Fix:* `sweepStaleWars(maxAge)` mirroring `tournament.sweepStale`
  (idempotent re-decide/refund), wired to a periodic timer.

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
