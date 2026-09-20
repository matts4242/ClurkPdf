import type { Request, Response } from 'express';
import { buildExport } from '../services/exportService.js';
import {
  exportName,
  toCsv,
  toJson,
  toXlsx,
  toXml,
  type RenderedExport,
} from '../services/exportFormats.js';
import type { ExportFormat, ExportPayload } from '../types/index.js';
import { EXPORT_FORMATS, isExportFormat } from '../types/index.js';
import { invalidRequest } from '../utils/errors.js';
import { AppError } from '../utils/errors.js';
import { assertUuid } from '../utils/validation.js';

/**
 * Export endpoints.
 *
 * Two shapes of the same thing: a whole batch, or an arbitrary selection.
 * Every format goes through one `buildExport`, so a CSV and an XLSX of the
 * same batch can never disagree.
 */

/**
 * GET /api/batches/:id/export?format=csv|json|xlsx|xml
 *
 * The spec writes this as `/api/documents/batch/:batchId/export`, which reads
 * as a document sub-resource but is a batch operation; `/api/batches/:id`
 * already exists, so the export hangs off it.
 */
export async function exportBatch(req: Request, res: Response): Promise<void> {
  const batchId = assertUuid(req.params.id);
  const format = readFormat(req);

  const payload = await buildExport({
    batchId,
    includeUnprocessed: readBoolean(req.query.includeUnprocessed),
  });

  await send(res, payload, format, readBoolean(req.query.download));
}

/**
 * GET /api/exports?format=…&documentIds=a,b,c
 *
 * Everything held, or the documents named. What the client uses when the
 * selection is not one batch.
 */
export async function exportDocuments(req: Request, res: Response): Promise<void> {
  const format = readFormat(req);
  const documentIds = readDocumentIds(req);

  const payload = await buildExport({
    ...(documentIds === undefined ? {} : { documentIds }),
    includeUnprocessed: readBoolean(req.query.includeUnprocessed),
  });

  await send(res, payload, format, readBoolean(req.query.download));
}

// ---------------------------------------------------------------------------

/**
 * Render and write the file.
 *
 * The three file formats are always attachments. JSON is not, by default: it
 * is what the client's preview reads, and handing that fetch a download would
 * be worse than useless. `?download=1` asks for it as a file anyway, which is
 * what the JSON button in the export panel sends.
 *
 * The header is what actually makes a download happen. A link's `download`
 * attribute is ignored across origins — which the browser dev setup is, and a
 * deployment behind one proxy is not — so relying on it would work in
 * production and quietly fail in development.
 */
async function send(
  res: Response,
  payload: ExportPayload,
  format: ExportFormat,
  asAttachment: boolean,
): Promise<void> {
  const name = exportName(payload);
  const rendered = await render(payload, format, name);

  res.setHeader('Content-Type', rendered.contentType);
  res.setHeader('Content-Length', String(rendered.body.length));
  // Nothing about an export is cacheable: the underlying corrections change.
  res.setHeader('Cache-Control', 'no-store');

  if (format !== 'json' || asAttachment) {
    res.setHeader('Content-Disposition', `attachment; filename="${rendered.filename}"`);
  }

  res.send(rendered.body);
}

function render(
  payload: ExportPayload,
  format: ExportFormat,
  name: string,
): Promise<RenderedExport> | RenderedExport {
  switch (format) {
    case 'csv':
      return toCsv(payload, name);
    case 'xlsx':
      return toXlsx(payload, name);
    case 'xml':
      return toXml(payload, name);
    case 'json':
    default:
      return toJson(payload, name);
  }
}

/** `format` defaults to JSON, which is what a preview wants. */
function readFormat(req: Request): ExportFormat {
  const raw = req.query.format;
  if (raw === undefined) return 'json';

  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!isExportFormat(value)) {
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      `Unknown export format. Use one of: ${EXPORT_FORMATS.join(', ')}`,
      400,
      { received: value },
    );
  }
  return value;
}

/** `documentIds=a,b,c`, or repeated. Absent means everything. */
function readDocumentIds(req: Request): string[] | undefined {
  const raw = req.query.documentIds;
  if (raw === undefined) return undefined;

  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (values.length === 0) {
    throw invalidRequest('`documentIds` was given but empty');
  }
  return values.map((value) => assertUuid(value, 'documentIds'));
}

const readBoolean = (raw: unknown): boolean =>
  raw === 'true' || raw === '1' || raw === true;
