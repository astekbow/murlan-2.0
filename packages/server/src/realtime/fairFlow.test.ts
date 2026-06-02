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
import { verifyCommitment } from '../fair/provablyFair.ts';

function once<T = any>(socket: any, event: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (d: T) => { clearTimeout(t); resolve(d); });
  });
}
function emitAck<T = any>(socket: any, event: string, ...args: any[]): Promise<T> {
  return new Promise((resolve) => socket.emit(event, ...args, (r: T) => resolve(r)));
}

test('provably-fair: clients get a commit at match start and a verifiable reveal at match end', async () => {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({ startTarget: 100, idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })() });
  // provablyFair defaults to true; no money so we can end via a forfeit.
  new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: 5_000 });

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u1 = await auth.register({ username: 'alpha', email: 'a@a.com', password: 'password1' });
  const u2 = await auth.register({ username: 'beta', email: 'b@b.com', password: 'password2' });

  const c1: any = ioClient(`http://localhost:${port}`, { auth: { token: u1.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  const c2: any = ioClient(`http://localhost:${port}`, { auth: { token: u2.tokens.accessToken }, transports: ['websocket'], forceNew: true });

  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);

    // Clients contribute their seed ONLY AFTER receiving the commitment — that
    // ordering is what makes the deal un-grindable.
    c1.on('fair:commit', () => c1.emit('fair:clientSeed', 'alpha-seed'));
    c2.on('fair:commit', () => c2.emit('fair:clientSeed', 'beta-seed'));

    await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 0 });
    await emitAck(c2, 'room:join', { roomId: 'room_1' });

    const commitP = once(c1, 'fair:commit'); // emitted at countdown start, before deals
    const startedP = once(c1, 'match:start'); // emitted when the match actually begins
    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);
    const commit = await commitP;
    assert.ok(commit.serverSeedHash.length === 64); // sha256 hex committed before any clientSeed
    await startedP; // ensure the match is in progress before forfeiting

    // End the match (forfeit by leaving) to trigger the reveal.
    const revealP = once(c1, 'fair:reveal');
    await emitAck(c2, 'room:leave');
    const reveal = await revealP;

    // The revealed serverSeed must match the earlier commitment, and the reveal
    // is self-contained (numPlayers) so every deal is independently verifiable.
    assert.equal(reveal.serverSeedHash, commit.serverSeedHash);
    assert.equal(reveal.numPlayers, 2);
    assert.ok(verifyCommitment(reveal.serverSeed, reveal.serverSeedHash));
  } finally {
    c1.close();
    c2.close();
    io.close();
    await new Promise<void>((res) => httpServer.close(() => res()));
  }
});
