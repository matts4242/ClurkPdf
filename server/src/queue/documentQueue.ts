import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { publishEvent } from '../events/bus.js';
import * as store from '../services/documentStore.js';
import { failDocument, processDocument } from '../services/processingService.js';
import { createRedisConnection } from './connection.js';

/**
 * The document processing queue.
 *
 * One job per uploaded document. The queue is what makes a fifty-file batch
 * behave: uploads arrive as fast as the browser can send them, but only
 * `QUEUE_CONCURRENCY` documents are ever being rendered, and a job that dies
 * with the process is picked up again rather than lost.
 *
 * BullMQ rather than the Bull the plan named — Bull 4 is in maintenance and
 * BullMQ is its successor from the same author, with the same Redis-backed
 * model and first-class TypeScript types.
 */

export const QUEUE_NAME = 'document-processing';

export interface ProcessDocumentJob {
  documentId: string;
  batchId: string | null;
}

let queue: Queue<ProcessDocumentJob> | null = null;
let worker: Worker<ProcessDocumentJob> | null = null;

export function getQueue(): Queue<ProcessDocumentJob> {
  queue ??= new Queue<ProcessDocumentJob>(QUEUE_NAME, {
    connection: createRedisConnection(),
    prefix: config.queuePrefix,
    defaultJobOptions: {
      attempts: config.queueAttempts,
      backoff: { type: 'exponential', delay: 2_000 },
      // Keep a short tail for debugging; the database holds the real history.
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
  return queue;
}

/**
 * Hand a document to the queue.
 *
 * The document id is the job id, so a document submitted twice at once is
 * rendered once rather than twice.
 *
 * That deduplication is also a trap: BullMQ keeps finished jobs for a while,
 * and `add` against a retained job id does nothing at all — silently. So a
 * document being deliberately re-processed must clear its old job record
 * first, which is what `replace` is for. Without it, recovering a document
 * that had already completed once would leave it queued for ever.
 */
export async function enqueueDocument(
  job: ProcessDocumentJob,
  options: { replace?: boolean } = {},
): Promise<void> {
  const queue = getQueue();
  if (options.replace) {
    await queue.remove(job.documentId).catch(() => undefined);
  }
  await queue.add('process-document', job, { jobId: job.documentId });
}

/**
 * Re-queue everything the database still lists as waiting.
 *
 * Called at startup, after `resetInterruptedProcessing` has returned anything
 * stranded by a crash to `queued`. These documents may well carry a finished
 * job record from before the restart, so each one replaces it.
 */
export async function enqueuePending(): Promise<number> {
  const waiting = await store.listQueued();
  for (const document of waiting) {
    await enqueueDocument(
      { documentId: document.id, batchId: document.batchId },
      { replace: true },
    );
  }
  return waiting.length;
}

/**
 * Start processing jobs in this process.
 *
 * Split from `getQueue` so that an API-only process can enqueue without also
 * becoming a worker, which is what horizontal scaling needs.
 */
export function startWorker(): Worker<ProcessDocumentJob> {
  if (worker) return worker;

  worker = new Worker<ProcessDocumentJob>(
    QUEUE_NAME,
    async (job: Job<ProcessDocumentJob>) => {
      const { documentId } = job.data;
      try {
        return await processDocument(documentId);
      } catch (error) {
        // A PDF that will not render will not render on the third attempt
        // either, so fail it now rather than making the user wait out the
        // backoff to see the error.
        if (isPermanent(error)) {
          await failDocument(documentId, describe(error));
          throw new UnrecoverableError(describe(error));
        }
        throw error;
      }
    },
    {
      connection: createRedisConnection(),
      prefix: config.queuePrefix,
      concurrency: config.queueConcurrency,
      // A job whose process died is returned to the queue after this long.
      lockDuration: config.queueJobTimeoutMs,
    },
  );

  worker.on('failed', (job, error) => {
    if (!job) return;
    const attemptsLeft = (job.opts.attempts ?? 1) - job.attemptsMade;
    if (attemptsLeft > 0 && !(error instanceof UnrecoverableError)) {
      console.warn(
        `[queue] ${job.data.documentId} failed, ${attemptsLeft} attempt(s) left: ${error.message}`,
      );
      return;
    }
    // Out of attempts: record it against the document so the UI can show it.
    void failDocument(job.data.documentId, error.message);
  });

  worker.on('error', (error: Error) => {
    console.error('[queue]', error.message);
  });

  return worker;
}

/**
 * How long an upload waits for the queue to accept its job.
 *
 * The Redis connection buffers commands while it is disconnected rather than
 * failing them, which is what stops a reconnect blip from losing an upload.
 * The cost is that a Redis that is properly down would hold the HTTP request
 * open indefinitely, so the wait is bounded here and the caller turns a
 * timeout into a 503.
 */
const ENQUEUE_TIMEOUT_MS = 10_000;

/**
 * Register a document as waiting and tell any watching client.
 *
 * Enqueuing and announcing belong together: a client that hears about a
 * document it cannot yet see in a listing shows a card with nothing behind it.
 */
export async function queueDocument(document: {
  id: string;
  batchId?: string;
}): Promise<void> {
  const batchId = document.batchId ?? null;

  await withTimeout(
    enqueueDocument({ documentId: document.id, batchId }),
    ENQUEUE_TIMEOUT_MS,
    'The processing queue did not accept the job',
  );

  const stored = await store.get(document.id);
  if (stored) {
    publishEvent({ type: 'document.queued', batchId, document: stored });
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Stop the worker and close the queue's connections. */
export async function closeQueue(): Promise<void> {
  const running = worker;
  const open = queue;
  worker = null;
  queue = null;
  await running?.close().catch(() => undefined);
  await open?.close().catch(() => undefined);
}

/**
 * Which failures are worth retrying.
 *
 * A corrupt PDF and a page that does not exist are properties of the file;
 * everything else — a full disk, a dropped database connection, an OOM — might
 * well work next time.
 */
function isPermanent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'INVALID_PDF' || code === 'PAGE_NOT_FOUND';
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
