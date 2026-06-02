// Entrypoint: boot the Murlan game server (HTTP + Socket.IO).
import { createGameServer } from './app.ts';
import { loadConfig } from './config.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = await createGameServer({ config });
  await server.listen();
  // eslint-disable-next-line no-console
  console.log(`Murlan server listening on http://${config.host}:${config.port} (${config.nodeEnv})`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received — shutting down.`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
