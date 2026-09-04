import type { Request, Response } from 'express';
import { processRegion } from '../services/ocrService.js';
import * as regions from '../services/regionService.js';
import { config } from '../config.js';
import type { ApiResponse, OcrRegionResult, Region, RunOcrResponse } from '../types/index.js';
import { invalidRequest, regionNotFound } from '../utils/errors.js';
import { assertUuid, isUuid } from '../utils/validation.js';

/**
 * POST /api/documents/:id/ocr
 *
 * Recognises the text inside the document's regions. With no body, every
 * region on the document is processed; pass `regionIds` to redo a subset, or
 * `onlyPending: true` to skip regions that already have text.
 *
 * The spec's version of this endpoint took raw rectangles. Since Week 2 stores
 * regions in the database, taking their ids instead means results can be
 * written straight back to the right rows, which is what the spec asked for.
 */
export async function runOcr(req: Request, res: Response): Promise<void> {
  const documentId = assertUuid(req.params.id, 'documentId');

  const body: unknown = req.body;
  const options =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const requested = readRegionIds(options.regionIds);
  const onlyPending = options.onlyPending === true;

  // Throws DOCUMENT_NOT_FOUND when the document does not exist.
  const all = await regions.getRegionsByDocument(documentId);

  let targets: Region[];
  if (requested === undefined) {
    targets = onlyPending ? all.filter((region) => region.ocrStatus !== 'DONE') : all;
  } else {
    const byId = new Map(all.map((region) => [region.id, region]));
    targets = requested.map((id) => {
      const region = byId.get(id);
      // A region id that belongs to another document is simply not found here.
      if (!region) throw regionNotFound(id);
      return region;
    });
  }

  await regions.markRegionsProcessing(targets.map((region) => region.id));

  const results = await mapWithConcurrency(targets, config.ocrConcurrency, async (region) => {
    try {
      const { text, confidence } = await processRegion(documentId, region.pageNumber, region);
      await regions.saveOcrResult(region.id, text, confidence);
      return { regionId: region.id, status: 'DONE', text, confidence } satisfies OcrRegionResult;
    } catch (error) {
      // One bad region must not abandon the rest of the run.
      const message = error instanceof Error ? error.message : String(error);
      await regions.saveOcrError(region.id, message);
      console.error(`[ocr] region ${region.id} failed:`, message);
      return { regionId: region.id, status: 'ERROR', error: message } satisfies OcrRegionResult;
    }
  });

  const payload: RunOcrResponse = {
    results,
    succeeded: results.filter((result) => result.status === 'DONE').length,
    failed: results.filter((result) => result.status === 'ERROR').length,
  };

  const response: ApiResponse<RunOcrResponse> = { success: true, data: payload };
  res.status(200).json(response);
}

/** Validate an optional `regionIds` array from the request body. */
function readRegionIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw invalidRequest('regionIds must be an array of UUIDs');
  }
  const ids = value.map((entry) => {
    if (typeof entry !== 'string' || !isUuid(entry)) {
      throw invalidRequest('regionIds must contain only UUIDs', { received: entry });
    }
    return entry;
  });
  if (ids.length === 0) {
    throw invalidRequest('regionIds was empty; omit it to process every region');
  }
  return ids;
}

/**
 * Run `worker` over every item, at most `limit` at a time.
 *
 * The spec suggested a plain `Promise.all`. Each recognition holds a WASM
 * instance, so an unbounded fan-out over a large batch would try to start one
 * per region at once; this keeps the pool bounded while preserving input order
 * in the results.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await worker(item);
    }
  });

  await Promise.all(runners);
  return results;
}
