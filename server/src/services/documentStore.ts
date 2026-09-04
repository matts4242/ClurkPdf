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

/** Public URL of a rendered page image. */
export const pageImageUrl = (id: string, pageNumber: number): string =>
  `/uploads/${id}/pages/${pageNumber}.png`;

/** Public URL of the small page-1 preview. */
export const thumbnailUrl = (id: string): string => `/uploads/${id}/thumbnail.png`;

/** Shape Prisma rows into the API's Document type. */
type DocumentRow = {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  pageCount: number;
  uploadPath: string;
  status: string;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  createdAt: Date;
};

function toDocument(row: DocumentRow): Document {
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
    ...(row.thumbnailUrl === null ? {} : { thumbnailUrl: row.thumbnailUrl }),
    ...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
  };
}

/**
 * Mark documents stranded mid-render by a crash as failed.
 *
 * Called once at startup. Nothing is going to finish rendering them, so
 * leaving them at `processing` would make clients poll forever.
 */
export async function failInterruptedProcessing(): Promise<number> {
  const { count } = await getPrisma().document.updateMany({
    where: { status: 'processing' },
    data: { status: 'error', errorMessage: 'Processing was interrupted by a server restart' },
  });
  return count;
}

export async function create(document: Document): Promise<Document> {
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
      thumbnailUrl: document.thumbnailUrl ?? null,
      errorMessage: document.errorMessage ?? null,
    },
  });
  return toDocument(row);
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

/** Merge `changes` into a stored document. Returns undefined if it is gone. */
export async function update(
  id: string,
  changes: Partial<Omit<Document, 'id'>>,
): Promise<Document | undefined> {
  const existing = await getPrisma().document.findUnique({ where: { id } });
  if (!existing) return undefined;

  const row = await getPrisma().document.update({
    where: { id },
    data: {
      ...(changes.status === undefined ? {} : { status: changes.status }),
      ...(changes.thumbnailUrl === undefined ? {} : { thumbnailUrl: changes.thumbnailUrl }),
      ...(changes.errorMessage === undefined ? {} : { errorMessage: changes.errorMessage }),
      ...(changes.pageCount === undefined ? {} : { pageCount: changes.pageCount }),
    },
  });
  return toDocument(row);
}

export async function setStatus(
  id: string,
  status: DocumentStatus,
  errorMessage?: string,
): Promise<Document | undefined> {
  return update(id, errorMessage === undefined ? { status } : { status, errorMessage });
}

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
