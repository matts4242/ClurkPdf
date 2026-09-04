import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { Document, DocumentStatus } from '../types/index.js';
import { resolveWithin } from '../utils/validation.js';

/**
 * Document metadata storage.
 *
 * Week 1 has no database, so each document's record lives beside its files at
 * `uploads/{id}/document.json` and is mirrored in an in-memory index for fast
 * reads. Week 2 replaces this module with Prisma; the async signatures here
 * are already shaped for that swap, so callers will not change.
 */

const METADATA_FILENAME = 'document.json';

const index = new Map<string, Document>();

export const documentDir = (id: string): string => resolveWithin(config.uploadsDir, id);

export const pagesDir = (id: string): string => resolveWithin(documentDir(id), 'pages');

export const originalPdfPath = (id: string): string =>
  resolveWithin(documentDir(id), 'original.pdf');

export const pageImagePath = (id: string, pageNumber: number): string =>
  resolveWithin(pagesDir(id), `${pageNumber}.png`);

export const thumbnailPath = (id: string): string =>
  resolveWithin(documentDir(id), 'thumbnail.png');

const metadataPath = (id: string): string => resolveWithin(documentDir(id), METADATA_FILENAME);

/** Public URL of a rendered page image. */
export const pageImageUrl = (id: string, pageNumber: number): string =>
  `/uploads/${id}/pages/${pageNumber}.png`;

/** Public URL of the small page-1 preview. */
export const thumbnailUrl = (id: string): string => `/uploads/${id}/thumbnail.png`;

/** Rebuild the in-memory index from disk. Called once at startup. */
export async function loadFromDisk(): Promise<number> {
  index.clear();
  let entries: string[];
  try {
    entries = await fs.readdir(config.uploadsDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    try {
      const raw = await fs.readFile(path.join(config.uploadsDir, entry, METADATA_FILENAME), 'utf8');
      const parsed = JSON.parse(raw) as Document;
      if (parsed.id === entry) {
        // A document left mid-render by a crash is not coming back on its own.
        if (parsed.status === 'processing') {
          parsed.status = 'error';
          parsed.errorMessage = 'Processing was interrupted by a server restart';
        }
        index.set(parsed.id, parsed);
      }
    } catch {
      // Directories without readable metadata are partial uploads; skip them.
    }
  }
  return index.size;
}

async function persist(document: Document): Promise<void> {
  await fs.mkdir(documentDir(document.id), { recursive: true });
  await fs.writeFile(metadataPath(document.id), JSON.stringify(document, null, 2), 'utf8');
}

export async function create(document: Document): Promise<Document> {
  index.set(document.id, document);
  await persist(document);
  return document;
}

export async function get(id: string): Promise<Document | undefined> {
  return index.get(id);
}

export async function list(): Promise<Document[]> {
  return [...index.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Merge `changes` into a stored document. Returns undefined if it is gone. */
export async function update(
  id: string,
  changes: Partial<Omit<Document, 'id'>>,
): Promise<Document | undefined> {
  const existing = index.get(id);
  if (!existing) return undefined;
  const updated: Document = { ...existing, ...changes };
  index.set(id, updated);
  await persist(updated);
  return updated;
}

export async function setStatus(
  id: string,
  status: DocumentStatus,
  errorMessage?: string,
): Promise<Document | undefined> {
  return update(id, errorMessage === undefined ? { status } : { status, errorMessage });
}

/** Delete a document's directory and drop it from the index. */
export async function remove(id: string): Promise<void> {
  index.delete(id);
  await fs.rm(documentDir(id), { recursive: true, force: true });
}

export const size = (): number => index.size;
