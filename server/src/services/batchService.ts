import { getPrisma } from '../db/client.js';
import type {
  Batch,
  BatchStatus,
  BatchWithDocuments,
  BatchWithProgress,
  DocumentStatus,
} from '../types/index.js';
import { DOCUMENT_STATUSES } from '../types/index.js';
import { batchNotFound } from '../utils/errors.js';
import { toDocument } from './documentStore.js';

/**
 * Batches: the unit a bulk upload is tracked and reported against.
 *
 * The batch row itself holds almost nothing. Progress is derived from the
 * documents in it on every read rather than kept as a counter, because a
 * counter maintained by three concurrent workers is a race waiting to happen
 * and the query is a single aggregate.
 */

type BatchRow = {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

const toBatch = (row: BatchRow): Batch => ({
  id: row.id,
  name: row.name,
  status: row.status as BatchStatus,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * "3 files · 14:05", when the caller did not name the batch itself.
 *
 * A count of zero means the client did not say how many were coming, so the
 * name falls back to the time alone rather than claiming "0 files".
 */
export function defaultBatchName(fileCount: number, now: Date = new Date()): string {
  const time = now.toTimeString().slice(0, 5);
  if (fileCount <= 0) return `Upload · ${time}`;
  return `${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${time}`;
}

export async function createBatch(name: string): Promise<Batch> {
  const row = await getPrisma().batch.create({ data: { name, status: 'queued' } });
  return toBatch(row);
}

export async function getBatch(id: string): Promise<Batch | undefined> {
  const row = await getPrisma().batch.findUnique({ where: { id } });
  return row ? toBatch(row) : undefined;
}

/** A batch with its pipeline counts, or undefined if there is no such batch. */
export async function getBatchWithProgress(id: string): Promise<BatchWithProgress | undefined> {
  const row = await getPrisma().batch.findUnique({
    where: { id },
    include: {
      documents: {
        select: { status: true, progress: true },
      },
    },
  });
  if (!row) return undefined;

  const detectedFieldCount = await countDetectedFields(id);
  return withProgress(toBatch(row), row.documents, detectedFieldCount);
}

/** The same, plus every document in the batch. */
export async function getBatchWithDocuments(id: string): Promise<BatchWithDocuments | undefined> {
  const row = await getPrisma().batch.findUnique({
    where: { id },
    include: { documents: { orderBy: { createdAt: 'asc' } } },
  });
  if (!row) return undefined;

  const detectedFieldCount = await countDetectedFields(id);
  return {
    ...withProgress(toBatch(row), row.documents, detectedFieldCount),
    documents: row.documents.map(toDocument),
  };
}

export async function listBatches(limit = 50): Promise<BatchWithProgress[]> {
  const rows = await getPrisma().batch.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { documents: { select: { status: true, progress: true } } },
  });

  const detected = await detectedFieldCounts(rows.map((row) => row.id));
  return rows.map((row) =>
    withProgress(toBatch(row), row.documents, detected.get(row.id) ?? 0),
  );
}

/** Throw unless the batch exists. Used before attaching an upload to it. */
export async function assertBatchExists(id: string): Promise<void> {
  const found = await getPrisma().batch.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw batchNotFound(id);
}

/**
 * Recompute a batch's status from its documents.
 *
 * Called after every document transition. `queued` while nothing has started,
 * `processing` while anything is in flight, `complete` once every document has
 * settled either way — a batch with failures in it is still finished.
 */
export async function refreshBatchStatus(id: string): Promise<BatchWithProgress | undefined> {
  const current = await getBatchWithProgress(id);
  if (!current) return undefined;

  const next = statusFor(current.counts, current.documentCount);
  if (next === current.status) return current;

  const row = await getPrisma()
    .batch.update({ where: { id }, data: { status: next } })
    .catch(() => null);
  if (!row) return current;

  return { ...current, ...toBatch(row) };
}

function statusFor(counts: Record<DocumentStatus, number>, total: number): BatchStatus {
  if (total === 0) return 'queued';
  if (counts.ready + counts.error === total) return 'complete';
  if (counts.queued === total) return 'queued';
  return 'processing';
}

/** Ids of every document in a batch. */
export async function listDocumentIds(batchId: string): Promise<string[]> {
  const rows = await getPrisma().document.findMany({
    where: { batchId },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Delete the batch row alone.
 *
 * `Document.batchId` is `SetNull` rather than a cascade on purpose — deleting
 * a batch must not be able to take documents with it by accident — so a caller
 * wanting the documents gone removes them itself, through `documentStore`,
 * which also owns their files on disk.
 */
export async function removeBatch(id: string): Promise<void> {
  await getPrisma()
    .batch.delete({ where: { id } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Derived progress
// ---------------------------------------------------------------------------

function withProgress(
  batch: Batch,
  documents: readonly { status: string; progress: number }[],
  detectedFieldCount: number,
): BatchWithProgress {
  const counts = Object.fromEntries(
    DOCUMENT_STATUSES.map((status) => [status, 0]),
  ) as Record<DocumentStatus, number>;

  for (const document of documents) {
    const status = document.status as DocumentStatus;
    if (status in counts) counts[status] += 1;
  }

  const total = documents.length;
  // A failed document is finished, not stuck at whatever percentage it reached.
  const progress =
    total === 0
      ? 0
      : Math.round(
          documents.reduce(
            (sum, document) => sum + (document.status === 'error' ? 100 : document.progress),
            0,
          ) / total,
        );

  return { ...batch, documentCount: total, counts, progress, detectedFieldCount };
}

async function countDetectedFields(batchId: string): Promise<number> {
  return getPrisma().region.count({
    where: { autoDetected: true, document: { batchId } },
  });
}

/** Detected-region counts for several batches, in one query. */
async function detectedFieldCounts(batchIds: string[]): Promise<Map<string, number>> {
  if (batchIds.length === 0) return new Map();

  const rows = await getPrisma().region.findMany({
    where: { autoDetected: true, document: { batchId: { in: batchIds } } },
    select: { document: { select: { batchId: true } } },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    const batchId = row.document.batchId;
    if (batchId === null) continue;
    counts.set(batchId, (counts.get(batchId) ?? 0) + 1);
  }
  return counts;
}
