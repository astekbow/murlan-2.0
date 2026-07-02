// ============================================================================
// MURLAN — Bot worker POOL (parallel bot AI on spare cores)
// ----------------------------------------------------------------------------
// Owns N worker_threads running botWorker.ts and hands each bot decision to an
// idle worker (FIFO queue when all are busy). This is what lifts the "concurrent
// bot games" ceiling: the PIMC search saturates ONE core when it runs on the main
// thread; with the pool it uses the host's spare cores AND the event loop stays
// free, so human tables never lag behind bot compute.
//
// Failure posture: this pool is an OPTIMIZATION, never a dependency. Any failure
// (worker crash, spawn error, timeout) rejects the decide() promise and the
// gateway falls back to the same synchronous decideBotMove it used before the
// pool existed — a bot can never stall a match because of the pool.
//
// The workers inherit process.execArgv (tsx loader), so they can load the .ts
// worker file in every environment that can run the server itself.
// ============================================================================

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { log as logger } from '../logger.ts';
import type { BotMove, BotTier, BotView } from './botDecision.ts';

interface Job {
  id: number;
  view: BotView;
  tier: BotTier;
  resolve: (move: BotMove) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// A decision normally takes 20-130ms; 3s absorbs a cold worker (first-use tsx
// compile) with a wide margin. On timeout the caller computes synchronously, so
// worst case a bot "thinks" ~3s longer than usual — far inside the turn budget.
const DECIDE_TIMEOUT_MS = 3_000;

// A crash-looping worker file must not respawn forever; after this many total
// respawns the pool disables itself and every decision uses the sync fallback.
const MAX_RESPAWNS = 20;

export class BotWorkerPool {
  private readonly workers = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private readonly queue: Job[] = [];
  private readonly inFlight = new Map<Worker, Job>();
  private readonly timeoutMs: number;
  private nextId = 1;
  private respawns = 0;
  private disabled = false;

  constructor(readonly size: number, opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? DECIDE_TIMEOUT_MS;
    for (let i = 0; i < size; i++) this.spawn();
  }

  /** False once the pool has given up (crash loop / no workers) — callers go sync. */
  get enabled(): boolean {
    return !this.disabled && this.workers.size > 0;
  }

  /** Decide a bot move on a spare core. Rejects on timeout/crash — the caller
   *  MUST fall back to the synchronous decideBotMove path. */
  decide(view: BotView, tier: BotTier): Promise<BotMove> {
    if (!this.enabled) return Promise.reject(new Error('bot worker pool disabled'));
    return new Promise<BotMove>((resolve, reject) => {
      const job: Job = { id: this.nextId++, view, tier, resolve, reject, timer: null };
      const w = this.idle.pop();
      if (w) this.dispatch(w, job);
      else this.queue.push(job);
    });
  }

  /** Terminate all workers (tests / graceful shutdown). Pending jobs reject. */
  async shutdown(): Promise<void> {
    this.disabled = true;
    for (const job of this.queue.splice(0)) this.fail(job, new Error('pool shut down'));
    await Promise.allSettled([...this.workers].map((w) => w.terminate()));
    this.workers.clear();
    this.idle.length = 0;
  }

  private spawn(): void {
    if (this.disabled) return;
    try {
      // Inherits execArgv (tsx loader) by default, so the .ts worker loads in
      // dev, tests, and the tsx-run production container alike.
      const w = new Worker(new URL('./botWorker.ts', import.meta.url));
      // A worker must never keep the process alive on its own (tests, shutdown).
      w.unref();
      w.on('message', (msg: { id: number; ok: boolean; move?: BotMove; error?: string }) => {
        const job = this.inFlight.get(w);
        this.inFlight.delete(w);
        this.release(w);
        if (!job || job.id !== msg.id) return; // stale reply for a timed-out job — already handled
        if (job.timer) clearTimeout(job.timer);
        if (msg.ok && msg.move) job.resolve(msg.move);
        else job.reject(new Error(msg.error ?? 'bot worker error'));
      });
      const die = (why: string) => {
        const job = this.inFlight.get(w);
        this.inFlight.delete(w);
        this.workers.delete(w);
        const i = this.idle.indexOf(w);
        if (i >= 0) this.idle.splice(i, 1);
        if (job) this.fail(job, new Error(why));
        if (this.disabled) return;
        if (++this.respawns > MAX_RESPAWNS) {
          this.disabled = true;
          for (const q of this.queue.splice(0)) this.fail(q, new Error('pool disabled'));
          logger.error('[bot] worker pool crash loop — disabled, falling back to sync decisions');
          return;
        }
        logger.warn('[bot] worker died, respawning', { why });
        this.spawn();
      };
      w.on('error', (err) => die(err.message));
      w.on('exit', (code) => { if (code !== 0) die(`exit ${code}`); });
      this.workers.add(w);
      this.release(w);
    } catch (err) {
      // Spawn itself failed (missing file / restricted env) — sync fallback forever.
      this.disabled = true;
      logger.warn('[bot] worker spawn failed — bot decisions stay on the main thread', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private dispatch(w: Worker, job: Job): void {
    this.inFlight.set(w, job);
    job.timer = setTimeout(() => {
      // Too slow (cold start under load / stuck): give the turn back to the sync
      // path. The worker itself stays usable — its late reply is dropped by the
      // id check and it re-enters the idle list then.
      if (this.inFlight.get(w) === job) this.inFlight.delete(w);
      this.fail(job, new Error('bot worker timeout'));
    }, this.timeoutMs);
    job.timer.unref?.();
    w.postMessage({ id: job.id, view: job.view, tier: job.tier });
  }

  private release(w: Worker): void {
    if (this.disabled || !this.workers.has(w)) return;
    const next = this.queue.shift();
    if (next) this.dispatch(w, next);
    else this.idle.push(w);
  }

  private fail(job: Job, err: Error): void {
    if (job.timer) clearTimeout(job.timer);
    job.reject(err);
  }
}

/** Build the production pool sized to the host's spare cores (main thread keeps
 *  one). BOT_WORKERS overrides (0 disables → all decisions stay synchronous).
 *  Returns null when disabled so the gateway keeps the exact pre-pool behavior. */
export function createDefaultBotPool(): BotWorkerPool | null {
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  const raw = process.env.BOT_WORKERS;
  const parsed = raw == null || raw === '' ? null : Number.parseInt(raw, 10);
  const size = parsed != null && Number.isFinite(parsed)
    ? Math.max(0, Math.min(8, parsed))
    : Math.min(3, Math.max(1, cores - 1));
  if (size === 0) return null;
  const pool = new BotWorkerPool(size);
  if (!pool.enabled) return null;
  logger.info(`[bot] worker pool ENABLED — ${size} thread(s) for bot AI (cores=${cores}); event loop stays free`);
  return pool;
}
