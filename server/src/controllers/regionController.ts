import type { Request, Response } from 'express';
import * as regions from '../services/regionService.js';
import {
  isFieldType,
  type ApiResponse,
  type CreateRegionRequest,
  type ListRegionsResponse,
  type Region,
  type UpdateRegionRequest,
} from '../types/index.js';
import { invalidFieldType, invalidRequest } from '../utils/errors.js';
import { assertUuid, parsePageNumber } from '../utils/validation.js';

const ok = <T>(res: Response, data: T, status = 200): void => {
  const body: ApiResponse<T> = { success: true, data };
  res.status(status).json(body);
};

/** Read a required number from the request body, or throw INVALID_REQUEST. */
function requireNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidRequest(`${field} must be a number`, { [field]: value });
  }
  return value;
}

/** Read an optional number, or throw INVALID_REQUEST if present and not one. */
function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  if (body[field] === undefined) return undefined;
  return requireNumber(body, field);
}

function asBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function readFieldLabel(body: Record<string, unknown>): string | undefined {
  const label = body.fieldLabel;
  if (label === undefined || label === null) return undefined;
  if (typeof label !== 'string') {
    throw invalidRequest('fieldLabel must be a string', { fieldLabel: label });
  }
  return label;
}

/** GET /api/documents/:id/regions */
export async function listRegions(req: Request, res: Response): Promise<void> {
  const documentId = assertUuid(req.params.id, 'documentId');
  const found = await regions.getRegionsByDocument(documentId);
  const body: ListRegionsResponse = { regions: found, total: found.length };
  ok(res, body);
}

/** GET /api/documents/:id/regions/page/:pageNumber */
export async function listRegionsForPage(req: Request, res: Response): Promise<void> {
  const documentId = assertUuid(req.params.id, 'documentId');
  const pageNumber = parsePageNumber(req.params.pageNumber);
  const found = await regions.getRegionsByDocument(documentId, pageNumber);
  const body: ListRegionsResponse = { regions: found, total: found.length };
  ok(res, body);
}

/** POST /api/documents/:id/regions */
export async function createRegion(req: Request, res: Response): Promise<void> {
  const documentId = assertUuid(req.params.id, 'documentId');
  const body = asBody(req);

  if (!isFieldType(body.fieldType)) throw invalidFieldType(body.fieldType);

  const payload: CreateRegionRequest = {
    pageNumber: requireNumber(body, 'pageNumber'),
    x: requireNumber(body, 'x'),
    y: requireNumber(body, 'y'),
    width: requireNumber(body, 'width'),
    height: requireNumber(body, 'height'),
    fieldType: body.fieldType,
  };

  const label = readFieldLabel(body);
  if (label !== undefined) payload.fieldLabel = label;

  const region: Region = await regions.createRegion(documentId, payload);
  ok(res, { region }, 201);
}

/** PUT /api/documents/:id/regions/:regionId */
export async function updateRegion(req: Request, res: Response): Promise<void> {
  const documentId = assertUuid(req.params.id, 'documentId');
  const regionId = assertUuid(req.params.regionId, 'regionId');
  const body = asBody(req);

  if (body.fieldType !== undefined && !isFieldType(body.fieldType)) {
    throw invalidFieldType(body.fieldType);
  }

  const updates: UpdateRegionRequest = {};
  const x = optionalNumber(body, 'x');
  const y = optionalNumber(body, 'y');
  const width = optionalNumber(body, 'width');
  const height = optionalNumber(body, 'height');
  const label = readFieldLabel(body);

  if (x !== undefined) updates.x = x;
  if (y !== undefined) updates.y = y;
  if (width !== undefined) updates.width = width;
  if (height !== undefined) updates.height = height;
  if (isFieldType(body.fieldType)) updates.fieldType = body.fieldType;
  if (label !== undefined) updates.fieldLabel = label;

  if (body.correctedText !== undefined) {
    if (typeof body.correctedText !== 'string') {
      throw invalidRequest('correctedText must be a string', {
        correctedText: body.correctedText,
      });
    }
    updates.correctedText = body.correctedText;
  }

  if (Object.keys(updates).length === 0) {
    throw invalidRequest('No updatable fields were provided');
  }

  const region = await regions.updateRegion(regionId, documentId, updates);
  ok(res, { region });
}

/** DELETE /api/documents/:id/regions/:regionId */
export async function deleteRegion(req: Request, res: Response): Promise<void> {
  const documentId = assertUuid(req.params.id, 'documentId');
  const regionId = assertUuid(req.params.regionId, 'regionId');
  await regions.deleteRegion(regionId, documentId);
  ok(res, { id: regionId, deleted: true });
}
