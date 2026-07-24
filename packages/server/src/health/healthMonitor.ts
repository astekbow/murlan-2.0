// ============================================================================
// MURLAN — Server health monitor (event-loop lag + memory) → Telegram alerts
// ----------------------------------------------------------------------------
// The single instance's disconnects are almost never a JS crash (guards catch
// throws); they are OOM / container-restart or an EVENT-LOOP STALL long enough
// to trip Socket.IO's pingTimeout, which drops EVERY client at once. Nobody was
// watching for either. This samples the event-loop delay and process memory on a
// timer and, on a threshold breach, LOGS a warning (always visible in
// `docker logs`) and — if a Telegram notifier is wired — sends a THROTTLED ops
// alert, so the operator learns the moment (ideally before) players are hit.
//
// The threshold logic is a pure function (`buildAlerts`) so it is unit-tested
// without timers/perf_hooks; the timer + perf_hooks + fs reads are thin glue.
// Best-effort throughout: health must NEVER break or slow the app.
// ============================================================================

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { readFileSync } from 'node:fs';
import { log } from '../logger.ts';
import { eventLoopLagMs, processRssBytes, heapUsedBytes } from '../metrics.ts';

const MB = 1024 * 1024;

export interface HealthThresholds {
  /** Alert when the MAX event-loop delay in the window ≥ this (ms). Default 2000. */
  lagMs: number;
  /** Alert when heapUsed / heap_size_limit ≥ this fraction (0..1). Default 0.90. */
  heapPct: number;
  /** Alert when RSS / cgroup-limit ≥ this fraction (0..1). Default 0.90. */
  rssPct: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = { lagMs: 2_000, heapPct: 0.9, rssPct: 0.9 };

/** A single health sample, in the units the pure evaluator wants. */
export interface HealthSample {
  lagMaxMs: number;
  lagMeanMs: number;
  heapUsedBytes: number;
  heapLimitBytes: number;   // V8 old-space cap (--max-old-space-size)
  rssBytes: number;
  rssLimitBytes: number | null; // container cgroup limit, or null if unknown/unlimited
}

export interface HealthAlert { kind: 'loop' | 'heap' | 'rss'; text: string }

const pct = (frac: number): string => `${Math.round(frac * 100)}%`;
const mb = (bytes: number): string => `${Math.round(bytes / MB)}MB`;

/** PURE: decide which alerts a sample warrants. Deterministic + side-effect free → unit-tested. */
export function buildAlerts(s: HealthSample, t: HealthThresholds, ctx?: string): HealthAlert[] {
  const out: HealthAlert[] = [];
  const suffix = ctx ? `\n${ctx}` : '';
  if (s.lagMaxMs >= t.lagMs) {
    out.push({
      kind: 'loop',
      text: `⚠️ <b>Event-loop u bllokua ${(s.lagMaxMs / 1000).toFixed(1)}s</b> (mesatare ${Math.round(s.lagMeanMs)}ms). Lojtarët mund të shohin "lidhja u shkëput".${suffix}`,
    });
  }
  const heapFrac = s.heapLimitBytes > 0 ? s.heapUsedBytes / s.heapLimitBytes : 0;
  if (heapFrac >= t.heapPct) {
    out.push({
      kind: 'heap',
      text: `🔴 <b>Heap ${pct(heapFrac)}</b> e kapacitetit (${mb(s.heapUsedBytes)} / ${mb(s.heapLimitBytes)}). Rrezik GC-stall/OOM — ngri --max-old-space-size.${suffix}`,
    });
  }
  if (s.rssLimitBytes && s.rssLimitBytes > 0) {
    const rssFrac = s.rssBytes / s.rssLimitBytes;
    if (rssFrac >= t.rssPct) {
      out.push({
        kind: 'rss',
        text: `🔴 <b>RSS ${pct(rssFrac)}</b> e limitit të kontejnerit (${mb(s.rssBytes)} / ${mb(s.rssLimitBytes)}). Rrezik OOM-kill → restart që shkëput të gjithë — ngri SERVER_MEM_LIMIT.${suffix}`,
      });
    }
  }
  return out;
}

/** PURE: parse a cgroup memory-limit file body. cgroup v2 uses "max" for unlimited; v1 uses a
 *  huge sentinel (~9.2e18). Returns bytes, or null when unlimited/unparseable. */
export function parseCgroupLimit(raw: string): number | null {
  const s = raw.trim();
  if (s === '' || s === 'max') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n >= 1e15) return null; // ignore the "unlimited" sentinel
  return n;
}

/** Read the container's memory cgroup limit (v2 then v1), or null if none/unreadable. */
function cgroupMemLimit(): number | null {
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try { const v = parseCgroupLimit(readFileSync(p, 'utf8')); if (v != null) return v; } catch { /* not this path */ }
  }
  return null;
}

export interface HealthMonitorOptions {
  /** Telegram ops alert (best-effort). Omit when Telegram isn't configured → logs only. */
  notify?: (text: string) => Promise<void>;
  intervalMs?: number;   // sample cadence (default 30s)
  cooldownMs?: number;   // per-alert-kind throttle (default 15 min)
  thresholds?: Partial<HealthThresholds>;
  /** Optional one-line context for the alert body (e.g. "Lojtarë: 42 · Ndeshje: 9"). */
  context?: () => string;
}

/** Start sampling. Returns a disposer that stops the timer + the delay histogram. */
export function startHealthMonitor(opts: HealthMonitorOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  const cooldownMs = opts.cooldownMs ?? 15 * 60_000;
  const t: HealthThresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const rssLimit = cgroupMemLimit();

  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();

  const lastAlert = new Map<string, number>();
  const timer = setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const sample: HealthSample = {
        lagMaxMs: h.max / 1e6, // ns → ms
        lagMeanMs: h.mean / 1e6,
        heapUsedBytes: mem.heapUsed,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
        rssBytes: mem.rss,
        rssLimitBytes: rssLimit,
      };
      h.reset();
      // Publish gauges regardless (visible at /metrics even when below the alert bar).
      eventLoopLagMs.set(Math.round(sample.lagMaxMs));
      processRssBytes.set(sample.rssBytes);
      heapUsedBytes.set(sample.heapUsedBytes);

      const alerts = buildAlerts(sample, t, opts.context?.());
      const now = Date.now();
      for (const a of alerts) {
        log.warn(`[health] ${a.text.replace(/<\/?b>/g, '')}`); // always visible in docker logs
        if (!opts.notify) continue;
        if (now - (lastAlert.get(a.kind) ?? 0) < cooldownMs) continue; // throttle per kind
        lastAlert.set(a.kind, now);
        void opts.notify(a.text).catch(() => { /* best-effort — never break the app */ });
      }
    } catch { /* health must never break the app */ }
  }, intervalMs);
  timer.unref?.(); // never keep the process alive just to sample health

  return () => { clearInterval(timer); try { h.disable(); } catch { /* noop */ } };
}
