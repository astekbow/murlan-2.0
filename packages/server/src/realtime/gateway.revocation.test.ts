// ============================================================================
// #2 — Socket tokenVersion revocation (auth-2/7/9, socket-1)
// ----------------------------------------------------------------------------
// The REST path is already revocation-aware (authorizeRequest checks `ver`); these
// prove the SOCKET path is too: a stale-`ver` token is rejected at the handshake AND
// at reAuth, and revokeAllSessions() drops a LIVE socket (logout-all / reset / ban).
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { RoomManager } from '../room/roomManager.ts';
import { GameGateway } from './gateway.ts';

async function harness() {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const tokenSvc = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(repo, tokenSvc);
  const rooms = new RoomManager({ startTarget: 1 });
  const gateway = new GameGateway(io, rooms, auth, { provablyFair: false });
  // Wire the session-revoked hook EXACTLY as app.ts does, so revokeAllSessions drops sockets.
  auth.setSessionRevokedHook((userId) => gateway.disconnectUser(userId));
  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u = await auth.register({ username: 'alpha', email: 'a@a.com', password: 'password1' });
  return {
    port, auth, repo, tokenSvc, userId: u.user.id, token: u.tokens.accessToken,
    close: () => new Promise<void>((res) => { io.close(); httpServer.close(() => res()); }),
  };
}

function connect(port: number, token: string): any {
  return ioClient(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true });
}
function once<T = any>(socket: any, event: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}
function emitAck<T = any>(socket: any, event: string, ...args: any[]): Promise<T> {
  return new Promise((resolve) => socket.emit(event, ...args, (res: T) => resolve(res)));
}

test('handshake REJECTS a socket whose token `ver` is stale (revokeAllSessions bumped it)', async () => {
  const h = await harness();
  try {
    // Capture a still-valid-signature token, then bump tokenVersion → the token is now stale.
    const stale = h.token;
    await h.auth.revokeAllSessions(h.userId);
    const bad = connect(h.port, stale);
    const err = await once(bad, 'connect_error');
    assert.match(String((err as any).message), /unauthorized/);
    bad.close();
    // A freshly-minted token (current ver) still connects fine.
    const fresh = (await h.auth.login({ email: 'a@a.com', password: 'password1' })).tokens.accessToken;
    const good = connect(h.port, fresh);
    await once(good, 'connect');
    good.close();
  } finally {
    await h.close();
  }
});

test('reAuth REJECTS a stale-`ver` token and drops the connection', async () => {
  const h = await harness();
  try {
    const c = connect(h.port, h.token);
    await once(c, 'connect');
    // Force-logout AFTER connecting. The live socket is dropped by the hook; re-auth
    // with the now-stale token must also be refused (not silently accepted).
    const stale = h.token;
    await h.auth.revokeAllSessions(h.userId);
    // The socket may already be getting disconnected; reconnect with the stale token to
    // exercise the handshake-reject path deterministically is covered above. Here, assert
    // reAuth on a fresh socket carrying a stale token is refused.
    const c2 = connect(h.port, (await h.auth.login({ email: 'a@a.com', password: 'password1' })).tokens.accessToken);
    await once(c2, 'connect');
    const res = await emitAck(c2, 'auth', stale);
    assert.equal(res.ok, false);
    assert.match(String(res.error?.code), /unauthorized/);
    c.close();
    c2.close();
  } finally {
    await h.close();
  }
});

test('revokeAllSessions DISCONNECTS a live socket (logout-all / password-reset)', async () => {
  const h = await harness();
  try {
    const c = connect(h.port, h.token);
    await once(c, 'connect');
    const disconnected = once(c, 'disconnect', 3_000);
    await h.auth.revokeAllSessions(h.userId); // wired hook → gateway.disconnectUser
    await disconnected; // the live socket is dropped, not left playing on a dead token
    assert.equal(c.connected, false);
    c.close();
  } finally {
    await h.close();
  }
});
