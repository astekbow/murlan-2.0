# Observability & incident runbook

The server exposes Prometheus metrics at **`GET /metrics`** (see
`packages/server/src/metrics.ts`). Operator alerts (e.g. large withdrawals) also go
to Telegram (`packages/server/src/notify/notifier.ts`, now with retry).

## 1. Metrics → Prometheus → Telegram (one command)
The full pipeline is wired and **opt-in** behind the `monitoring` compose profile —
Prometheus (scrape + `alerts.yml`) + Alertmanager (→ your Telegram). Bring it up with:

```bash
# Needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env (the same ones the app uses).
docker compose -f docker-compose.yml -f docker-compose.deploy.yml --profile monitoring up -d
```

That's it: Prometheus scrapes `server:3000/metrics` over the internal network (a private
172.x IP, so no token is needed), evaluates `deploy/prometheus/alerts.yml`, and
Alertmanager pages your Telegram chat when an alert fires (and again when it resolves).
Prometheus' UI is on `http://127.0.0.1:9090` (localhost-only). The pieces:
- `deploy/prometheus/prometheus.yml` — scrape + rules + alertmanager target.
- `deploy/prometheus/alerts.yml` — the alert rules (money-integrity + ops).
- `deploy/prometheus/alertmanager.tmpl.yml` — Telegram receiver (your bot token + chat
  id are injected at container start from the env — never committed).

To run the rest of the stack WITHOUT monitoring, just omit `--profile monitoring`.

### Key money metrics
| Metric | Meaning | Alert |
| --- | --- | --- |
| `murlan_settlement_failures_total` | a pot failed to settle/refund | **critical**, any increase |
| `murlan_reconcile_mismatches_total` | ledger ≠ balances | **critical**, any increase |
| `murlan_orphaned_matches_refunded_total` | recovery-sweep refunds | warn if elevated |
| `murlan_pending_withdrawals` | withdrawals awaiting action | warn if backlogged |
| `murlan_treasury_buffer_cents` | house buffer | watch for negative |

## 2. Incident response (the critical alerts)
- **MurlanSettlementFailure** — a match pot wasn't paid. The crash-recovery sweep
  (`recoverOrphanedMatches`, runs at boot + periodically) refunds stranded stakes;
  confirm the affected players were refunded and `wallet.reconcile()` is OK. Check the
  server logs for `[settlement] FAILED`.
- **MurlanLedgerMismatch** — STOP. `wallet.reconcile()` found balances and the ledger
  disagree. Pause withdrawals (admin), export the ledger, and find the unbalanced
  entry before paying anyone.
- **MurlanServerDown** — `docker compose ps` / `docker compose logs --tail=200 server`.

## 3. Log aggregation (recommended)
Logs are structured JSON (pino) to **stdout** — Docker captures them. **IPs are logged
but never persisted to the database** (good for GDPR; nothing to purge in Postgres —
only Docker's rotated stdout). To centralize:
- Easiest: ship the Docker JSON logs to **Grafana Loki** via the Loki Docker driver or
  **Promtail**, then query/alert in Grafana alongside the metrics above.
- Set Docker log rotation so stdout can't fill the disk, e.g. in the compose file:
  ```yaml
  logging:
    driver: json-file
    options: { max-size: "20m", max-file: "5" }
  ```
- Retention: the app's data-retention sweep prunes old move-logs + expired tokens (see
  `MOVELOG_RETENTION_DAYS`); Docker handles stdout-log retention via the rotation above.
