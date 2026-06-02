// Lazily-created PrismaClient singleton. Only imported when DATABASE_URL is set
// (the in-memory path never loads @prisma/client). Run `npm run db:generate`
// in the server package after changing the schema.
import { PrismaClient } from '@prisma/client';

let client: PrismaClient | null = null;

export function getPrisma(databaseUrl: string): PrismaClient {
  if (!client) {
    client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }
  return client;
}

export type { PrismaClient };
