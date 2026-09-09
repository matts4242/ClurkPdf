import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { getRedis } from './connection.js';
import { QUEUE_NAME, type ExtractInvoiceJob } from './documentQueue.js';
import { extractInvoice } from './processor.js';

/**
 * The worker, running inside the API process.
 *
 * One process is the right shape for a single VPS: the work is the same PDF
 * rendering the API already does, and a second container would double the
 * memory for no gain at this size. `BATCH_CONCURRENCY` bounds how much of it
 * happens at once. Because the queue is Redis-backed, moving the worker to its
 * own process later is a deployment change rather than a rewrite.
 */

let worker: Worker<ExtractInvoiceJob> | null = null;

export function startWorker(): Worker<ExtractInvoiceJob> {
  if (worker) return worker;

  worker = new Worker<ExtractInvoiceJob>(
    QUEUE_NAME,
    async (job: Job<ExtractInvoiceJob>) => {
      const attempts = job.opts.attempts ?? 1;
      return extractInvoice(job.data.documentId, job.data.batchId, {
        // attemptsMade counts the attempts before this one.
        finalAttempt: job.attemptsMade + 1 >= attempts,
      });
    },
    { connection: getRedis(), concurrency: config.batchConcurrency },
  );

  worker.on('failed', (job, error) => {
    console.error(`[batch] job ${job?.id ?? '?'} failed:`, error.message);
  });

  return worker;
}

export async function stopWorker(): Promise<void> {
  const running = worker;
  worker = null;
  if (running) await running.close().catch(() => undefined);
}
