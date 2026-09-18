import { defineConfig } from 'vitest/config';

/**
 * The suite runs against a real PostgreSQL database.
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
 * Week 5 adds Redis. Each test file namespaces its own keys under a random
 * prefix (see `src/test/setup.ts`), so this only has to say where Redis is.
 */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

// `test.env` reaches the worker processes but not globalSetup, which runs in
// the main process and needs the URL to apply migrations.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = TEST_REDIS_URL;

export default defineConfig({
  test: {
    globalSetup: ['./src/test/globalSetup.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // One shared database, so files must not race each other.
    fileParallelism: false,
    // Queue tests wait on a real worker draining a real Redis queue.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
    },
  },
});
