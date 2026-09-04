import { getPrisma } from '../db/client.js';
import type {
  CreateRegionRequest,
  FieldType,
  OcrStatus,
  Region,
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
  ocrStatus: string;
  rawText: string | null;
  correctedText: string | null;
  confidence: number | null;
  ocrError: string | null;
  ocrAt: Date | null;
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
    ocrStatus: row.ocrStatus as OcrStatus,
    ...(row.rawText === null ? {} : { rawText: row.rawText }),
    ...(row.correctedText === null ? {} : { correctedText: row.correctedText }),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    ...(row.ocrError === null ? {} : { ocrError: row.ocrError }),
    ...(row.ocrAt === null ? {} : { ocrAt: row.ocrAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Reject rectangles that fall outside the page or have no area.
 *
 * Checking the far edge as well as the origin is what stops a region from
 * hanging off the right or bottom of the page.
 */
function assertRectangleFitsPage(rect: Rect): void {
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

  assertRectangleFitsPage({ x: data.x, y: data.y, width: data.width, height: data.height });

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
    },
  });
  return toRegion(row);
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

export async function getRegionsByFieldType(
  documentId: string,
  fieldType: FieldType,
): Promise<Region[]> {
  await getPageCount(documentId);
  const rows = await getPrisma().region.findMany({
    where: { documentId, fieldType },
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
  const merged: Rect = {
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

  const row = await getPrisma().region.update({
    where: { id: regionId },
    data: {
      x: round(merged.x),
      y: round(merged.y),
      width: round(merged.width),
      height: round(merged.height),
      fieldType,
      fieldLabel: label,
      ...(geometryChanged
        ? {
            ocrStatus: 'PENDING' as const,
            rawText: null,
            correctedText: null,
            confidence: null,
            ocrError: null,
            ocrAt: null,
          }
        : {}),
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
