import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach } from 'vitest';

/**
 * Per-file test setup: pick safe locations for data, then start each test from
 * an empty schema.
 *
 * The uploads directory, the database and the queue must all be redirected
 * before anything imports `config.js`, which reads the environment once at
 * load time. That is why this runs as a vitest setup file rather than in a
 * `beforeAll`.
 */

// --- Queue ---------------------------------------------------------------

// A prefix unique to this file's run, so a suite can never drain a developer's
// development queue and two test files cannot see each other's jobs.
const queuePrefix = `invoice-test-${randomUUID().slice(0, 8)}`;
process.env.QUEUE_PREFIX = queuePrefix;

/** The Redis key prefix this run's queue and event bus are using. */
export const TEST_QUEUE_PREFIX = queuePrefix;

// --- Uploads -------------------------------------------------------------

const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-test-uploads-'));
process.env.UPLOADS_DIR = uploadsDir;

/** Absolute path of this run's throwaway uploads root. */
export const TEST_UPLOADS_DIR = uploadsDir;

// --- Database ------------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL ?? '';

const databaseName = (() => {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();

// Refuse to touch anything that is not obviously a throwaway database. Every
// test truncates, so pointing this at a development database would erase it.
if (!databaseName.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests against database "${databaseName || '(unset)'}": ` +
      'the name must end in "_test". Set TEST_DATABASE_URL to a dedicated database.',
  );
}

const { getPrisma, disconnectDatabase } = await import('../db/client.js');

beforeEach(async () => {
  // Regions cascade from documents, so one truncate clears both. Batches are
  // separate — a document's batch link is SetNull, not a cascade.
  await getPrisma().$executeRawUnsafe('TRUNCATE "Document", "Batch" CASCADE');
});

afterAll(async () => {
  const { closeQueue } = await import('../queue/documentQueue.js');
  const { closeEventBus } = await import('../events/bus.js');
  const { closeRedisConnections } = await import('../queue/connection.js');
  const { closeWebSocketServer } = await import('../events/wsServer.js');

  // Redis connections are kept alive by design, so nothing here exits until
  // they are closed explicitly.
  await closeWebSocketServer().catch(() => undefined);
  await closeQueue().catch(() => undefined);
  await closeEventBus().catch(() => undefined);
  await closeRedisConnections().catch(() => undefined);

  await disconnectDatabase();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});
