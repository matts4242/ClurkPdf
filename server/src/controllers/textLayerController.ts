import type { Request, Response } from 'express';
import * as store from '../services/documentStore.js';
import { getTextLayer } from '../services/textLayerService.js';
import type { ApiResponse, TextLayer } from '../types/index.js';
import { documentNotFound, pageNotFound } from '../utils/errors.js';
import { assertUuid, parsePageNumber } from '../utils/validation.js';

/**
 * GET /api/documents/:id/text-layer/:pageNumber
 *
 * The page's own text with positions, normalised to 0-1 so it lines up with
 * the page image and the region rectangles. `hasText: false` means the page is
 * a scan and the user needs the OCR path instead.
 */
export async function getPageTextLayer(req: Request, res: Response): Promise<void> {
  const documentId = assertUuid(req.params.id, 'documentId');
  const pageNumber = parsePageNumber(req.params.pageNumber);

  const document = await store.get(documentId);
  if (!document) throw documentNotFound(documentId);
  if (pageNumber > document.pageCount) throw pageNotFound(pageNumber, document.pageCount);

  const layer: TextLayer = await getTextLayer(documentId, pageNumber);
  const body: ApiResponse<TextLayer> = { success: true, data: layer };
  res.status(200).json(body);
}
