// Room-ownership registry (unit) + the gateway join-guard (integration). Proves a
// join landing on a NON-owning instance is rejected with 'wrong_instance' (the
// multi-instance hazard guard), while the single-instance no-op never false-rejects.

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
import { InMemoryRoomOwnership, type RoomOwnership } from './roomOwnership.ts';

test('InMemoryRoomOwnership: claim/release tracked; nothing is ever foreign (single instance)', () => {
  const o = new InMemoryRoomOwnership('inst-1');
  assert.equal(o.instanceId, 'inst-1');
  o.claim('room_1');
  assert.equal(o.isForeign('room_1'), false);
  assert.equal(o.isForeign('room_unknown'), false); // single-instance: never foreign
  o.release('room_1');
  assert.equal(o.isForeign('room_1'), false);
});

function once<T = any>(socket: any, event: string, ms = 2000): Promise<T> {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout ${event}`)), ms); socket.once(event, (d: T) => { clearTimeout(t); res(d); }); });
}
const emitAck = <T = any>(socket: any, event: string, ...args: any[]): Promise<T> =>
  new Promise((res) => socket.emit(event, ...args, (r: T) => res(r)));

async function harness(ownership: RoomOwnership) {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({ idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })() });
  new GameGateway(io, rooms, auth, { provablyFair: false, ownership });
  await new Promise<void>((r) => httpServer.listen(0, r));
  const port = (httpServer.address() as AddressInfo).port;
  const u = await auth.register({ username: 'player1', email: 'p1@x.com', password: 'password1' });
  const close = async () => {
    await new Promise<void>((r) => io.close(() => r())); // close server sockets first
    httpServer.closeAllConnections?.(); // force-drop any lingering keep-alive (Node ≥18.2)
    await new Promise<void>((r) => httpServer.close(() => r()));
  };
  return { port, token: u.tokens.accessToken, close };
}

test('join is rejected with wrong_instance when the room is owned by ANOTHER instance', async () => {
  // Fake ownership: every room is "owned elsewhere".
  const foreign: RoomOwnership = { instanceId: 'b', claim() {}, release() {}, isForeign: () => true };
  const h = await harness(foreign);
  const cli: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.token }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');
    const res = await emitAck(cli, 'room:join', { roomId: 'owned-by-a' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'wrong_instance');
  } finally {
    cli.close();
    await h.close();
  }
});

test('single-instance ownership never false-rejects a join (falls through to normal handling)', async () => {
  const h = await harness(new InMemoryRoomOwnership());
  const cli: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.token }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');
    // Joining a non-existent room → normal no_room (NOT wrong_instance).
    const res = await emitAck(cli, 'room:join', { roomId: 'room_does_not_exist' });
    assert.equal(res.ok, false);
    assert.notEqual(res.error.code, 'wrong_instance');
  } finally {
    cli.close();
    await h.close();
  }
});
