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
