import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { config } from '../config.js';

/**
 * The shared Prisma client.
 *
 * Prisma 7 takes its connection through a driver adapter rather than a URL in
 * the schema, so the `pg` pool below is the single place the database
 * connection is configured at runtime.
 */

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (client) return client;

  if (!config.databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy server/.env.example to server/.env, or export it in the environment.',
    );
  }

  const adapter = new PrismaPg({
    connectionString: config.databaseUrl,
    max: config.databasePoolSize,
  });

  client = new PrismaClient({
    adapter,
    log: config.isProduction || config.isTest ? ['error'] : ['error', 'warn'],
  });

  return client;
}

/** Verify the database is reachable. Called once at startup so a bad URL fails loudly. */
export async function connectDatabase(): Promise<void> {
  await getPrisma().$queryRaw`SELECT 1`;
}

/** Close the pool. Called from the shutdown handler. */
export async function disconnectDatabase(): Promise<void> {
  if (!client) return;
  const closing = client;
  client = null;
  await closing.$disconnect();
}
