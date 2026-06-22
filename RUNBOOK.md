# Crypto-Murlan — Operations Runbook

Incident-response + routine-ops guide for the single-host Docker deployment. Pairs with
`DEPLOYMENT.md` (first-time setup) and `AUDIT_REPORT_2026-06-14.md` (known gaps).

> Host: single VPS, `~/murlan-2.0`. Stack (docker compose): `caddy` (TLS) → `client`
> (nginx) → `server` (Fastify+Socket.IO) → `postgres` + `redis`, plus `db-backup`.

---

## 1. Deploy / redeploy

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
- **Offsite (SET THIS UP — not automatic yet):** the local dumps live on the SAME disk
  as the Postgres volume, so one host/disk loss takes the ledger AND every backup. Wire
  `deploy/backup-offsite.sh` to a cloud bucket: `apt install rclone` → `rclone config`
  (e.g. Backblaze B2) → add a daily cron (`crontab -e`, e.g. `30 4 * * * /…/backup-offsite.sh`).
  Confirm with `rclone ls <remote>:<bucket>` after the first run.
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
Structured JSON (pino) to stdout with header/token redaction; ephemeral (lost on
container exit). To persist/search, ship the container's stdout to journald/Loki/ELK
(e.g. a fluent-bit sidecar). `LOG_LEVEL` defaults to `info` in prod.

## 6. Common incidents

| Symptom | Likely cause | Action |
|---|---|---|
| Player "didn't get my withdrawal" | Binance unfunded → send failed (auto-refunded) | Check Treasury coverage; fund/sweep Binance; re-approve |
| Withdraw blocked / "limit reached" | Age/geo gate, or per-user 24h auto cap hit (larger → manual) | Check the player's gates + the pending queue; Approve manually if legit |
| Deposit credited but not in TronLink | Funds at the per-player address (not index 0) | `tools/tron-scan.mjs` finds the right index |
| Server crash-loop on boot | Bad migration / DB unreachable | Check `docker compose logs server`; restore pre-deploy dump |
| Site reachable on `:8080` (plain HTTP) | Client port published on host (bypasses Caddy TLS) | Bind client to 127.0.0.1 / drop the host publish (follow-up) |

## 7. Secrets
Rotate if exposed: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PAYMENT_WEBHOOK_SECRET`
(`openssl rand -hex 32`), `RESEND_API_KEY` (Resend dashboard), Binance/TronGrid/Telegram
keys (their consoles). Update `.env` → `redeploy.sh`. The deposit wallet seed lives
OFFLINE only — never on the server.

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
