# Observability & incident runbook

The server exposes Prometheus metrics at **`GET /metrics`** (see
`packages/server/src/metrics.ts`). Operator alerts (e.g. large withdrawals) also go
to Telegram (`packages/server/src/notify/notifier.ts`, now with retry).

## 1. Metrics → Prometheus + alerts
1. Scrape the API. Example Prometheus scrape config:
   ```yaml
   scrape_configs:
     - job_name: murlan          # the alert rules use job="murlan"
       metrics_path: /metrics
       static_configs:
         - targets: ['murlan-server:8080']   # adjust host:port to your deploy
   ```
2. Load the alert rules:
   ```yaml
   rule_files:
     - /etc/prometheus/alerts.yml   # = deploy/prometheus/alerts.yml
   ```
3. Point **Alertmanager** at your receiver (Telegram bot / email / PagerDuty).

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
