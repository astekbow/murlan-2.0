# Multi-instance (horizontal scaling) — readiness & roadmap

**Status: the app runs ONE `server` replica by design** (`docker-compose.deploy.yml` pins `replicas: 1`;
`RUNBOOK.md §8`). This doc is the evidence-based map of *exactly* what is and isn't safe under 2+ instances,
so the eventual scale-out is a deliberate, staged project — not a flag flip. It was produced by a code audit
on 2026-06-28 (every claim below was traced to a file).

## TL;DR

- **The money layer is ALREADY multi-instance-safe.** Deposits, settlement, refunds, rake, and the deposit
  cap cannot double-pay or double-credit across instances (idempotent `providerRef` + `pg_advisory_xact_lock`).
  See [Money safety](#money-safety-already-correct).
- **The game layer is NOT.** Authoritative match state, room ownership, timers, fairness seeds, matchmaking,
  and tournament pairing are all per-instance in-memory. Two instances would corrupt live matches.
- **`REDIS_URL` today only wires the Socket.IO adapter** (cross-instance broadcast). It shares **no**
  application state. The boot log already warns about this when `REDIS_URL` is set.
- **The linchpin fix is one thing: a Redis-backed `RoomOwnership`.** The interface seam already exists
  (`realtime/roomOwnership.ts`); only the no-op `InMemoryRoomOwnership` is wired. Almost every game-integrity
  hazard below resolves once exactly one instance owns each room and sockets are routed to the owner.
- **Why it's still deferred:** it's an L-effort distributed-systems change on a LIVE money app. Done wrong it
  corrupts live matches. `replicas: 1` is the correct guard until it's built *and* verified.

## Money safety (already correct)

| Mechanism | Why 2+ instances can't break it |
|---|---|
| Deposit crediting | `wallet.credit(providerRef)` → `ledger.appendIdempotent()` = `INSERT … ON CONFLICT DO NOTHING` against `transaction.providerRef @unique`. A duplicate/concurrent webhook from another instance returns `created=false` → balance **not** adjusted. Ledger insert + balance update share one `$transaction`. |
| Deposit **cap** | `credit()` takes `pg_advisory_xact_lock(hashtext('deposit:<userId>'))` inside the same tx **before** summing deposits-today → two concurrent capped deposits for one user serialize **across** instances (not just in-process). The in-process `depositChain` Map is now redundant belt-and-suspenders. |
| Settle / refund / rake | Deterministic refs (`payout:<m>:<seat>`, `rake:<m>`, `refund:<m>:<seat>`) + status-guarded atomic transition (only acts on a `status='active'` row, flipped in the same tx). At-most-once regardless of instance. The in-process `MoneyService.inFlight` Set is an optimization, not the safety mechanism. |

**The one money-adjacent multi-instance bug:** `MoneyService.recoverOrphanedMatches` sweeps using
`rooms.activeMatchIds()` — the **local** live set. Under 2 instances, instance B doesn't see instance A's
live matches, so B would treat A's actively-playing matches as orphaned and **refund them mid-game**. It's
idempotent (no *double*-refund), but it's a wrongful refund of a live pot. **This must be fixed first** in
any scale-out (cross-instance live set, or only the owning instance sweeps its own rooms).

## State inventory (what breaks under 2+ instances)

`game-integrity` = corrupts a live match · `money-safety` = touches funds · `perf-only` = degraded UX, nothing corrupts.

| State | File | Kind | Category | Corrupts? | Fix | Effort |
|---|---|---|---|---|---|---|
| Authoritative match state (rooms/seats/engine) | `room/roomManager.ts` | in-process | game-integrity | **yes** | Gate create/join/play on a RoomOwnership claim; route sockets to the owner | L |
| `RoomOwnership` (the seam) | `realtime/roomOwnership.ts` | in-process | game-integrity | **yes** | Implement Redis-backed claim (`SET NX` + TTL + heartbeat; pub/sub-synced local cache so `isForeign` stays sync); inject instead of `InMemoryRoomOwnership` | L |
| `recoverOrphanedMatches` sweep | `money/moneyService.ts` | in-process | **money-safety** | **yes** | Cross-instance live set, or only the owner sweeps its rooms | M |
| Turn / abandon / countdown timers | `realtime/timerOrchestrator.ts` | in-process | game-integrity | **yes** | Only the owning instance arms a room's timers (falls out of ownership) | M |
| Fairness seeds (commit/reveal) | `realtime/fairnessCoordinator.ts` | in-process | game-integrity | **yes** | Co-located with ownership — only the owner commits/reveals | M |
| Tournament pairing dedup + no-show | `realtime/tournamentMatchRegistry.ts` | in-process | game-integrity | **yes** | Drive each tournament from a single owner (leader lock per `tournamentId`), or a DB unique constraint on the pairing | M |
| Rematch offers + timers | `realtime/rematchCoordinator.ts` | in-process | game-integrity | **yes** | Co-located with ownership | S |
| Matchmaking queues | `realtime/matchmaking.ts` | in-process | game-integrity | yes (fragments) | Redis sorted-set per type + atomic Lua pop, or one owner | M |
| Periodic schedulers (sweeps, alerts, token purge) | `app.ts` | mixed | money-safety | no* | Run on a single elected leader (Redis lock); *DB parts are idempotent/status-guarded, but duplicate operator **alerts** fire per-instance | M |
| Deposit poller + watch registry | `money/depositPoller.ts` | mixed | money-safety | no | Elect a single poller, or back the watch registry with Redis (crediting is idempotent on `tron:<txId>`, so only wasteful, not unsafe) | M |
| Presence (online set) | `realtime/presence.ts` | in-process | perf-only | no | Redis set (SADD/SREM + expiry), or query the Socket.IO adapter | S |
| HandshakeThrottle | `realtime/handshakeThrottle.ts` | in-process | perf-only | no | Redis window (`INCR`+`EXPIRE`) for a global cap (revocation gate is ver-aware, so no stale OK) | S |
| RateLimiter (token buckets) | `util/rateLimiter.ts` | in-process | perf-only | no | Redis token bucket if a global cap matters | S |
| Spectator counts | `realtime/spectatorRegistry.ts` | in-process | perf-only | no | Resolves once spectators route to the owner | S |

## Roadmap (ordered)

1. **Fix `recoverOrphanedMatches`** so it can never refund another instance's live match (the only money-adjacent corruption). Do this even as a defensive measure.
2. **Redis-backed `RoomOwnership`** + **sticky-by-room** socket routing. This is the linchpin: it resolves room state, timers, fairness, rematch, and spectators in one stroke (they all co-locate with the owner).
3. **Leader-elected schedulers** (Redis lock) so sweeps/alerts/pollers run once cluster-wide.
4. **Redis-backed matchmaking + presence** (UX correctness, not safety).
5. Only then raise `replicas` above 1 — behind a load test that asserts no cross-instance match divergence.

Until step 5 is done **and** verified, keep exactly one `server` container.
