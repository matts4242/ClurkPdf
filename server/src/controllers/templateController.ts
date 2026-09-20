import type { Request, Response } from 'express';
import { getPrisma } from '../db/client.js';
import * as templates from '../services/templateService.js';
import type {
  ApiResponse,
  ApplyTemplateRequest,
  CreateTemplateRequest,
  UpdateTemplateRequest,
} from '../types/index.js';
import {
  batchNotFound,
  documentNotFound,
  invalidRequest,
  templateNotFound,
} from '../utils/errors.js';
import { assertUuid } from '../utils/validation.js';

const ok = <T>(res: Response, data: T, status = 200): void => {
  const body: ApiResponse<T> = { success: true, data };
  res.status(status).json(body);
};

/**
 * POST /api/templates
 *
 * Save a document's regions as a reusable template. The spec's "Save as
 * Template", offered once a document has been marked up.
 */
export async function createTemplate(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as CreateTemplateRequest;

  const documentId = assertUuid(body.documentId, 'documentId');
  assertOptionalString(body.name, 'name');
  assertOptionalString(body.vendorIdentifier, 'vendorIdentifier');

  const template = await templates.createFromDocument(documentId, {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.vendorIdentifier === undefined
      ? {}
      : { vendorIdentifier: body.vendorIdentifier }),
  });

  ok(res, { template }, 201);
}

/** GET /api/templates */
export async function listTemplates(_req: Request, res: Response): Promise<void> {
  ok(res, { templates: await templates.listTemplates() });
}

/** GET /api/templates/:id */
export async function getTemplate(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);
  const template = await templates.getTemplate(id);
  if (!template) throw templateNotFound(id);
  ok(res, { template });
}

/** PUT /api/templates/:id — rename it, or change the vendor it answers to. */
export async function updateTemplate(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);
  const body = (req.body ?? {}) as UpdateTemplateRequest;

  assertOptionalString(body.name, 'name');
  assertOptionalString(body.vendorIdentifier, 'vendorIdentifier');
  if (body.name === undefined && body.vendorIdentifier === undefined) {
    throw invalidRequest('Nothing to update; send `name` or `vendorIdentifier`');
  }

  const template = await templates.updateTemplate(id, {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.vendorIdentifier === undefined
      ? {}
      : { vendorIdentifier: body.vendorIdentifier }),
  });
  ok(res, { template });
}

/**
 * DELETE /api/templates/:id
 *
 * The regions it already placed stay: they are ordinary regions on documents
 * someone may have corrected since. Only the pattern is forgotten.
 */
export async function deleteTemplate(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);
  const template = await templates.getTemplate(id);
  if (!template) throw templateNotFound(id);

  await templates.removeTemplate(id);
  ok(res, { id, deleted: true });
}

/**
 * POST /api/templates/:id/apply
 *
 * Apply a template to named documents, or to a whole batch — the spec's
 * "Apply to Similar Documents".
 */
export async function applyTemplate(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);
  const body = (req.body ?? {}) as ApplyTemplateRequest;

  const template = await templates.getTemplate(id);
  if (!template) throw templateNotFound(id);

  const documentIds = await resolveTargets(body);
  if (documentIds.length === 0) {
    throw invalidRequest('Send `documentIds` or a `batchId` with documents in it');
  }

  const applications = await templates.applyToMany(id, documentIds);
  const regionsCreated = applications.reduce(
    (total, application) => total + application.regionsCreated,
    0,
  );

  ok(res, { templateId: id, applications, regionsCreated });
}

/**
 * Which documents an apply request names.
 *
 * `documentIds` and `batchId` are both accepted, and both may be sent: the UI
 * offers "apply to this document" and "apply to the whole batch" and there is
 * no reason to make them exclusive.
 */
async function resolveTargets(body: ApplyTemplateRequest): Promise<string[]> {
  const ids = new Set<string>();

  if (body.documentIds !== undefined) {
    if (!Array.isArray(body.documentIds)) {
      throw invalidRequest('`documentIds` must be an array of UUIDs');
    }
    for (const value of body.documentIds) {
      ids.add(assertUuid(typeof value === 'string' ? value : '', 'documentIds'));
    }
  }

  if (body.batchId !== undefined) {
    const batchId = assertUuid(body.batchId, 'batchId');
    const batch = await getPrisma().batch.findUnique({
      where: { id: batchId },
      select: { id: true },
    });
    if (!batch) throw batchNotFound(batchId);

    const rows = await getPrisma().document.findMany({
      where: { batchId, status: 'ready' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) ids.add(row.id);
  }

  return [...ids];
}

/**
 * GET /api/documents/:id/template-suggestions
 *
 * Which held templates look like this document, best first. What the UI offers
 * when a match was too weak to apply on its own.
 */
export async function suggestTemplates(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);

  const document = await getPrisma().document.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!document) throw documentNotFound(id);

  ok(res, { suggestions: await templates.suggestTemplates(id) });
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw invalidRequest(`\`${field}\` must be a string`);
  }
}
