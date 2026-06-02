import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { createGameServer } from './app.ts';
import { loadConfig } from './config.ts';

const creds = { username: 'endtoend', email: 'e2e@example.com', password: 'password123' };

test('end-to-end: HTTP register issues a token that authenticates a socket and creates a room', async () => {
  const config = loadConfig({ NODE_ENV: 'test', PORT: '0', COUNTDOWN_MS: '20' } as NodeJS.ProcessEnv);
  const server = await createGameServer({ config });
  await server.listen();
  const port = (server.app.server.address() as AddressInfo).port;

  try {
    // Health check on the shared HTTP server.
    const health = await fetch(`http://localhost:${port}/health`);
    assert.equal(health.status, 200);

    // Register via REST → receive an access token.
    const reg = await fetch(`http://localhost:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(creds),
    });
    assert.equal(reg.status, 201);
    const { accessToken } = (await reg.json()) as { accessToken: string };
    assert.ok(accessToken.length > 0);

    // The same token authenticates the Socket.IO handshake.
    const sock: any = ioClient(`http://localhost:${port}`, {
      auth: { token: accessToken },
      transports: ['websocket'],
      forceNew: true,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timeout')), 2_000);
      sock.once('connect', () => { clearTimeout(t); resolve(); });
      sock.once('connect_error', (e: Error) => { clearTimeout(t); reject(e); });
    });

    const created = await new Promise<any>((resolve) =>
      sock.emit('room:create', { type: '1v1', stakeCents: 500 }, resolve),
    );
    assert.ok(created.ok);
    assert.ok(typeof created.roomId === 'string');

    // The created room shows up in the lobby.
    const lobby = await new Promise<any>((resolve) => sock.emit('lobby:list', resolve));
    assert.equal(lobby.rooms.length, 1);
    assert.equal(lobby.rooms[0].type, '1v1');

    sock.close();
  } finally {
    await server.close();
  }
});
