// Typed Socket.IO client. Same-origin in dev (Vite proxies /socket.io to the
// server); the access token rides in the handshake `auth`.

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@murlan/shared';
import { errText } from './errors.ts';

export type MurlanSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Open the socket. `getToken` is called by Socket.IO on the initial connect AND
 * on every reconnection attempt, so a token refreshed in the meantime is used
 * automatically — a stale handshake token no longer locks the user out forever.
 */
export function connectSocket(getToken: () => string | null): MurlanSocket {
  return io({
    auth: (cb) => cb({ token: getToken() ?? '' }),
    transports: ['websocket'],
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    // Exponential backoff with a cap, so a long outage doesn't hammer the server /
    // drain the device battery at a fixed short interval (delay grows 500ms → 10s).
    reconnectionDelayMax: 10_000,
    randomizationFactor: 0.5,
  });
}

/**
 * Emit an event that expects an ack and resolve with the ack payload.
 * Typed loosely on purpose — the event maps enforce shapes at the call sites
 * that matter (the store), and this keeps the variadic ack ergonomics simple.
 */
const ACK_TIMEOUT_MS = 8_000;

export function request<T = { ok: boolean; error?: { code: string; message: string }; roomId?: string }>(
  socket: MurlanSocket,
  event: string,
  ...args: unknown[]
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (res: T) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(res);
    };
    // If the ack is dropped (e.g. on a flaky connection) surface a failure ack
    // instead of leaving the UI waiting forever.
    const timer = window.setTimeout(
      () => done({ ok: false, error: { code: 'timeout', message: errText('timeout') } } as T), // localized via err.timeout
      ACK_TIMEOUT_MS,
    );
    (socket as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args, (res: T) => done(res));
  });
}
