// ============================================================================
// MURLAN — tiny structured logger (arch-3)
// ----------------------------------------------------------------------------
// The single logging abstraction for code OUTSIDE a Fastify request (boot,
// services, background jobs, the gateway). Fastify itself already logs requests
// via pino with redaction; this is the ONE place raw `console` is allowed, so
// every other module logs through `log.*` instead of scattering `console.*` +
// per-line eslint-disables. Keeps console's variadic call shape (drop-in), adds
// a level tag + LOG_LEVEL filtering (debug < info < warn < error; default info).
// ============================================================================

/* eslint-disable no-console */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = ORDER[(process.env.LOG_LEVEL as Level | undefined) ?? 'info'] ?? ORDER.info;

function emit(level: Level, sink: (...a: unknown[]) => void, args: unknown[]): void {
  if (ORDER[level] < THRESHOLD) return;
  sink(`[${level}]`, ...args);
}

/** Structured-ish app logger. Same call shape as console — `log.error(msg, meta?, err?)`. */
export const log = {
  debug: (...args: unknown[]): void => emit('debug', console.debug, args),
  info: (...args: unknown[]): void => emit('info', console.info, args),
  warn: (...args: unknown[]): void => emit('warn', console.warn, args),
  error: (...args: unknown[]): void => emit('error', console.error, args),
};
