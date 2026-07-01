# Crypto-Murlan — Operations Runbook

Incident-response + routine-ops guide for the single-host Docker deployment. Pairs with
`DEPLOYMENT.md` (first-time setup) and the current audits (`AUDIT_REPORT_2026-06-26.md` §8 +
`SECURITY_REDTEAM.md`; archive in `docs/audits/`).

> Host: single VPS, `~/murlan-2.0`. Stack (docker compose): `caddy` (TLS) → `client`
> (nginx) → `server` (Fastify+Socket.IO) → `postgres` + `redis`, plus `db-backup`.

---

## 1. Deploy / redeploy

**Fast path (recommended) — pull CI-built images, no host build:**
```bash
cd ~/murlan-2.0 && bash deploy/pull-deploy.sh   # run AFTER GitHub Actions CI goes green on your push
docker compose -f docker-compose.yml -f docker-compose.deploy.yml -f docker-compose.ghcr.yml logs server --tail 30
```
On every push to `main`, GitHub Actions builds + Trivy-scans the server & client images and pushes them to
`ghcr.io/astekbow/murlan-{server,client}:latest`. `pull-deploy.sh` then just **pulls** them (seconds) and
restarts — the small VPS never runs `npm ci` / `vite build` / `prisma generate` (those took ~28 min on this
box). Same pre-deploy DB dump + verify; the server still runs `prisma migrate deploy` on boot.

> **One-time setup:** after the FIRST CI run that pushes images, make both packages PUBLIC so the host
> pulls without a login: GitHub → your avatar → **Packages** → `murlan-server` → *Package settings* →
> **Change visibility → Public** (repeat for `murlan-client`). The repo's Actions also need package-write
> (already set via `permissions: packages: write` in `ci.yml`). Rollback: pull a specific
> `ghcr.io/astekbow/murlan-server:<sha>` tag instead of `latest`.

**Fallback — build on the host** (if CI is down, or you changed a Dockerfile and want a local build):
```bash
cd ~/murlan-2.0 && bash deploy/redeploy.sh
docker compose logs server --tail 30   # confirm a clean boot
```
`redeploy.sh` pulls `main`, takes + **verifies** a pre-deploy DB dump, rebuilds, and
restarts. The server runs `prisma migrate deploy` on boot (fail-fast). Do it during low
traffic (≈1–2 min restart; `stop_grace_period: 60s` lets live matches drain).

**Healthy boot looks like:** `[db] store=postgres … env=production`, `[deposit] UNIQUE
per-player … ENABLED`, `Server listening … (production)`, `/health` → 200. No
`ALLOW_STUB_PROVIDERS` warning, no CORS warning.

## 2. Rollback a bad deploy
```bash
git -C ~/murlan-2.0 log --oneline -5          # find the last-good commit
git -C ~/murlan-2.0 checkout <good-sha>
bash deploy/redeploy.sh
```
If a **migration** corrupted data, restore the pre-deploy dump (see §3). Migrations are
additive; there is no down-migration — restore from backup if one is destructive.

## 3. Backups & restore
- **Local:** `db-backup` service → `./backups/{daily,weekly,monthly}` (+ `predeploy/`).
- **Offsite (DEFAULT-ON service — no-ops until configured):** the local dumps live on the SAME
  disk as the Postgres volume, so one host/disk loss takes the ledger AND every backup. The
  `offsite-backup` service (in `docker-compose.deploy.yml`) already syncs `./backups` → an rclone
  remote DAILY — but it SAFELY SKIPS until you configure it on the host:
  1. `rclone config` a remote (config dir `./deploy/rclone`, or set `RCLONE_CONFIG_DIR`), e.g. Backblaze B2;
  2. set `BACKUP_REMOTE=<remote:bucket>` in `.env` (until then the container just logs "skipping").
  ⚠️ Do this BEFORE accepting more deposits — until then there is NO offsite copy of the money ledger.
  Manual/host-cron alternative: `deploy/backup-offsite.sh`. Confirm with `rclone ls <remote>:<bucket>`.
- **Restore:**
  ```bash
  gunzip -c backups/daily/<file>.sql.gz | docker compose exec -T postgres psql -U murlan -d murlan
  ```
- **Verify quarterly:** restore a dump into a throwaway DB and sanity-check row counts.

## 4. Money operations

### Model
- **Deposits** (USDT-TRC20): player sends to their **unique per-player address**
  (watch-only, derived from `TRON_DEPOSIT_XPUB`) then submits the TxID → server verifies
  on-chain (TronGrid) + credits. The actual USDT sits at the deposit address.
