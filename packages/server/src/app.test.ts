import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { createGameServer } from './app.ts';
import { loadConfig } from './config.ts';
import { InMemoryUserRepository } from './auth/userRepository.ts';

const STRONG = (c: string) => c.repeat(40);
const prodBase: Record<string, string> = {
  NODE_ENV: 'production', PORT: '0',
  JWT_ACCESS_SECRET: STRONG('a'), JWT_REFRESH_SECRET: STRONG('r'), PAYMENT_WEBHOOK_SECRET: STRONG('w'),
  KYC_REQUIRED: 'false', MIN_AGE: '0', GEO_BLOCKED_COUNTRIES: '', RESPONSIBLE_GAMING: 'false',
  RESEND_API_KEY: 'test-resend-key', // non-console email provider (passes the prod email guard)
};

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

test('observability: /health, /ready (no DB → db:null) and /metrics are served', async () => {
  const config = loadConfig({ NODE_ENV: 'test', PORT: '0' } as NodeJS.ProcessEnv);
  const server = await createGameServer({ config }); // in-memory (no DATABASE_URL)
  await server.listen();
  const port = (server.app.server.address() as AddressInfo).port;
  try {
    const health = await fetch(`http://localhost:${port}/health`);
    assert.equal(health.status, 200);

    const ready = await fetch(`http://localhost:${port}/ready`);
    assert.equal(ready.status, 200); // no DB configured → not "down"
    assert.deepEqual(await ready.json(), { ok: true, db: null });

    const metrics = await fetch(`http://localhost:${port}/metrics`);
    assert.equal(metrics.status, 200);
    const body = await metrics.text();
    assert.match(body, /murlan_http_request_duration_seconds/); // our histogram is registered
    assert.match(body, /process_cpu_seconds_total/); // default process metrics present
    // The live-state gauges + money-safety counters are registered (present at 0).
    assert.match(body, /murlan_active_matches/);
    assert.match(body, /murlan_socket_connections/);
    assert.match(body, /murlan_pending_withdrawals/);
    assert.match(body, /murlan_settlement_failures_total/);
  } finally {
    await server.close();
  }
});

// ----- #3 legacy shared-address deposit boot guard -------------------------
test('#3 prod REFUSES to boot with a shared TRON_DEPOSIT_ADDRESS and no xpub', async () => {
  const config = loadConfig({ ...prodBase, TRON_DEPOSIT_ADDRESS: 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6' } as NodeJS.ProcessEnv);
  // Inject an in-memory user repo so the DB-required prod throw doesn't fire first; the
  // deposit-rail guard is what we're isolating.
  await assert.rejects(
    () => createGameServer({ config, userRepository: new InMemoryUserRepository() }),
    /claim-jackable|TRON_DEPOSIT_XPUB/,
  );
});

test('#3 prod boots fine with a TRON_DEPOSIT_XPUB (unique per-player addresses)', async () => {
  // A valid account-level TRON xpub (watch-only test vector — see tronHd.test.ts).
  const xpub = 'xpub6EuK4CZWW5urEHdwAVDdDw327danAtccFcrXYvgf1DHrPXRwErt36xStQ2PNhn4hpwzPbzJ8pJVpewgChRnSs59q5Ay61GCfQZKUe71gbLq';
  const config = loadConfig({ ...prodBase, TRON_DEPOSIT_XPUB: xpub } as NodeJS.ProcessEnv);
  const server = await createGameServer({ config, userRepository: new InMemoryUserRepository() });
  await server.close();
});

test('graceful drain: /ready → 503 and new matches are rejected while draining', async () => {
  const config = loadConfig({ NODE_ENV: 'test', PORT: '0', COUNTDOWN_MS: '20' } as NodeJS.ProcessEnv);
  const server = await createGameServer({ config });
  await server.listen();
  const port = (server.app.server.address() as AddressInfo).port;
  try {
    const reg = await fetch(`http://localhost:${port}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'drainuser', email: 'drain@example.com', password: 'password123' }),
    });
    const { accessToken } = (await reg.json()) as { accessToken: string };
    const sock: any = ioClient(`http://localhost:${port}`, { auth: { token: accessToken }, transports: ['websocket'], forceNew: true });
    await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('connect timeout')), 2000); sock.once('connect', () => { clearTimeout(t); res(); }); });

    assert.equal((await fetch(`http://localhost:${port}/ready`)).status, 200); // healthy before draining

    server.setDraining(true);
    const ready = await fetch(`http://localhost:${port}/ready`);
    assert.equal(ready.status, 503);
    assert.equal(((await ready.json()) as { draining?: boolean }).draining, true);

    // A new match is refused while draining (existing matches would be allowed to finish).
    const created = await new Promise<any>((resolve) => sock.emit('room:create', { type: '1v1', stakeCents: 0 }, resolve));
    assert.equal(created.ok, false);
    assert.equal(created.error.code, 'draining');

    sock.close();
  } finally {
    await server.close();
  }
});
