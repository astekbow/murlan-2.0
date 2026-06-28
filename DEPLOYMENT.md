# Murlan Online — Deployment & Operations Runbook

Operational guide for running the real-money stack in production. Pairs with `README.md`
(dev setup) and the current audits — `AUDIT_REPORT_2026-06-26.md` (engineering) + `SECURITY_REDTEAM.md`
(security); older snapshots are archived under `docs/audits/`. **Read the Compliance note in the
README first — a license + KYC/AML are legal prerequisites for real-money operation.**

> ⚠️ **PARTIALLY SUPERSEDED — the files are authoritative, not this prose.** The real production deploy
> is **`docker-compose.deploy.yml`**, run via **`deploy/redeploy.sh`**. That stack bundles **its own
> Postgres + a `db-backup` container** and a **Caddy** service that fronts the `client` container
> (`reverse_proxy client:80`, see `deploy/Caddyfile`) — there is **no Supabase**, and no manual
> `127.0.0.1:8080` Caddyfile, in the live topology. **Payments are on-chain USDT-TRC20 HD-wallet
> deposits + Binance/NOWPayments payouts — NOT Stripe/PayPal.** The current day-to-day operational
> guide is **`RUNBOOK.md`**. Where anything below disagrees with those files, **the files win**; this
> document is kept for the conceptual walkthrough (architecture, env vars, scaling).

---

## 0. Quickstart — single-host deploy (one VPS, Docker)

This app deploys as **one stack on one host**: the client (nginx) is the only public
service; it proxies `/api` + `/socket.io` to the server over the internal Docker network.
**It is NOT a Vercel/serverless app** — the server is a long-running Socket.IO (WebSocket)
+ Postgres service. Any host with Docker works (a VPS, or a Docker-capable PaaS).

**1. Prereqs on the host:** Docker + Docker Compose, a domain pointed at the host, ports 80/443 open.

**2. Create `.env`** (next to `docker-compose.yml`):
```bash
# Strong, unique, ≥32 chars each (e.g. `openssl rand -base64 48`):
JWT_ACCESS_SECRET=<random-48+>
JWT_REFRESH_SECRET=<different-random-48+>
PAYMENT_WEBHOOK_SECRET=<random>
CLIENT_ORIGIN=https://yourdomain.com        # your real public URL (HTTPS)
# Compliance — set each deliberately (prod refuses to boot if any is unset):
KYC_REQUIRED=false
MIN_AGE=0
GEO_BLOCKED_COUNTRIES=
RESPONSIBLE_GAMING=false
# DEMO/STAGING WITHOUT payment+email integration → true (mock deposits, emails to logs).
# For a REAL-money instance: leave false and wire the real rails first — on-chain USDT-TRC20
# deposits (TRON_DEPOSIT_XPUB) + Binance/NOWPayments payouts + an SMTP provider.
ALLOW_STUB_PROVIDERS=true
# Optional persistence (else in-memory). If set, run migrations FIRST (see §4):
# DATABASE_URL=postgres://murlan:murlan@postgres:5432/murlan
```

**3. TLS is required** (auth cookies are `secure`/HTTPS-only in production). The production
`docker-compose.deploy.yml` **already includes a Caddy service** that auto-provisions Let's Encrypt
and proxies to the client container — its `deploy/Caddyfile` is simply:
```
yourdomain.com {
  reverse_proxy client:80
}
```
(`client:80` is the container on the internal Docker network — NOT `127.0.0.1:8080`.) If instead you
run Caddy on the host outside Compose, point it at the published client port. Cloudflare Tunnel or your
own nginx+certbot work too. Plain HTTP works for a quick look but login won't persist (secure cookie).

**4. Launch:**
```bash
docker compose up --build -d      # client→:8080 (Caddy fronts it on 443), server+postgres+redis internal
docker compose logs -f server     # watch for "listening … (production)" + the ALLOW_STUB_PROVIDERS warning
```
Visit `https://yourdomain.com`. To go real-money later: wire real providers, set `ALLOW_STUB_PROVIDERS=false`,
set `DATABASE_URL` + run migrations, and work through §9 (pre-launch checklist).

---

## 1. Architecture at a glance

```
            ┌──────────────┐      /api, /socket.io       ┌─────────────────────┐
  browser → │ nginx (SPA + │ ───────────────────────────→│ game server (Fastify │→ Postgres (Supabase)
            │  reverse px) │                              │  + Socket.IO, tsx)   │→ Redis (Socket.IO adapter)
            └──────────────┘                              └─────────────────────┘
```
- **client** — static Vite/React bundle served by nginx (`Dockerfile.client` → `deploy/nginx.conf`).
- **server** — Fastify + Socket.IO, run via `tsx` (`Dockerfile.server`). Authoritative for all game
  state and money. In-memory repos unless `DATABASE_URL` is set, then Prisma/Postgres.
