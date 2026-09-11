import path from 'node:path';
import { config } from '../config.js';
import { getPrisma } from '../db/client.js';
import type { Document, DocumentStatus, DocumentWithStats } from '../types/index.js';
import { resolveWithin } from '../utils/validation.js';

/**
 * Document metadata storage, backed by PostgreSQL.
 *
 * Week 1 kept this in a JSON sidecar beside each upload; Week 2 moves it into
 * Prisma. The uploaded PDF and its rendered pages still live on disk under
 * `uploads/{id}/` — only the metadata moved. The call surface is unchanged, so
 * the controllers did not have to be rewritten.
 */

export const documentDir = (id: string): string => resolveWithin(config.uploadsDir, id);

export const pagesDir = (id: string): string => resolveWithin(documentDir(id), 'pages');

export const originalPdfPath = (id: string): string =>
  resolveWithin(documentDir(id), 'original.pdf');

export const pageImagePath = (id: string, pageNumber: number): string =>
  resolveWithin(pagesDir(id), `${pageNumber}.png`);

export const thumbnailPath = (id: string): string =>
  resolveWithin(documentDir(id), 'thumbnail.png');

/** Public URL of the small page-1 preview. */
export const thumbnailUrl = (id: string): string => `/uploads/${id}/thumbnail.png`;

/** Shape Prisma rows into the API's Document type. */
type DocumentRow = {
  id: string;
  batchId: string | null;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  pageCount: number;
  uploadPath: string;
  status: string;
  progress: number;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  contentHash: string | null;
  createdAt: Date;
};

export function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.originalName,
    mimeType: row.mimeType,
    size: row.size,
    pageCount: row.pageCount,
    uploadPath: row.uploadPath,
    createdAt: row.createdAt.toISOString(),
    status: row.status as DocumentStatus,
    progress: row.progress,
    ...(row.batchId === null ? {} : { batchId: row.batchId }),
    ...(row.thumbnailUrl === null ? {} : { thumbnailUrl: row.thumbnailUrl }),
    ...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
    ...(row.contentHash === null ? {} : { contentHash: row.contentHash }),
  };
}

/**
 * Return documents stranded mid-render by a crash to the queue.
 *
 * Called once at startup. Before Week 5 nothing was going to finish these, so
 * they were marked failed; now the job is durable and can simply be run again,
 * which is the main thing the queue buys. Only the row is reset here — the
 * caller re-enqueues, because this module knows nothing about the queue.
 */
export async function resetInterruptedProcessing(): Promise<string[]> {
  const stranded = await getPrisma().document.findMany({
    where: { status: 'processing' },
    select: { id: true },
  });
  if (stranded.length === 0) return [];

  await getPrisma().document.updateMany({
    where: { id: { in: stranded.map((row) => row.id) } },
    data: { status: 'queued', progress: 0, errorMessage: null },
  });
  return stranded.map((row) => row.id);
}

/** Every document waiting on the queue, oldest first. */
export async function listQueued(): Promise<{ id: string; batchId: string | null }[]> {
  return getPrisma().document.findMany({
    where: { status: 'queued' },
    select: { id: true, batchId: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function create(
  document: Document,
  extra: { batchId?: string; contentHash?: string } = {},
): Promise<Document> {
  const row = await getPrisma().document.create({
    data: {
      id: document.id,
      filename: document.filename,
      originalName: document.originalName,
      mimeType: document.mimeType,
      size: document.size,
      pageCount: document.pageCount,
      uploadPath: document.uploadPath,
      status: document.status,
      progress: document.progress,
      thumbnailUrl: document.thumbnailUrl ?? null,
      errorMessage: document.errorMessage ?? null,
      batchId: extra.batchId ?? null,
      contentHash: extra.contentHash ?? null,
    },
  });
  return toDocument(row);
}

/**
 * The earliest other document holding the same bytes.
 *
 * The spec asks for a visual warning on a duplicate upload, not a rejection:
 * re-uploading an invoice is a legitimate thing to do, and only the user knows
 * whether this one is a mistake.
 */
export async function findDuplicate(
  contentHash: string,
  excludeId?: string,
): Promise<string | undefined> {
  const row = await getPrisma().document.findFirst({
    where: {
      contentHash,
      ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return row?.id;
}

export async function get(id: string): Promise<Document | undefined> {
  const row = await getPrisma().document.findUnique({ where: { id } });
  return row ? toDocument(row) : undefined;
}

/** A document plus its region counts, in one round trip. */
export async function getWithStats(id: string): Promise<DocumentWithStats | undefined> {
  const row = await getPrisma().document.findUnique({
    where: { id },
    include: { regions: { select: { pageNumber: true } } },
  });
  if (!row) return undefined;

  const pages = [...new Set(row.regions.map((region) => region.pageNumber))].sort((a, b) => a - b);
  return {
    ...toDocument(row),
    regionCount: row.regions.length,
    pagesWithRegions: pages,
  };
}

export async function list(): Promise<Document[]> {
  const rows = await getPrisma().document.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toDocument);
}

/**
 * Move a document to a new status once page rendering finishes.
 *
 * These are the only fields anything updates after creation, so the signature
 * says so rather than accepting a partial Document and quietly ignoring most
 * of it.
 */
export async function setStatus(
  id: string,
  status: DocumentStatus,
  extra: { thumbnailUrl?: string; errorMessage?: string; progress?: number } = {},
): Promise<Document | undefined> {
  const row = await getPrisma()
    .document.update({
      where: { id },
      data: {
        status,
        ...(extra.thumbnailUrl === undefined ? {} : { thumbnailUrl: extra.thumbnailUrl }),
        ...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
        ...(extra.progress === undefined ? {} : { progress: clampProgress(extra.progress) }),
      },
    })
    // The document was deleted while its preview was rendering.
    .catch(() => null);

  return row ? toDocument(row) : undefined;
}

/**
 * Record how far a processing job has got.
 *
 * Separate from `setStatus` because it is called several times per document
 * and must not disturb anything else on the row.
 */
export async function setProgress(id: string, progress: number): Promise<void> {
  await getPrisma()
    .document.update({ where: { id }, data: { progress: clampProgress(progress) } })
    .catch(() => undefined);
}

const clampProgress = (value: number): number =>
  Math.max(0, Math.min(100, Math.round(value)));

/**
 * Delete a document, its regions, and its files.
 *
 * Regions go with it through the schema's cascade. The row is removed before
 * the files so a crash between the two leaves orphaned bytes rather than a
 * document pointing at files that are gone.
 */
export async function remove(id: string): Promise<void> {
  await getPrisma()
    .document.delete({ where: { id } })
    .catch(() => undefined);
  const { rm } = await import('node:fs/promises');
  await rm(documentDir(id), { recursive: true, force: true });
}

/** Remove upload files for a document that was never committed to the database. */
export async function removeFilesOnly(id: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(path.resolve(config.uploadsDir, id), { recursive: true, force: true });
}

export async function count(): Promise<number> {
  return getPrisma().document.count();
}