- **Withdrawals:** NOT KYC-gated (KYC was removed by owner decision — don't re-add it
  silently). Age/geo gates still apply when configured. A withdrawal **≤
  `AUTO_WITHDRAW_MAX_CENTS`** (and within the per-user 24h `DAILY_AUTO_WITHDRAW_CAP_CENTS`)
  auto-pays via Binance on request; anything larger / over the cap → admin **Approve**
  (which *sends* via Binance) or **Reject** (refunds). A failed send refunds the player
  and stays unpaid. With the Telegram admin bot active you can Approve/Reject from chat.

### Treasury (the two pools)
Deposits accumulate at the per-player TRON addresses; withdrawals pay from **Binance**.
They are SEPARATE — keep Binance funded with USDT and periodically **sweep** deposits in.
- See balances: **Admin → Overview → Treasury** (house rake, player liabilities, on-chain
  deposit funds, Binance free, pending withdrawals, coverage).
- **Sweep** (move deposit funds → Binance), run LOCALLY (never on the server) with the
  seed: `tools/tron-scan.mjs` (find funds) then `tools/tron-sweep.mjs` (consolidate;
  dry-run by default, `EXECUTE=yes` to move). Sweep only meaningful balances (gas is
  per-address ~$1–2).

### Routine
1. Keep Binance topped up so payouts (auto + Approve) succeed.
2. Sweep deposit addresses → Binance when the Treasury panel shows low coverage.
3. (Optional) Set a player's KYC flag in Admin for your own records — it does NOT gate
   withdrawals today; it only feeds the risk view.

### Tournament payouts — who decides the winner
- **Self-running tournaments (normal):** each pairing is played as a live in-app match;
  the gateway reports the **real** game winner automatically and advances/pays — no admin
  picks the winner. Once a live match decides a pairing it's locked (can't be overridden).