- **Redis** — only needed to scale Socket.IO across multiple server instances (see §7).

---

## 2. Environment variables

| Var | Required (prod) | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | — | `development` | set `production` |
| `PORT` / `HOST` | — | `3000` / `0.0.0.0` | server bind |
| `CLIENT_ORIGIN` | yes (CORS) | `http://localhost:5173` | the client's public origin |
| `JWT_ACCESS_SECRET` | **yes** | — | **≥32 random chars; NOT a placeholder** (fail-closed, see §3) |
| `JWT_REFRESH_SECRET` | **yes** | — | **≥32 random chars, different from access** |
| `PAYMENT_WEBHOOK_SECRET` | **yes** | — | **≥32 chars** |
| `ACCESS_TTL` / `REFRESH_TTL` | — | `15m` / `7d` | token lifetimes |
| `DATABASE_URL` | yes (for persistence) | — | Supabase **pooled** (port 6543, `?pgbouncer=true&connection_limit=1`) |
| `DIRECT_URL` | yes (migrations) | — | Supabase **direct/session** (port 5432) — used only by `prisma migrate` |
| `REDIS_URL` | only if scaling >1 instance | — | enables the Socket.IO Redis adapter |
| `RAKE_BPS` | — | `1000` (10%) | house rake, basis points |
| `TURN_MS`/`COUNTDOWN_MS`/`ABANDON_MS` | — | `30000`/`3000`/`30000` | timers |
| `KYC_REQUIRED`/`MIN_AGE`/`GEO_BLOCKED_COUNTRIES`/`RESPONSIBLE_GAMING` | per jurisdiction | off | compliance switches (§13 of spec) |
| `REWARDS_ENABLED` | — | `true` | XP/cosmetic rewards on/off |

