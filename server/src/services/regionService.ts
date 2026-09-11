import { getPrisma } from '../db/client.js';
import { snapToText } from './textLayerService.js';
import type {
  CreateRegionRequest,
  FieldType,
  NormalizedRect,
  OcrStatus,
  Region,
  TextSource,
  UpdateRegionRequest,
} from '../types/index.js';
import {
  documentNotFound,
  invalidDimensions,
  invalidPage,
  regionNotFound,
  regionOutOfBounds,
} from '../utils/errors.js';

/**
 * Region CRUD.
 *
 * Every write validates that the rectangle lies inside the page and that the
 * page exists on the document, so the database only ever holds regions that
 * can actually be drawn.
 */

/** Coordinates are stored to this many decimals — sub-pixel at any sane zoom. */
const PRECISION = 4;

const round = (value: number): number => Number(value.toFixed(PRECISION));

type RegionRow = {
  id: string;
  documentId: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldType: string;
  fieldLabel: string | null;
  textSource: string;
  ocrStatus: string;
  rawText: string | null;
  correctedText: string | null;
  confidence: number | null;
  ocrError: string | null;
  ocrAt: Date | null;
  autoDetected: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toRegion(row: RegionRow): Region {
  return {
    id: row.id,
    documentId: row.documentId,
    pageNumber: row.pageNumber,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    fieldType: row.fieldType as FieldType,
    ...(row.fieldLabel === null ? {} : { fieldLabel: row.fieldLabel }),
    textSource: row.textSource as TextSource,
    ocrStatus: row.ocrStatus as OcrStatus,
    ...(row.rawText === null ? {} : { rawText: row.rawText }),
    ...(row.correctedText === null ? {} : { correctedText: row.correctedText }),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    ...(row.ocrError === null ? {} : { ocrError: row.ocrError }),
    ...(row.ocrAt === null ? {} : { ocrAt: row.ocrAt.toISOString() }),
    autoDetected: row.autoDetected,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Reject rectangles that fall outside the page or have no area.
 *
 * Checking the far edge as well as the origin is what stops a region from
 * hanging off the right or bottom of the page.
 */
function assertRectangleFitsPage(rect: NormalizedRect): void {
  const { x, y, width, height } = rect;

  // Check only the four rectangle fields by name; callers may hand in a wider
  // payload, and iterating its properties would trip over fieldType.
  for (const [name, value] of [
    ['x', x],
    ['y', y],
    ['width', width],
    ['height', height],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw regionOutOfBounds({ field: name, value });
    }
  }

  if (width <= 0 || height <= 0) {
    throw invalidDimensions({ width, height });
  }

  if (x < 0 || y < 0 || x > 1 || y > 1) {
    throw regionOutOfBounds({ x, y });
  }

  if (x + width > 1 || y + height > 1) {
    throw regionOutOfBounds({
      reason: 'Region extends past the edge of the page',
      right: round(x + width),
      bottom: round(y + height),
    });
  }
}

/** Load a document's page count, or throw DOCUMENT_NOT_FOUND. */
async function getPageCount(documentId: string): Promise<number> {
  const document = await getPrisma().document.findUnique({
    where: { id: documentId },
    select: { pageCount: true },
  });
  if (!document) throw documentNotFound(documentId);
  return document.pageCount;
}

export async function createRegion(
  documentId: string,
  data: CreateRegionRequest,
): Promise<Region> {
  const pageCount = await getPageCount(documentId);

  if (!Number.isInteger(data.pageNumber) || data.pageNumber < 1 || data.pageNumber > pageCount) {
    throw invalidPage(data.pageNumber, pageCount);
  }

  const rect: NormalizedRect = { x: data.x, y: data.y, width: data.width, height: data.height };
  assertRectangleFitsPage(rect);

  // A region highlighted over the PDF's own text is already readable, so fill
  // its text now rather than leaving it for OCR. The text is derived here from
  // the rectangle rather than taken from the request, so what is stored always
  // matches what the region actually covers.
  const fromTextLayer =
    data.textSource === 'TEXT_LAYER'
      ? await readTextLayer(documentId, data.pageNumber, rect)
      : null;

  const row = await getPrisma().region.create({
    data: {
      documentId,
      pageNumber: data.pageNumber,
      x: round(data.x),
      y: round(data.y),
      width: round(data.width),
      height: round(data.height),
      fieldType: data.fieldType,
      fieldLabel: labelFor(data.fieldType, data.fieldLabel),
      ...(fromTextLayer ?? {}),
    },
  });
  return toRegion(row);
}

/**
 * Read a rectangle out of the PDF's text layer, shaped for a Prisma write.
 *
 * Confidence is 100 because this is the document's own text, not a guess. If
 * the rectangle covers no text — a scanned page, or an empty area — the region
 * is left unread so OCR can still be run against it.
 */
async function readTextLayer(
  documentId: string,
  pageNumber: number,
  rect: NormalizedRect,
): Promise<{
  textSource: 'TEXT_LAYER';
  ocrStatus: 'DONE';
  rawText: string;
  confidence: number;
  ocrError: null;
  ocrAt: Date;
  /** The box the captured text actually occupies. */
  x: number;
  y: number;
  width: number;
  height: number;
} | null> {
  const snapped = await snapToText(documentId, pageNumber, rect);
  if (snapped.text === '' || snapped.rect === null) return null;

  return {
    textSource: 'TEXT_LAYER',
    ocrStatus: 'DONE',
    rawText: snapped.text,
    confidence: 100,
    ocrError: null,
    ocrAt: new Date(),
    // Snap the stored rectangle onto the text it captured, so the box the user
    // sees matches the value the region holds.
    x: round(snapped.rect.x),
    y: round(snapped.rect.y),
    width: round(snapped.rect.width),
    height: round(snapped.rect.height),
  };
}

export async function getRegionsByDocument(
  documentId: string,
  pageNumber?: number,
): Promise<Region[]> {
  // Confirms the document exists, so an unknown id is a 404 rather than [].
  await getPageCount(documentId);

  const rows = await getPrisma().region.findMany({
    where: { documentId, ...(pageNumber === undefined ? {} : { pageNumber }) },
    orderBy: [{ pageNumber: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(toRegion);
}

/**
 * Update a region.
 *
 * `documentId` is part of the lookup, so a region id from one document can
 * never be edited through another document's URL.
 */
export async function updateRegion(
  regionId: string,
  documentId: string,
  updates: UpdateRegionRequest,
): Promise<Region> {
  const existing = await getPrisma().region.findFirst({ where: { id: regionId, documentId } });
  if (!existing) {
    // Distinguish "no such document" from "no such region on it".
    await getPageCount(documentId);
    throw regionNotFound(regionId);
  }

  // Validate the rectangle as it will be after the merge, not just the fields
  // that were sent — a lone `width` can still push the region off the page.
  const merged: NormalizedRect = {
    x: updates.x ?? existing.x,
    y: updates.y ?? existing.y,
    width: updates.width ?? existing.width,
    height: updates.height ?? existing.height,
  };
  assertRectangleFitsPage(merged);

  const fieldType = updates.fieldType ?? (existing.fieldType as FieldType);
  const label =
    updates.fieldLabel === undefined && updates.fieldType === undefined
      ? existing.fieldLabel
      : labelFor(fieldType, updates.fieldLabel ?? existing.fieldLabel ?? undefined);

  // Moving or resizing a region puts it over different pixels, so any text
  // already read from it — and any human correction of that text — no longer
  // describes what the rectangle covers. Reset it back to un-recognised.
  const geometryChanged =
    round(merged.x) !== existing.x ||
    round(merged.y) !== existing.y ||
    round(merged.width) !== existing.width ||
    round(merged.height) !== existing.height;

  // A text-layer region can simply be re-read at its new position, since the
  // words are already in the PDF. Only an OCR region has to go back to PENDING
  // and wait for a recognition run.
  const rederived =
    geometryChanged && existing.textSource === 'TEXT_LAYER'
      ? await readTextLayer(documentId, existing.pageNumber, merged)
      : null;

  const clearedText = {
    textSource: 'NONE' as const,
    ocrStatus: 'PENDING' as const,
    rawText: null,
    correctedText: null,
    confidence: null,
    ocrError: null,
    ocrAt: null,
  };

  const row = await getPrisma().region.update({
    where: { id: regionId },
    data: {
      x: round(merged.x),
      y: round(merged.y),
      width: round(merged.width),
      height: round(merged.height),
      fieldType,
      fieldLabel: label,
      // Editing an auto-detected region is the review it was flagged for, so
      // it stops being a suggestion and becomes the user's own.
      autoDetected: false,
      ...(geometryChanged ? { ...clearedText, ...(rederived ?? {}) } : {}),
      // An explicit correction still applies when the rectangle did not move.
      ...(updates.correctedText === undefined || geometryChanged
        ? {}
        : { correctedText: updates.correctedText.trim() || null }),
    },
  });
  return toRegion(row);
}

// --- OCR bookkeeping -----------------------------------------------------

/** Mark regions as in progress so a concurrent reader sees the run started. */
export async function markRegionsProcessing(regionIds: string[]): Promise<void> {
  if (regionIds.length === 0) return;
  await getPrisma().region.updateMany({
    where: { id: { in: regionIds } },
    data: { ocrStatus: 'PROCESSING', ocrError: null },
  });
}

/** Store a successful recognition. A human correction is left untouched. */
export async function saveOcrResult(
  regionId: string,
  text: string,
  confidence: number,
): Promise<Region> {
  const row = await getPrisma().region.update({
    where: { id: regionId },
    data: {
      textSource: 'OCR',
      ocrStatus: 'DONE',
      rawText: text,
      confidence,
      ocrError: null,
      ocrAt: new Date(),
    },
  });
  return toRegion(row);
}

/** Record a failed recognition against one region. */
export async function saveOcrError(regionId: string, message: string): Promise<void> {
  await getPrisma().region.update({
    where: { id: regionId },
    data: {
      ocrStatus: 'ERROR',
      ocrError: message.slice(0, 500),
      ocrAt: new Date(),
    },
  });
}

export async function deleteRegion(regionId: string, documentId: string): Promise<void> {
  const { count } = await getPrisma().region.deleteMany({ where: { id: regionId, documentId } });
  if (count === 0) {
    await getPageCount(documentId);
    throw regionNotFound(regionId);
  }
}

/** A custom label only means something on a CUSTOM region. */
function labelFor(fieldType: FieldType, label: string | undefined): string | null {
  if (fieldType !== 'CUSTOM') return null;
  const trimmed = label?.trim();
  return trimmed ? trimmed.slice(0, 100) : null;
}
