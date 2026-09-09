import { defineConfig } from 'vitest/config';

/**
 * The suite runs against a real PostgreSQL database and a real Redis.
 *
 * DATABASE_URL is set here rather than read from `.env`, and
 * `process.loadEnvFile` never overrides a variable that is already set, so the
 * development database can not be reached from a test run. `src/test/setup.ts`
 * additionally refuses any URL whose database name does not end in `_test`.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://invoice:password@127.0.0.1:5433/invoice_processor_test?schema=public';

/**
 * Redis database 1, so a queue running in a development server on database 0
 * cannot pick up jobs the tests enqueued, or the other way round.
 */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1';

// `test.env` reaches the worker processes but not globalSetup, which runs in
// the main process and needs the URL to apply migrations.
process.env.DATABASE_URL = TEST_DATABASE_URL;

export default defineConfig({
  test: {
    globalSetup: ['./src/test/globalSetup.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // One shared database, so files must not race each other.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
    },
  },
});
