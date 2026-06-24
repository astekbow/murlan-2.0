// Optional Redis adapter for Socket.IO — enables broadcasting across multiple
// server instances and shared pub/sub (spec §1, §7). Activated only when
// REDIS_URL is configured; the app runs single-instance in-memory otherwise.

import type { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

/** Attach the Redis adapter to `io`; returns a disposer that closes connections. */
export async function attachRedisAdapter(io: Server, url: string): Promise<() => Promise<void>> {
  const pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
  const sub = pub.duplicate();
  // CRITICAL: ioredis clients are EventEmitters — an 'error' with NO listener re-throws
  // as an uncaught exception and kills the process (taking every live match with it).
  // A transient Redis blip must be logged, not fatal; ioredis reconnects on its own.
  pub.on('error', (e) => console.error('[redis:pub] connection error:', e?.message ?? e));
  sub.on('error', (e) => console.error('[redis:sub] connection error:', e?.message ?? e));
  io.adapter(createAdapter(pub, sub));
  return async () => {
    await pub.quit();
    await sub.quit();
  };
}
