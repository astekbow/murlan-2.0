// ============================================================================
// Reproduction: does a STAKED 1v1 actually start against the live stack?
// Spins nothing up itself — connects to a server already listening on :3000.
// Funds two throwaway users $10 each via the Prisma WalletService, drives two
// socket clients through create→join→ready, and logs every server event.
// Cleans up the throwaway users/matches/tx afterwards.
// ============================================================================

import { io, type Socket } from 'socket.io-client';
import { getPrisma } from '../src/db/prismaClient.ts';
import { createPrismaStores } from '../src/db/prismaRepositories.ts';
import { WalletService } from '../src/money/walletService.ts';

const BASE = process.env.REPRO_BASE ?? 'http://localhost:3000';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const stamp = Date.now();
const A = { username: `repa_${stamp}`, email: `repa_${stamp}@x.com`, password: 'supersecret1' };
const B = { username: `repb_${stamp}`, email: `repb_${stamp}@x.com`, password: 'supersecret1' };

async function register(u: { username: string; email: string; password: string }): Promise<{ token: string; id: string }> {
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(u),
  });
  const j = await r.json();
  if (r.status !== 201) throw new Error(`register ${u.username} failed: ${r.status} ${JSON.stringify(j)}`);
  return { token: j.accessToken, id: j.user.id };
}

function wire(name: string, socket: Socket, log: string[]): void {
  for (const ev of ['room:state', 'match:start', 'game:start', 'fair:commit', 'error']) {
    socket.on(ev, (payload: unknown) => {
      let brief = '';
      if (ev === 'error') brief = JSON.stringify(payload);
      else if (ev === 'match:start' || ev === 'room:state') {
        const p = payload as { id?: string; status?: string; countdownMs?: number; seats?: unknown[] };
        brief = `status=${p.status} countdown=${p.countdownMs ?? '-'} seats=${Array.isArray(p.seats) ? p.seats.length : '?'}`;
      } else if (ev === 'game:start') brief = 'PRIVATE HAND DEALT';
      else if (ev === 'fair:commit') brief = 'commit';
      log.push(`[${name}] ${ev}: ${brief}`);
    });
  }
}

async function main(): Promise<void> {
  // 1) Fund two throwaway users.
  const db = getPrisma(url!);
  const stores = createPrismaStores(db);
  const wallet = new WalletService(stores.users, stores.ledger, stores.uow);

  const ra = await register(A);
  const rb = await register(B);
  await wallet.credit(ra.id, 1000, { type: 'admin_adjust', reason: 'repro fund' });
  await wallet.credit(rb.id, 1000, { type: 'admin_adjust', reason: 'repro fund' });
  console.log(`funded ${A.username}=$${(await wallet.getBalance(ra.id)) / 100}  ${B.username}=$${(await wallet.getBalance(rb.id)) / 100}`);

  // 2) Connect both sockets.
  const log: string[] = [];
  const sa = io(BASE, { auth: { token: ra.token }, transports: ['websocket'], forceNew: true });
  const sb = io(BASE, { auth: { token: rb.token }, transports: ['websocket'], forceNew: true });
  wire('A', sa, log);
  wire('B', sb, log);
  await Promise.all([
    new Promise<void>((res, rej) => { sa.on('connect', () => res()); sa.on('connect_error', (e) => rej(new Error('A connect_error: ' + e.message))); }),
    new Promise<void>((res, rej) => { sb.on('connect', () => res()); sb.on('connect_error', (e) => rej(new Error('B connect_error: ' + e.message))); }),
  ]);
  console.log('both sockets connected');

  // 3) A creates a $5 staked 1v1, B joins.
  const created = await new Promise<{ ok: boolean; roomId?: string; error?: unknown }>((res) =>
    sa.emit('room:create', { type: '1v1', stakeCents: 500 }, (ack: { ok: boolean; roomId?: string; error?: unknown }) => res(ack)));
  console.log('room:create ack =', JSON.stringify(created));
  if (!created.ok || !created.roomId) throw new Error('create failed');
  const roomId = created.roomId;

  const joined = await new Promise<{ ok: boolean; error?: unknown }>((res) =>
    sb.emit('room:join', { roomId }, (ack: { ok: boolean; error?: unknown }) => res(ack)));
  console.log('room:join ack =', JSON.stringify(joined));

  // 4) Both contribute a client seed (provably-fair) then ready up.
  sa.emit('fair:clientSeed', 'seed-a-' + stamp);
  sb.emit('fair:clientSeed', 'seed-b-' + stamp);
  const readyA = await new Promise((res) => sa.emit('room:ready', true, (a: unknown) => res(a)));
  const readyB = await new Promise((res) => sb.emit('room:ready', true, (a: unknown) => res(a)));
  console.log('room:ready acks =', JSON.stringify(readyA), JSON.stringify(readyB));

  // 5) Wait through the countdown + escrow + deal.
  await new Promise((res) => setTimeout(res, 7000));

  console.log('\n--- event log ---');
  for (const line of log) console.log(line);
  const started = log.some((l) => l.includes('match:start') && l.includes('inMatch')) || log.some((l) => l.includes('game:start'));
  const errors = log.filter((l) => l.includes('error:'));
  console.log('\nRESULT:', started ? '✅ MATCH STARTED' : '❌ MATCH DID NOT START');
  if (errors.length) console.log('ERRORS SEEN:', errors.join(' | '));
  console.log('final balances: A=$' + (await wallet.getBalance(ra.id)) / 100 + ' B=$' + (await wallet.getBalance(rb.id)) / 100);

  // 6) Cleanup.
  sa.close(); sb.close();
  for (const id of [ra.id, rb.id]) {
    await db.transaction.deleteMany({ where: { userId: id } });
    await db.match.deleteMany({ where: { players: { some: { userId: id } } } }).catch(() => undefined);
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
  // also drop any match rows that reference the repro room
  await db.match.deleteMany({ where: { id: { startsWith: roomId + '-' } } }).catch(() => undefined);
  console.log('cleaned up.');
  await db.$disconnect();
}

main().then(() => process.exit(0), (e) => { console.error('repro error:', e); process.exit(1); });
