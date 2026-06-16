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
- **Offsite:** `deploy/backup-offsite.sh` via rclone → Backblaze B2, cron 04:30 daily.
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
- **Withdrawals:** blocked until **admin-verified KYC**. KYC-verified + **≤ $50** →
  auto-pays via Binance on request. **> $50** → admin **Approve** (which *sends* via
  Binance). A failed send refunds the player and stays unpaid.

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
1. Verify a player's identity → **Admin → Players → KYC → verified**.
2. Keep Binance topped up so payouts (auto + Approve) succeed.
3. Sweep deposit addresses → Binance when the Treasury panel shows low coverage.

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
| Withdraw button blocked | KYC not verified (by design) | Verify the player's KYC in Admin |
| Deposit credited but not in TronLink | Funds at the per-player address (not index 0) | `tools/tron-scan.mjs` finds the right index |
| Server crash-loop on boot | Bad migration / DB unreachable | Check `docker compose logs server`; restore pre-deploy dump |
| Site reachable on `:8080` (plain HTTP) | Client port published on host (bypasses Caddy TLS) | Bind client to 127.0.0.1 / drop the host publish (follow-up) |

## 7. Secrets
Rotate if exposed: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PAYMENT_WEBHOOK_SECRET`
(`openssl rand -hex 32`), `RESEND_API_KEY` (Resend dashboard), Binance/TronGrid/Telegram
keys (their consoles). Update `.env` → `redeploy.sh`. The deposit wallet seed lives
OFFLINE only — never on the server.
