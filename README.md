# Murlan Online

Real-time, multiplayer web implementation of the Albanian card game **Murlan**, playable
for real money (crypto / PayPal). Authoritative server, provably-fair shuffle, an immutable
money ledger, and a mobile-first table. UI text is Albanian; code/comments are English.

> ⚠️ **Compliance:** taking a rake on real-money games makes the operator a gambling
> business, which in most jurisdictions (Albania included) requires a **license, age
> verification, and KYC/AML**. The system ships the switches for KYC, age gating,
> geo-restrictions and responsible-gaming controls (see `Compliance` below); enabling
> them and obtaining a licence is a **legal requirement, not optional polish**.

## Monorepo layout

```
packages/
  engine/   # pure rules core — the single source of truth (provided, 47 tests)
  shared/   # shared TS types: Socket.IO events, DTOs, rule predicates
  server/   # Fastify + Socket.IO + money + provably-fair + compliance (authoritative)
  client/   # React + Vite + TailwindCSS + Zustand
```

## Prerequisites

- Node.js ≥ 22 (developed on Node 24)
- npm (workspaces)

## Install

```bash
npm install
```

## Develop

```bash
# Terminal 1 — game server (http://localhost:3000)
npm run start --workspace @murlan/server      # or: npm run dev --workspace @murlan/server

# Terminal 2 — web client (http://localhost:5173, proxies /api + /socket.io to :3000)
npm run dev --workspace @murlan/client
```

Copy `.env.example` → `.env` and set secrets (required in production).

## Test & typecheck

```bash
npm test                 # all workspaces (engine 47 + server + client)
npm run test:engine      # rules engine
npm run test:server      # server (game, match, sockets, money, fair, compliance)
npm run typecheck        # tsc --noEmit across packages
npm run build --workspace @murlan/client   # production client bundle
```

## Run with Docker

```bash
docker compose up --build
# client → http://localhost:8080 , server → http://localhost:3000
```

## Architecture highlights

- **Authoritative server.** Clients send *intentions*; the server validates every move
  with `@murlan/engine` (`validatePlay`) and broadcasts results. Clients are untrusted.
- **No hidden-information leaks.** A client only ever receives its own hand plus opponents'
  card *counts*. Card identities are addressed to a player's own socket; the card-switch
  reveal is redacted per non-participant seat.
- **Provably-fair shuffle (§8).** Per match the server commits `hash(serverSeed)`; each
  game is dealt from `HMAC_SHA256(serverSeed, clientSeed:nonce)` fed into `engine.shuffle`.
  After the match `serverSeed` is revealed so any player can recompute & verify every deal.
- **Money is integer USD cents.** Every balance change is atomic and writes a row to an
  immutable `transactions` ledger that reconciles with balances; webhooks credit
  idempotently on the provider's payment id. Stakes are escrowed into a pot at match start;
  the winner takes `pot − rake` at the end. Mid-match abandon = reconnection grace then
  forfeit (pot to the other side).
- **Compliance switches (§13).** `ComplianceService` gates real-money actions (staked match
  start, deposits) on KYC / age / geo / self-exclusion — all **off by default**, enabled via
  env (`KYC_REQUIRED`, `MIN_AGE`, `GEO_BLOCKED_COUNTRIES`, `RESPONSIBLE_GAMING`).
- **Anti-cheat.** Server-authoritative legality + logging of rejected moves, per-user socket
  rate limiting, turn timers (auto-pass / forced legal lead), idempotent webhooks.

## Database (Prisma / PostgreSQL)

The server runs on **in-memory** repositories by default (great for dev/tests, no DB
needed). Set `DATABASE_URL` to switch to **PostgreSQL via Prisma** — the
`packages/server/src/db` adapters implement the same repository interfaces, so no
service code changes. Schema: `packages/server/prisma/schema.prisma` (spec §11).

```bash
# after setting DATABASE_URL (e.g. postgres://murlan:murlan@localhost:5432/murlan):
npm run db:generate --workspace @murlan/server   # generate the Prisma client
npm run db:migrate  --workspace @murlan/server   # apply prisma/migrations/0001_init
```

## Production notes / remaining follow-ups

- Prisma/Postgres persistence is **implemented** (opt-in via `DATABASE_URL`). The one
  remaining hardening is wrapping the WalletService credit/debit *pair* (ledger row +
  balance) in a single `prisma.$transaction` so the two writes are atomic under DB
  failure — the in-memory store is already effectively atomic (documented at the
  `WalletService` / `MoneyService` boundaries). Per-game seeds can be persisted to the
  `games` table so a reveal survives a process crash.
- The Socket.IO **Redis adapter** activates when `REDIS_URL` is set (multi-instance fan-out);
  authoritative room state is single-instance until the store is externalised.
- Payment providers sit behind a `PaymentProvider` interface with a deterministic mock;
  a real provider (NOWPayments / Coinbase Commerce / PayPal) is a drop-in implementation.

## Build phases (all complete)

1. Engine integration · 2. Single-game state machine · 3. Match layer (scoring, target-T,
card switch) · 4. Server + Socket.IO (rooms, lobby, auth, live play, reconnection) ·
5. Frontend (lobby + table, 3 layouts, animations) · 6. Money (wallet, ledger, webhook,
stake/pot/rake, admin, withdrawals) · 7. Provably-fair shuffle, anti-cheat, deployment,
compliance switches.
