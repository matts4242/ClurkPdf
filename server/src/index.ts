import { createApp } from './app.js';
import { config } from './config.js';
import { connectDatabase, disconnectDatabase } from './db/client.js';
import { count, failInterruptedProcessing } from './services/documentStore.js';
import { ensureUploadsDirectory } from './services/pdfService.js';

async function main(): Promise<void> {
  await ensureUploadsDirectory();

  await connectDatabase();
  const stranded = await failInterruptedProcessing();
  const documents = await count();

  const server = createApp().listen(config.port, () => {
    console.log('');
    console.log('  Invoice Processor API');
    console.log(`  Server      http://localhost:${config.port}`);
    console.log(`  Client      ${config.allowedOrigins.join(', ')}`);
    console.log(`  Uploads     ${config.uploadsDir}`);
    console.log(`  Database    ${redactUrl(config.databaseUrl)}`);
    console.log(`  Max upload  ${Math.round(config.maxFileSize / (1024 * 1024))}MB`);
    console.log(`  Documents   ${documents} stored`);
    if (stranded > 0) {
      console.log(`  Recovered   ${stranded} interrupted upload(s) marked as failed`);
    }
    console.log('');
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, closing server...`);

    server.close(async (error) => {
      await disconnectDatabase().catch(() => undefined);
      if (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
      }
      process.exit(0);
    });

    // Do not let an open keep-alive connection hold the process forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });
}

/** Hide the password before a connection string reaches the logs. */
function redactUrl(url: string): string {
  if (!url) return '(not configured)';
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

main().catch((error: unknown) => {
  console.error('Failed to start server:', error instanceof Error ? error.message : error);
  process.exit(1);
});
