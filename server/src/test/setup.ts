import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach } from 'vitest';

/**
 * Per-file test setup: pick safe locations for data, then start each test from
 * an empty schema.
 *
 * Both the uploads directory and the database must be redirected before
 * anything imports `config.js`, which reads the environment once at load time.
 * That is why this runs as a vitest setup file rather than in a `beforeAll`.
 */

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
  // Regions cascade from documents, so one truncate clears both tables.
  await getPrisma().$executeRawUnsafe('TRUNCATE "Document" CASCADE');
});

afterAll(async () => {
  await disconnectDatabase();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});
