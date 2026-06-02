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
  io.adapter(createAdapter(pub, sub));
  return async () => {
    await pub.quit();
    await sub.quit();
  };
}