Generate secrets: `openssl rand -hex 32` (one per JWT secret + webhook). **Never reuse the
access/refresh secret. Never commit `.env`** (it's git-ignored and excluded from the Docker image).

---

## 3. Secret safety (fail-closed)

- In `NODE_ENV=production`, the server **refuses to boot** if any JWT/webhook secret is missing,
  shorter than 32 chars, a known placeholder (`change-me-*`, `dev-*`), or if the two JWT secrets
  match (`packages/server/src/config.ts`). A misconfigured deploy crash-loops instead of running
  with forgeable tokens — that is intended.
- `docker-compose.yml` uses `${VAR:?…}` so Compose itself errors out if a secret is unset.
- `.env` is in both `.gitignore` and `.dockerignore` — it is never committed or baked into an image.

---

## 4. Database & migrations

```bash
# Apply all pending migrations (uses DIRECT_URL). Run BEFORE starting the new server version.
npm run db:migrate --workspace @murlan/server      # = prisma migrate deploy
# Generate the client (also part of the Docker build):
npm run db:generate --workspace @murlan/server
```
- Migrations live in `packages/server/prisma/migrations/` and are applied in order. They are
  **forward-only** (`migrate deploy`); review each `migration.sql` before a destructive change.
- Connection pooling: the app uses the Supabase **transaction pooler** (`connection_limit=1` in the
  URL). Tune per instance count; migrations use the **direct** connection.
- **Backups:** rely on Supabase PITR/automated backups; verify a restore quarterly. The money ledger
  is the source of truth — never edit `transactions`/`matches` rows by hand.

---

## 5. Build & run (Docker)

```bash
# Provide secrets via the environment (or an .env file Compose reads):
export JWT_ACCESS_SECRET=$(openssl rand -hex 32)
export JWT_REFRESH_SECRET=$(openssl rand -hex 32)
export PAYMENT_WEBHOOK_SECRET=$(openssl rand -hex 32)
export DATABASE_URL=...   # Supabase pooled URL

docker compose up --build      # client → :8080, server → :3000, + postgres + redis
```
The server image runs as the non-root `node` user. Put TLS termination (Caddy/ALB/Cloudflare) in
front of nginx and enable HSTS there (the nginx config already sets CSP/XFO/XCTO/Referrer-Policy).

---

## 6. Health, readiness & observability

| Endpoint | Use |
|---|---|
| `GET /health` | **Liveness** — cheap, no deps. Wired to the Docker `HEALTHCHECK`. |
| `GET /ready` | **Readiness** — pings the DB; returns `503` if down. Use for load-balancer draining. |
| `GET /metrics` | Prometheus metrics (process + HTTP + game/money counters). Scrape this. |
| `GET /api/fair/match/:id` | Public provably-fair verification (commit hash + revealed seeds). |

- Logs are structured (pino) with `authorization`/`cookie`/`set-cookie` **redacted**. Ship to your
  aggregator (Loki/ELK/Datadog).
- **Money invariant alarm:** the server logs `BALANCE RECONCILE MISMATCH` (error level) every 5 min if
  ledger≠balances. **Page on this** — it means money drift. Also watch `metrics` for settle failures.

---

## 7. Scaling & the single-instance constraint ⚠️

**DEFAULT: run exactly ONE server replica.** The authoritative game state lives in process memory, so
a second replica without the controls below will run divergent copies of the same match. A single
instance handles a large number of concurrent matches comfortably; vertical-scale first.

The Socket.IO Redis adapter (`REDIS_URL`) lets multiple instances share socket *broadcasts*, **but the
following state is PER-INSTANCE and is NOT shared:**
- turn/countdown/abandon **timers** (`TimerOrchestrator`), `idleStrikes`, `finalizedMatches`,
  `fairByRoom`/`pendingServerSeeds`, the **rate limiter** bucket, `Presence`, the **matchmaking** pool,
  the anti-collusion recent-match window, and **practice-bot** timers.

→ A given **room/match must be served by a single instance.** The money layer is safe across instances
(DB transactions + idempotent `providerRef` + the boot/periodic recovery sweep), but gameplay timers
are not.

### Running more than one replica (what it takes)
Before scaling past one server, ALL of the following are required:
1. **Sticky-by-room routing at the LB** so every socket for a match lands on the owning instance. With
   nginx, the simplest correct form is client-IP affinity on the WebSocket upstream:
   ```nginx
   upstream murlan_ws {
     ip_hash;                 # pin a client to one backend (use a room cookie hash for finer control)
     server murlan-a:3100;
     server murlan-b:3100;
   }
   # proxy /socket.io/ → murlan_ws with Upgrade/Connection headers (see deploy/nginx.conf)
   ```
2. **Redis-distributed** timers / rate-limit / presence / matchmaking (move the per-instance state above
   into shared storage) **+ a room-ownership registry** (claim roomId→instanceId in Redis on create;
   reject a join that lands on a non-owning instance with a reconnect hint). This is the remaining
   engineering work; until it exists, treat the single-replica rule as hard.

### Deploys are zero-loss (graceful drain)
On `SIGTERM`/`SIGINT` the server now **drains** instead of dropping matches: `/ready` flips to `503`
(the LB stops routing), new match/queue/practice requests are rejected, in-flight matches get a grace
window (`ABANDON_MS`) to finish + settle, and any still-escrowed pot is refunded before exit. Configure
your orchestrator to send `SIGTERM` and wait at least `ABANDON_MS` before `SIGKILL`. Watch the
`murlan_active_matches` gauge drop to 0 during a drain.

---

## 8. Recovery & troubleshooting

- **Orphaned matches after a crash:** on boot (and every 5 min) the server refunds any `active` match
  with no live room (`recoverOrphanedMatches`). No manual action needed; check logs for
  `refunded orphaned matches`.
- **Stuck/zombie withdrawal or balance drift:** query the `transactions` ledger; a closed match must
  sum to 0. Use the admin audit trail (`admin_actions`) to attribute any manual adjustment.
- **Webhook failures:** the deposit webhook verifies an HMAC over the raw body and binds the credit to
  the recorded intent (no minting). A `bad_signature`/`unknown_payment`/`intent_expired` (>72h) is
  rejected by design — re-issue the intent rather than force-crediting.
- **Port conflict in dev:** the Vite proxy target is `MURLAN_API_PORT` (default 3000); run e.g.
  `MURLAN_API_PORT=3100 PORT=3100 npm run dev` to move off a port another local project uses.
- **Forced logout of all sessions** (ban/compromise): bump the user's `tokenVersion`
  (`authService.revokeAllSessions`) — existing refresh tokens are then rejected.

---

## 9. Pre-launch checklist (real money)

- [ ] Strong, unique `JWT_*` + `PAYMENT_WEBHOOK_SECRET` (≥32 chars) set in the prod environment.
- [ ] `DATABASE_URL`/`DIRECT_URL` point at production Supabase; migrations applied; backups verified.
- [ ] TLS in front of nginx; HSTS on; `CLIENT_ORIGIN` set to the real domain.
- [ ] Compliance switches enabled per jurisdiction; **license + KYC/AML provider integrated**.
- [ ] Real payment provider wired (currently a mock — see `paymentProvider.ts`); email/SMTP provider
      configured (currently console — see `email/emailProvider.ts`).
- [ ] `/metrics` scraped; reconcile-mismatch + settle-failure alerts paged.
- [ ] External security pen-test passed.
