import { Queue } from 'bullmq';
import { getRedis } from './connection.js';

/**
 * The document processing queue.
 *
 * A batch upload answers as soon as the files are on disk and pushes one job
 * per document here. Rendering every page and detecting fields takes seconds
 * per document, which is far too long to hold a request open for fifty of them.
 */

export const QUEUE_NAME = 'documents';
export const JOB_EXTRACT_INVOICE = 'extract-invoice';

export interface ExtractInvoiceJob {
  documentId: string;
  batchId: string;
}

let queue: Queue<ExtractInvoiceJob> | null = null;

export function getQueue(): Queue<ExtractInvoiceJob> {
  queue ??= new Queue<ExtractInvoiceJob>(QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      // One retry covers a transient failure; a PDF that cannot be rendered
      // fails the same way every time, so retrying it further just delays the
      // rest of the batch.
      attempts: 2,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
  });
  return queue;
}

export async function enqueueExtraction(job: ExtractInvoiceJob): Promise<void> {
  await getQueue().add(JOB_EXTRACT_INVOICE, job, { jobId: job.documentId });
}

export async function closeQueue(): Promise<void> {
  const open = queue;
  queue = null;
  if (open) await open.close().catch(() => undefined);
}
