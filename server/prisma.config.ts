import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 removed `url` from the datasource block, so migration and
 * introspection commands read the connection string from here instead. The
 * runtime client gets its connection through a driver adapter; see
 * `src/db/client.ts`.
 */

// The CLI does not load .env on its own. Node 22.13+ can do it natively, which
// keeps dotenv out of the dependency list.
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
