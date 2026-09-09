import { getPrisma } from '../db/client.js';
import { batchNotFound } from '../utils/errors.js';
import type { Batch, BatchCounts, BatchSummary, Document, DocumentStatus } from '../types/index.js';
import { toDocument, type DocumentRow } from './documentStore.js';

/**
 * Batches.
 *
 * A batch is just a name for a set of documents uploaded together, so it has
 * no status of its own: the counts below are derived from its documents every
 * time they are asked for, which is one query and cannot fall out of step.
 */

/** How many document thumbnails a batch summary carries. */
const SUMMARY_THUMBNAILS = 4;

export async function createBatch(name?: string): Promise<{ id: string; createdAt: Date }> {
  return getPrisma().batch.create({
    data: name === undefined ? {} : { name },
    select: { id: true, createdAt: true },
  });
}

export async function getBatch(id: string): Promise<Batch> {
  const row = await getPrisma().batch.findUnique({
    where: { id },
    include: { documents: { orderBy: { createdAt: 'asc' } } },
  });
  if (!row) throw batchNotFound(id);

  const documents = row.documents.map((document) => toDocument(document as DocumentRow));
  return {
    id: row.id,
    ...(row.name === null ? {} : { name: row.name }),
    createdAt: row.createdAt.toISOString(),
    documents,
    counts: countByStatus(documents),
  };
}

export async function listBatches(): Promise<BatchSummary[]> {
  const rows = await getPrisma().batch.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      documents: {
        orderBy: { createdAt: 'asc' },
        select: { status: true, thumbnailUrl: true },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    ...(row.name === null ? {} : { name: row.name }),
    createdAt: row.createdAt.toISOString(),
    counts: countByStatus(row.documents.map((document) => document.status as DocumentStatus)),
    thumbnailUrls: row.documents
      .map((document) => document.thumbnailUrl)
      .filter((url): url is string => url !== null)
      .slice(0, SUMMARY_THUMBNAILS),
  }));
}

/** The counts a batch reports, from either documents or bare statuses. */
export function countByStatus(items: Array<Document | DocumentStatus>): BatchCounts {
  const counts: BatchCounts = { total: 0, queued: 0, processing: 0, ready: 0, error: 0 };

  for (const item of items) {
    const status = typeof item === 'string' ? item : item.status;
    counts.total += 1;
    counts[status] += 1;
  }
  return counts;
}

/** True once nothing in the batch is waiting or running. */
export const isSettled = (counts: BatchCounts): boolean =>
  counts.queued === 0 && counts.processing === 0;

/** The counts for one batch, without loading its documents. */
export async function getCounts(batchId: string): Promise<BatchCounts> {
  const rows = await getPrisma().document.findMany({
    where: { batchId },
    select: { status: true },
  });
  return countByStatus(rows.map((row) => row.status as DocumentStatus));
}
