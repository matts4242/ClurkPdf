import { config } from '../config.js';
import { getPrisma } from '../db/client.js';
import type {
  FieldType,
  Template,
  TemplateApplication,
  TemplateRegion,
  TemplateSuggestion,
} from '../types/index.js';
import { isFieldType } from '../types/index.js';
import { documentNotFound, templateEmpty, templateNotFound } from '../utils/errors.js';
import { createRegion } from './regionService.js';
import { getTextLayer } from './textLayerService.js';
import { matchVendor } from './vendorMatcher.js';

/**
 * Templates: one vendor's layout, learned once and replayed.
 *
 * Week 5 pre-fills the fields an invoice *declares* — anything labelled
 * "Invoice No" or "Amount Due". That is a good guess about invoices in
 * general, and it is all you can do about a vendor you have never seen. A
 * template is the better guess you can make about a vendor you have: someone
 * has already marked this layout up by hand, so the rectangles are known and
 * there is nothing to infer.
 *
 * The two work together rather than competing. A template is applied first
 * because it is the stronger claim; detection then fills only the fields the
 * template did not cover.
 */

type TemplateRow = {
  id: string;
  name: string;
  vendorIdentifier: string;
  regionMappings: unknown;
  sourceDocumentId: string | null;
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    vendorIdentifier: row.vendorIdentifier,
    regions: parseRegions(row.regionMappings),
    ...(row.sourceDocumentId === null ? {} : { sourceDocumentId: row.sourceDocumentId }),
    useCount: row.useCount,
    ...(row.lastUsedAt === null ? {} : { lastUsedAt: row.lastUsedAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Read the JSON column back into regions, dropping anything malformed.
 *
 * The column is JSON, so nothing in the database guarantees its shape — a
 * hand-edited row or an older format must not crash a read. A template whose
 * regions will not parse comes back empty rather than throwing.
 */
function parseRegions(value: unknown): TemplateRegion[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): TemplateRegion[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const candidate = entry as Record<string, unknown>;

    const numbers = ['x', 'y', 'width', 'height', 'pageNumber'] as const;
    if (numbers.some((key) => typeof candidate[key] !== 'number')) return [];
    if (!isFieldType(candidate.fieldType)) return [];

    return [
      {
        pageNumber: candidate.pageNumber as number,
        x: candidate.x as number,
        y: candidate.y as number,
        width: candidate.width as number,
        height: candidate.height as number,
        fieldType: candidate.fieldType,
        ...(typeof candidate.fieldLabel === 'string'
          ? { fieldLabel: candidate.fieldLabel }
          : {}),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * Save a document's regions as a template.
 *
 * The vendor identifier defaults to the text of the document's VENDOR_NAME
 * region, which Week 5 usually filled in already — so saving a template for a
 * new vendor is one click with nothing to type.
 */
export async function createFromDocument(
  documentId: string,
  options: { name?: string; vendorIdentifier?: string } = {},
): Promise<Template> {
  const document = await getPrisma().document.findUnique({
    where: { id: documentId },
    include: { regions: { orderBy: [{ pageNumber: 'asc' }, { createdAt: 'asc' }] } },
  });
  if (!document) throw documentNotFound(documentId);
  if (document.regions.length === 0) throw templateEmpty(documentId);

  const vendorIdentifier =
    options.vendorIdentifier?.trim() || vendorNameFrom(document.regions) || document.originalName;

  const regions: TemplateRegion[] = document.regions.map((region) => ({
    pageNumber: region.pageNumber,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    fieldType: region.fieldType as FieldType,
    ...(region.fieldLabel === null ? {} : { fieldLabel: region.fieldLabel }),
  }));

  const row = await getPrisma().template.create({
    data: {
      name: options.name?.trim().slice(0, 120) || vendorIdentifier.slice(0, 120),
      vendorIdentifier: vendorIdentifier.slice(0, 200),
      // Prisma's JSON input type does not accept a typed array directly; the
      // round trip is what `parseRegions` validates on the way back out.
      regionMappings: regions as unknown as object[],
      sourceDocumentId: documentId,
    },
  });

  return toTemplate(row);
}

/** The value of the document's vendor-name region, if it has one. */
function vendorNameFrom(
  regions: readonly { fieldType: string; rawText: string | null; correctedText: string | null }[],
): string | undefined {
  const vendor = regions.find((region) => region.fieldType === 'VENDOR_NAME');
  // A correction is the human's word on it, so it wins over what was read.
  const text = vendor?.correctedText ?? vendor?.rawText ?? '';
  // Only the first line: the region may cover the address beneath the name.
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  return firstLine === '' ? undefined : firstLine;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listTemplates(): Promise<Template[]> {
  const rows = await getPrisma().template.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toTemplate);
}

export async function getTemplate(id: string): Promise<Template | undefined> {
  const row = await getPrisma().template.findUnique({ where: { id } });
  return row ? toTemplate(row) : undefined;
}

export async function updateTemplate(
  id: string,
  updates: { name?: string; vendorIdentifier?: string },
): Promise<Template> {
  const existing = await getPrisma().template.findUnique({ where: { id } });
  if (!existing) throw templateNotFound(id);

  const row = await getPrisma().template.update({
    where: { id },
    data: {
      ...(updates.name === undefined ? {} : { name: updates.name.trim().slice(0, 120) }),
      ...(updates.vendorIdentifier === undefined
        ? {}
        : { vendorIdentifier: updates.vendorIdentifier.trim().slice(0, 200) }),
    },
  });
  return toTemplate(row);
}

export async function removeTemplate(id: string): Promise<void> {
  await getPrisma()
    .template.delete({ where: { id } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Templates that plausibly describe this document, best first.
 *
 * Scored against the text at the top of page 1, where an invoice puts the
 * issuing company. A scanned page has no text layer, so nothing matches and
 * the caller falls back to OCR and the manual modes.
 */
export async function suggestTemplates(
  documentId: string,
  options: { minScore?: number; limit?: number } = {},
): Promise<TemplateSuggestion[]> {
  const minScore = options.minScore ?? config.templateSuggestThreshold;

  const templates = await listTemplates();
  if (templates.length === 0) return [];

  const layer = await getTextLayer(documentId, 1).catch(() => null);
  if (!layer || !layer.hasText) return [];

  const scored = templates
    .map((template) => {
      const { score, matchedText } = matchVendor(layer, template.vendorIdentifier);
      return { template, score, matchedText };
    })
    .filter((suggestion) => suggestion.score >= minScore)
    // Best match first; a tie goes to the template that has proved itself.
    .sort((a, b) => b.score - a.score || b.template.useCount - a.template.useCount);

  return options.limit === undefined ? scored : scored.slice(0, options.limit);
}

/** The single best match, or undefined when nothing clears `minScore`. */
export async function bestMatch(
  documentId: string,
  minScore: number,
): Promise<TemplateSuggestion | undefined> {
  const [best] = await suggestTemplates(documentId, { minScore, limit: 1 });
  return best;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Draw a template's regions onto a document.
 *
 * Field types the document already has are skipped, never overwritten: a
 * region the user drew, or one an earlier template already placed, is worth
 * more than a replay of a saved rectangle.
 *
 * Each region is created through the ordinary region path with
 * `textSource: 'TEXT_LAYER'`, so it reads its own text and snaps onto it. That
 * matters because the saved rectangle is only approximately right for this
 * document — a line one point taller pushes everything below it down — and
 * snapping to the words actually underneath fixes exactly that drift.
 */
export async function applyToDocument(
  templateId: string,
  documentId: string,
): Promise<TemplateApplication> {
  const template = await getTemplate(templateId);
  if (!template) throw templateNotFound(templateId);

  const document = await getPrisma().document.findUnique({
    where: { id: documentId },
    select: { id: true, pageCount: true, regions: { select: { fieldType: true } } },
  });
  if (!document) throw documentNotFound(documentId);

  const taken = new Set<FieldType>(
    document.regions.map((region) => region.fieldType as FieldType),
  );

  const skipped: FieldType[] = [];
  let regionsCreated = 0;

  for (const region of template.regions) {
    // A template made from a three-page invoice against a one-page one.
    if (region.pageNumber > document.pageCount) continue;

    // CUSTOM regions are distinguished by their label, not their type, so
    // several can coexist; the rest are one per document.
    const alreadyHere = region.fieldType !== 'CUSTOM' && taken.has(region.fieldType);
    if (alreadyHere) {
      if (!skipped.includes(region.fieldType)) skipped.push(region.fieldType);
      continue;
    }

    try {
      await createRegion(
        documentId,
        {
          pageNumber: region.pageNumber,
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
          fieldType: region.fieldType,
          ...(region.fieldLabel === undefined ? {} : { fieldLabel: region.fieldLabel }),
          textSource: 'TEXT_LAYER',
        },
        {
          // Placed by machine, so it carries the same "please check" marking
          // as a detected field, and editing it clears that.
          autoDetected: true,
          // The saved rectangle was measured on a different invoice, so let it
          // find its line on this one.
          snapTolerance: config.templateSnapTolerance,
          // Snapping captures the whole run, label and all; the template knows
          // which field this is, so keep the value.
          extractValue: true,
        },
      );
      regionsCreated += 1;
      if (region.fieldType !== 'CUSTOM') taken.add(region.fieldType);
    } catch (error) {
      // One bad rectangle — off the page after a resize, say — must not stop
      // the other fields from being placed.
      console.error(
        `[template] ${templateId} could not place ${region.fieldType} on ${documentId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (regionsCreated > 0) {
    await recordUse(templateId, documentId);
  }

  return { documentId, regionsCreated, skipped };
}

/**
 * Note that a template was used, and on what.
 *
 * `templateScore` is left alone here: a match found automatically sets it, and
 * a template applied by hand has no score to record — the user chose it.
 */
async function recordUse(templateId: string, documentId: string): Promise<void> {
  await getPrisma()
    .template.update({
      where: { id: templateId },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    })
    .catch(() => undefined);

  await getPrisma()
    .document.update({ where: { id: documentId }, data: { templateId } })
    .catch(() => undefined);
}

/** Record how confidently a template was matched, when it was matched by score. */
export async function recordMatchScore(documentId: string, score: number): Promise<void> {
  await getPrisma()
    .document.update({ where: { id: documentId }, data: { templateScore: score } })
    .catch(() => undefined);
}

/** Apply a template to several documents — "apply to similar documents". */
export async function applyToMany(
  templateId: string,
  documentIds: readonly string[],
): Promise<TemplateApplication[]> {
  const applications: TemplateApplication[] = [];
  // Serially: each application creates regions whose text is read from the
  // PDF, and running a batch of those at once would compete with the
  // processing queue for the same memory.
  for (const documentId of documentIds) {
    applications.push(await applyToDocument(templateId, documentId));
  }
  return applications;
}
