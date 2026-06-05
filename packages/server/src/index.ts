// Entrypoint: boot the Murlan game server (HTTP + Socket.IO).
import { createGameServer } from './app.ts';
import { loadConfig } from './config.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = await createGameServer({ config });
  await server.listen();
  // eslint-disable-next-line no-console
  console.log(`Murlan server listening on http://${config.host}:${config.port} (${config.nodeEnv})`);

  // Graceful drain on deploy/stop: stop accepting NEW matches (/ready → 503 so the
  // LB drains us), let in-flight matches finish within the grace, then refund any
  // still-escrowed pot and close — no stranded stakes, no mid-hand kills. Guard
  // against a second signal forcing an abrupt exit during the drain.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — draining (grace ${config.abandonMs}ms), then shutting down.`);
    try {
      const refunded = await server.drain(config.abandonMs);
      if (refunded) console.log(`drain: refunded ${refunded} in-flight match(es).`);
    } catch (err) {
      console.error('drain failed, closing anyway:', err);
      await server.close().catch(() => {});
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
