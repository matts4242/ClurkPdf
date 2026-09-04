import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Bring the test database up to the current schema before any test runs.
 *
 * `migrate deploy` applies committed migrations without prompting, which is
 * what both CI and a developer's first run need.
 */
export default function setup(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set for the test run');
  }

  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: SERVER_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
  } catch (error) {
    const detail =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: Buffer }).stderr ?? error.message)
        : String(error);
    throw new Error(
      `Could not migrate the test database.\n` +
        `Is PostgreSQL running and reachable at the URL below?\n` +
        `  ${redact(databaseUrl)}\n` +
        `Start one with: docker compose up -d\n\n${detail}`,
    );
  }
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}
