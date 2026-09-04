import { createApp } from './app.js';
import { config } from './config.js';
import { loadFromDisk } from './services/documentStore.js';
import { ensureUploadsDirectory } from './services/pdfService.js';

async function main(): Promise<void> {
  await ensureUploadsDirectory();
  const restored = await loadFromDisk();

  const server = createApp().listen(config.port, () => {
    console.log('');
    console.log('  Invoice Processor API');
    console.log(`  Server      http://localhost:${config.port}`);
    console.log(`  Client      ${config.allowedOrigins.join(', ')}`);
    console.log(`  Uploads     ${config.uploadsDir}`);
    console.log(`  Max upload  ${Math.round(config.maxFileSize / (1024 * 1024))}MB`);
    console.log(`  Documents   ${restored} restored from disk`);
    console.log('');
  });

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received, closing server...`);
    server.close((error) => {
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

main().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
