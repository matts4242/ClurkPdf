import { createApp } from './app.js';
import { config } from './config.js';
import { connectDatabase, disconnectDatabase } from './db/client.js';
import { closeEventBus } from './events/bus.js';
import { attachWebSocketServer, closeWebSocketServer } from './events/wsServer.js';
import { closeRedisConnections, pingRedis } from './queue/connection.js';
import { closeQueue, enqueuePending, startWorker } from './queue/documentQueue.js';
import { terminateOcr } from './services/ocrService.js';
import { count, resetInterruptedProcessing } from './services/documentStore.js';
import { ensureUploadsDirectory } from './services/pdfService.js';

async function main(): Promise<void> {
  await ensureUploadsDirectory();

  await connectDatabase();
  await pingRedis().catch((error: unknown) => {
    throw new Error(
      `Could not reach Redis at ${config.redisUrl}. The processing queue needs it.\n` +
        `Start one with: docker compose up -d\n  ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  });

  // A job that died with the last process is simply run again — that
  // durability is the point of the queue. Week 1 through 4 could only mark
  // these failed.
  const recovered = await resetInterruptedProcessing();
  const documents = await count();

  startWorker();
  const requeued = await enqueuePending();

  const server = createApp().listen(config.port, () => {
    console.log('');
    console.log('  Invoice Processor API');
    console.log(`  Server      http://localhost:${config.port}`);
    console.log(`  WebSocket   ws://localhost:${config.port}/ws`);
    console.log(`  Client      ${config.allowedOrigins.join(', ')}`);
    console.log(`  Uploads     ${config.uploadsDir}`);
    console.log(`  Database    ${redactUrl(config.databaseUrl)}`);
    console.log(`  Queue       ${redactUrl(config.redisUrl)} (${config.queueConcurrency} at a time)`);
    console.log(`  Max upload  ${Math.round(config.maxFileSize / (1024 * 1024))}MB`);
    console.log(`  Documents   ${documents} stored`);
    if (recovered.length > 0) {
      console.log(`  Recovered   ${recovered.length} interrupted document(s) returned to the queue`);
    }
    if (requeued > 0) {
      console.log(`  Queued      ${requeued} document(s) waiting to be processed`);
    }
    console.log('');
  });

  attachWebSocketServer(server);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, closing server...`);

    // Do not let an open keep-alive connection hold the process forever.
    setTimeout(() => process.exit(1), 10_000).unref();

    void (async () => {
      // The order matters, and the WebSocket comes first: `server.close`
      // waits for open connections to end, and a watching browser's socket
      // is open by design. Closing it inside the `close` callback would mean
      // waiting for a socket that is waiting for that callback, and every
      // shutdown would take the ten seconds above.
      await closeWebSocketServer().catch(() => undefined);
      // Stop accepting work before tearing down what does it.
      await closeQueue().catch(() => undefined);

      const closed = await new Promise<Error | undefined>((resolve) => {
        server.close((error) => resolve(error));
      });

      await closeEventBus().catch(() => undefined);
      await closeRedisConnections().catch(() => undefined);
      // Tesseract workers hold WASM instances that keep the process alive.
      await terminateOcr().catch(() => undefined);
      await disconnectDatabase().catch(() => undefined);

      if (closed) {
        console.error('Error during shutdown:', closed);
        process.exit(1);
      }
      process.exit(0);
    })();
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
    return '(unparseable URL)';
  }
}

main().catch((error: unknown) => {
  console.error('Failed to start server:', error instanceof Error ? error.message : error);
  process.exit(1);
});