- **Manual `/report` (fallback):** only reachable for a pairing with NO live result
  (no-show/dispute). The reported winner **must be one of the two real bracket
  participants** (an arbitrary account can't be named) and every report is audited. So the
  worst a single admin can do is pick the wrong one of two legitimate finalists — not
  drain the pool to an outsider.
- **Four-eyes:** set `TOURNAMENT_DUAL_CONTROL=true` (if you add a 2nd admin) to require a
  SECOND admin to confirm a money tournament's champion before payout. Leave off for a
  solo operator (a self-running final can't wait for a confirmer).

## 5. Alerts & observability

### Telegram (set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`)
Pings on: withdrawal requests (review/auto-paid/failed), treasury under-funding, failed
payout reversals (amount-mismatch). They are **best-effort** (a send failure is logged,
not retried) — don't rely on them as the only signal; also watch the metrics below.

### Prometheus metrics (`GET /metrics`, token- or private-IP-gated)
Recommended alert rules (add to your Prometheus/Alertmanager):
```yaml
groups:
  - name: murlan-money
    rules:
      - alert: SettlementFailure        # a real-money payout threw — investigate now
        expr: increase(murlan_settlement_failures_total[5m]) > 0
        labels: { severity: critical }
      - alert: LedgerReconcileMismatch   # balance/ledger drift detected by the 5-min sweep
        expr: increase(murlan_reconcile_mismatches_total[10m]) > 0
        labels: { severity: critical }
      - alert: TreasuryUnderFunded       # Binance can't cover player liabilities
        expr: murlan_treasury_buffer_cents < 0
        labels: { severity: warning }
      - alert: PendingWithdrawalsStuck
        expr: murlan_pending_withdrawals > 0   # cross-check the admin queue if persistent
        labels: { severity: info }
```
**On `SettlementFailure`:** query the ledger for the match, verify the pot, and manually
settle/refund. **On `LedgerReconcileMismatch`:** stop approving withdrawals, find the
drifting account/match, reconcile before resuming. **On `TreasuryUnderFunded`:** sweep
deposits → Binance and/or top up Binance USDT.

### Logs
Structured JSON (pino) to stdout with header/token redaction. `LOG_LEVEL` defaults to `info` in prod.
On the host, each container keeps a rotated json-file ring (server + postgres: `50m × 5` ≈ 250 MB each;
others smaller) — enough for recent forensics, but lost if the host dies.

**Centralized/searchable logs (opt-in):** the `monitoring` profile now bundles **Loki + Promtail + Grafana**
(alongside Prometheus/Alertmanager). Promtail tails every container's stdout via the Docker socket and ships
it to Loki; Grafana (127.0.0.1:3000) gives both the **metrics** (Prometheus) and the **logs** (Loki) a UI:
```bash
docker compose -f docker-compose.yml -f docker-compose.deploy.yml --profile monitoring up -d
# then: ssh -L 3000:127.0.0.1:3000 <host>  → open http://localhost:3000 (admin / $GRAFANA_ADMIN_PASSWORD)
# query logs in LogQL, e.g.  {service="server"} |= "error"
```
All three bind to 127.0.0.1 only. Digest-pin the loki/promtail/grafana images before relying on them
(see the `# TODO digest-pin` notes in `docker-compose.deploy.yml`). Loki stores on the same host disk
(retention 7 days) — for true offsite durability, ship Loki's volume like the DB backup.

## 6. Common incidents

| Symptom | Likely cause | Action |
|---|---|---|
| Player "didn't get my withdrawal" | Binance unfunded → send failed (auto-refunded) | Check Treasury coverage; fund/sweep Binance; re-approve |
| Withdraw blocked / "limit reached" | Age/geo gate, or per-user 24h auto cap hit (larger → manual) | Check the player's gates + the pending queue; Approve manually if legit |
| Deposit credited but not in TronLink | Funds at the per-player address (not index 0) | `tools/tron-scan.mjs` finds the right index |
| Server crash-loop on boot | Bad migration / DB unreachable | Check `docker compose logs server`; restore pre-deploy dump |
| Site reachable on `:8080` from outside the host | (Should NOT happen) client is already bound `127.0.0.1:8080` in both compose files — reachable only on the host for local checks, never publicly | If it IS externally reachable, a compose override re-published the port: remove it so only Caddy (80/443) is public |

## 7. Secrets — rotation playbook

Anything ever pasted into chat / a screenshot / a public repo is **compromised** — rotate it. General
flow for every secret: **change it at the source → update `.env` → `bash deploy/redeploy.sh`** (the server
re-reads env on boot). Rotate in this priority order (money first):

| Secret | Where to rotate | Blast radius / notes |
|---|---|---|
| **`BINANCE_API_KEY` / `BINANCE_API_SECRET`** | Binance console → **delete** the leaked key, create a new one. Restrict it to the payout perms only + **IP-allowlist** the server. | **MOST URGENT — moves real money.** A leaked key with withdraw rights can drain the payout float. |
| `TRON_DEPOSIT_XPUB` (+ wallet **seed**) | The xpub alone can't spend (watch-only). **If the SEED leaked**: generate a NEW HD wallet offline → put the new xpub in `.env` → future deposits use new addresses; sweep old ones. | Seed = full control of deposit funds. Seed lives OFFLINE only, never on the server. |
| `TELEGRAM_BOT_TOKEN` | BotFather → `/revoke` → new token. Then re-run `setWebhook` (see §5). | Leaked token = anyone can drive the admin bot. |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` → `.env`. Re-run `setWebhook` with the new `secret_token`. | Gate on inbound webhook updates; the bot is dead until setWebhook is redone. |
| `RESEND_API_KEY` | Resend dashboard → revoke + new key. | Leaked = spoofed transactional email from your domain. |
| `TRONGRID_API_KEY` | TronGrid console. | Leaked = your rate-quota abused; no fund access. |
| `PAYMENT_WEBHOOK_SECRET` | `openssl rand -hex 32` → `.env` AND the NOWPayments dashboard (must match). | Mismatch → IPN deposits stop crediting until both sides agree. |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | `openssl rand -hex 32` each. | **Rotating logs EVERY user out** (all refresh tokens invalid). Do during a quiet window. |

After rotating, run §9 (env sanity check) and watch `docker compose logs server` for a clean boot.

### Load-balancer / proxy health check

Point any LB or external proxy at **`GET /ready`**, not `/health`:

- `/health` → always `{ok:true}` while the process is up (liveness only).
- `/ready` → returns **503 during graceful drain** (deploy/shutdown). An LB that checks `/ready` stops
  sending new traffic to a draining instance, so in-flight games finish cleanly. (The bundled Caddy fronts
  a single instance so this matters most if you ever add an external LB.)

## 8. Scaling — RUN A SINGLE SERVER INSTANCE ONLY
This stack is **single-instance by design**. Critical state lives IN-PROCESS, not in a
shared store: room ownership (`InMemoryRoomOwnership` is a no-op), per-turn/abandon timers,
the rate limiter, presence, matchmaking, and — importantly — the **per-user daily
deposit-cap serialization** in `walletService`. Running **2+ replicas of `server`** would:
- corrupt live matches (two instances each think they own a room), and
- let a player **exceed their responsible-gaming daily deposit cap** via concurrent
  deposits hitting different instances (the cap relies on single-process serialization).

So: scale UP (a bigger VPS), never OUT, until the room-ownership + caps are moved to a
Redis-backed shared store. `REDIS_URL` today only powers the Socket.IO adapter — it does
**not** make the app horizontally safe. Keep exactly one `server` container.

> **Note (audit 2026-06-28):** the money layer is *already* multi-instance-safe (idempotent `providerRef`
> + `pg_advisory_xact_lock` on the deposit cap); what's not safe is the game layer (room/match state, timers,
> fairness, matchmaking). The full evidence-based inventory + the ordered scale-out roadmap (linchpin = a
> Redis-backed `RoomOwnership`) lives in [`docs/MULTI_INSTANCE.md`](docs/MULTI_INSTANCE.md).

## 9. Live env sanity check (run after every deploy)
Confirm the container actually got the right config (a `.env` var only reaches it if it's
mapped in `docker-compose.yml`):
```bash
docker compose exec server printenv \
  NODE_ENV DATABASE_URL TRON_DEPOSIT_XPUB CLIENT_ORIGIN TELEGRAM_WEBHOOK_SECRET
```
Expect: `NODE_ENV=production`; `DATABASE_URL` → the bundled `postgres:5432` (NOT a dev
Supabase host); **`TRON_DEPOSIT_XPUB` non-empty** (if empty, deposits silently fall back
to the legacy *claim-jackable* shared address — the app only warns, it does not refuse to
boot); `CLIENT_ORIGIN` = your real `https://` domain; `TELEGRAM_WEBHOOK_SECRET` set if you
want the interactive bot. Also confirm boot logs show `[deposit] UNIQUE per-player …
ENABLED` (not the single-shared-address warning).

## 10. Migrate to a new / bigger server
Real-money DB — the goal is **zero ledger loss** and **never two live instances at once**.

**What moves vs. what doesn't:**
- **Moves:** the Postgres data (the `pgdata` volume = balances + ledger) and `.env`.
- **Does NOT move (stays valid):** deposit funds are **on-chain** at addresses derived from
  `TRON_DEPOSIT_XPUB` — keep the SAME xpub in the new `.env` and the same addresses are
  watched. The deposit-wallet seed stays offline (never on any server).

**A. Prepare the new box (no downtime yet):**
1. Provision a **2GB+** Ubuntu box; install Docker + compose; open ports 22/80/443.
2. **Lower the DNS TTL** for your domain to 300s **a day before** (fast cutover).
3. **Whitelist the NEW server's IP on the Binance API key** (Enable Withdrawals + IP
   allowlist). ⚠️ Skip this and ALL withdrawals fail after cutover (Binance rejects the new IP).
4. `git clone` the repo to `~/murlan-2.0`; copy `.env` over (scp). Good moment to ROTATE
   any chat-exposed secrets (TELEGRAM_WEBHOOK_SECRET, regenerate the deposit wallet → new xpub).
5. Bring up ONLY Postgres first so its DB is empty before the server runs migrations:
   `docker compose up -d postgres` (wait for healthy).

**B. Cutover (short low-traffic window — only ONE instance serves at a time):**
1. On the **OLD** box, stop serving so nothing writes mid-dump:
   `docker compose stop server` (drains in-flight; deposit poller stops).
2. On OLD, take a final dump:
   `docker compose exec -T postgres pg_dump -U murlan -d murlan | gzip > ~/murlan-final.sql.gz`
3. Copy it over: `scp ~/murlan-final.sql.gz user@NEW_IP:~/`
4. On **NEW**, restore into the empty DB (no schema yet → clean load):
   `gunzip -c ~/murlan-final.sql.gz | docker compose exec -T postgres psql -U murlan -d murlan`
5. On NEW, bring up the rest:
   `docker compose -f docker-compose.yml -f docker-compose.deploy.yml up --build -d`
   (the server's boot `migrate deploy` is a no-op — the schema came in the dump).
6. **Switch DNS** A-record → NEW IP. Caddy on NEW issues a fresh Let's Encrypt cert once DNS
   resolves to it (needs 80/443 open + DNS pointed).
7. Verify on NEW (RUNBOOK §9 + §1): `/health` bot command, a few known balances, `/treasury`,
   `[deposit] … ENABLED` in logs, then a tiny end-to-end test.

**C. After:**
- Keep the OLD box powered with `server` STOPPED for 24–48h as rollback (do NOT let it serve
  — two live instances would split the ledger + double-process deposits).
- Re-point the **Telegram webhook** is automatic (re-registers to `CLIENT_ORIGIN` on boot).
- Re-wire **offsite backups** on the new box (§3) and confirm one restore.
- Once confident, securely wipe + decommission OLD.

**Gotchas checklist:** Binance IP whitelist (B-fail without it) · same `TRON_DEPOSIT_XPUB` ·
DNS TTL lowered · only ONE instance live · backups re-wired on NEW · ports 80/443 open.
