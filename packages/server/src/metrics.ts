// ============================================================================
// MURLAN — Prometheus metrics
// ----------------------------------------------------------------------------
// Module-level singletons (registered once per process, so building the app
// multiple times in tests never double-registers). Exposes default Node/process
// metrics + an HTTP duration histogram + a couple of money-safety counters.
// Scrape GET /metrics (restrict access at the network layer in production).
// ============================================================================

import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: 'murlan_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/** Incremented when the periodic sweep finds ledger != balances — PAGE on this. */
export const reconcileMismatches = new client.Counter({
  name: 'murlan_reconcile_mismatches_total',
  help: 'Balance/ledger reconcile mismatches detected by the periodic sweep',
  registers: [registry],
});

/** Matches refunded by the boot/periodic crash-recovery sweep. */
export const orphanedMatchesRefunded = new client.Counter({
  name: 'murlan_orphaned_matches_refunded_total',
  help: 'Matches refunded by the crash-recovery sweep (orphaned active matches)',
  registers: [registry],
});

/**
 * Incremented when money.settle() THROWS after a match was claimed for finalization
 * — the match:end may not have paid out and the room can be stuck. PAGE on this:
 * each increment is a real-money settlement that needs operator remediation.
 */
export const settlementFailures = new client.Counter({
  name: 'murlan_settlement_failures_total',
  help: 'Match settlements that threw after finalize (need manual remediation)',
  registers: [registry],
});

// ---- Live state gauges (set periodically by the app loop / inc-dec by the gateway).
/** Currently-connected Socket.IO clients (incremented/decremented per socket). */
export const socketConnections = new client.Gauge({
  name: 'murlan_socket_connections',
  help: 'Currently connected realtime (Socket.IO) clients',
  registers: [registry],
});

/** Max event-loop delay (ms) seen in the last health-monitor window. A high value means the
 *  single event loop stalled (GC pressure / sync bot search) — long enough and every client's
 *  socket times out ("connection lost"). The health monitor also Telegram-alerts on this. */
export const eventLoopLagMs = new client.Gauge({
  name: 'murlan_event_loop_lag_ms',
  help: 'Max event-loop delay in ms observed in the last health-monitor window',
  registers: [registry],
});

/** Process memory (bytes): resident set (RSS, watched vs the container cgroup limit) and V8
 *  heap-used (watched vs the --max-old-space-size cap). Sampled by the health monitor. */
export const processRssBytes = new client.Gauge({
  name: 'murlan_process_rss_bytes',
  help: 'Process resident set size (RSS) in bytes',
  registers: [registry],
});
export const heapUsedBytes = new client.Gauge({
  name: 'murlan_heap_used_bytes',
  help: 'V8 heap used in bytes',
  registers: [registry],
});

/** Matches in progress right now (escrowed, not yet settled/refunded). */
export const activeMatches = new client.Gauge({
  name: 'murlan_active_matches',
  help: 'Matches currently in progress (escrowed, unsettled)',
  registers: [registry],
});

/** Withdrawals awaiting admin approval — a money-ops queue to watch. */
export const pendingWithdrawals = new client.Gauge({
  name: 'murlan_pending_withdrawals',
  help: 'Withdrawals awaiting admin approval',
  registers: [registry],
});

/** Wall-clock duration of money.settle() — watch for DB slowness on the money path. */
export const settlementDuration = new client.Histogram({
  name: 'murlan_settlement_duration_seconds',
  help: 'Duration of match settlement (money.settle) in seconds',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

/** Deposit webhooks by outcome (credited / idempotent replay / rejected). */
export const depositWebhooks = new client.Counter({
  name: 'murlan_deposit_webhooks_total',
  help: 'Deposit webhooks processed, by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** Auto-payout attempts by outcome (paid / failed) — watch the fail rate on the
 *  crypto-withdrawal path; each fail means a withdrawal fell back to manual. */
export const autoPayouts = new client.Counter({
  name: 'murlan_auto_payouts_total',
  help: 'Automatic crypto payouts attempted, by outcome (paid|failed)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** USDT-TRC20 deposits credited via the on-chain TxID flow (by outcome). */
export const tronDeposits = new client.Counter({
  name: 'murlan_tron_deposits_total',
  help: 'USDT-TRC20 TxID deposits, by outcome (credited|rejected|replay)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** Set by the periodic treasury check: Binance free USDT minus player liabilities
 *  (cents). Negative = under-funded (can't cover all withdrawals). PAGE if < 0. */
export const treasuryBufferCents = new client.Gauge({
  name: 'murlan_treasury_buffer_cents',
  help: 'Binance free USDT minus total player balances, in cents (negative = under-funded)',
  registers: [registry],
});

/** Audit-relevant background writes that FAILED and were swallowed by design (so a chronic failure
 *  stays VISIBLE — audit I1). kind: matchlog (replay/dispute trail) | emergency_refund (a stranded
 *  pot — beginMatch failed and the refund also failed) | anticheat (a missed suspicion record). A
 *  non-zero rate here means a safety/audit write is silently dropping — investigate. */
export const auditWriteFailures = new client.Counter({
  name: 'murlan_audit_write_failures_total',
  help: 'Swallowed audit-relevant background write failures, by kind',
  labelNames: ['kind'] as const,
  registers: [registry],
});
