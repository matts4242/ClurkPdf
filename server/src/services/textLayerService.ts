import fs from 'node:fs/promises';
import * as store from './documentStore.js';
import type { NormalizedRect, TextItem, TextLayer } from '../types/index.js';
import { invalidPdf, pageNotFound } from '../utils/errors.js';

/**
 * The PDF's own text layer.
 *
 * A born-digital invoice already contains its text with exact positions, so
 * there is nothing to recognise — reading it is both perfectly accurate and far
 * faster than OCR. This is the Week 4 alternative to Week 3's bitmap path, not
 * a replacement: a scanned page has no text layer and still needs OCR.
 */

/** pdf.js is ESM only; load it lazily and cache the module. */
let pdfjsModule: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null;

async function getPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  pdfjsModule ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsModule;
}

/**
 * Extract every positioned text run on a page, normalised to 0-1.
 *
 * pdf.js reports each run with a transform whose origin is the text baseline in
 * a y-up coordinate space. Composing it with the viewport transform flips that
 * to the y-down space the page image and the region rectangles already use, so
 * text items and regions end up in the same coordinate system.
 */
export async function getTextLayer(
  documentId: string,
  pageNumber: number,
): Promise<TextLayer> {
  const pdfjs = await getPdfjs();
  const bytes = await fs.readFile(store.originalPdfPath(documentId));
  const data = new Uint8Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );

  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
  });

  try {
    const document = await loadingTask.promise;
    if (pageNumber < 1 || pageNumber > document.numPages) {
      throw pageNotFound(pageNumber, document.numPages);
    }

    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const textItems: TextItem[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      // pdf.js emits zero-width markers to signal line breaks; they carry no
      // text and would render as invisible dead zones over the page.
      if (item.str.trim() === '') continue;

      const transform = pdfjs.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(transform[2], transform[3]);
      const left = transform[4];
      const baseline = transform[5];

      textItems.push({
        text: item.str,
        x: round(left / viewport.width),
        // transform[5] is the baseline, so the box top is one font height up.
        y: round((baseline - fontHeight) / viewport.height),
        width: round(item.width / viewport.width),
        height: round(fontHeight / viewport.height),
        fontSize: round(fontHeight),
      });
    }

    page.cleanup();

    return {
      pageNumber,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
      textItems,
      hasText: textItems.length > 0,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AppError') throw error;
    throw invalidPdf({ reason: error instanceof Error ? error.message : String(error) });
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

export interface SnappedText {
  /** Text of every run the rectangle touches, in reading order. */
  text: string;
  /** The runs' combined bounding box, or null when none were touched. */
  rect: NormalizedRect | null;
}

/**
 * Find the text a rectangle touches, and the box that text actually occupies.
 *
 * pdf.js emits a whole line as a single run, so a user highlighting three
 * characters inside "Invoice No: INV-2026-0042" produces a rectangle covering a
 * small fraction of that run. Requiring most of a run to be inside the
 * rectangle would therefore return nothing at all for an ordinary selection.
 *
 * Instead a run counts as touched when the rectangle covers most of its
 * *height* and overlaps it horizontally at all. That is the "expand the
 * selection to word and line boundaries" behaviour the specification asks for:
 * touch any part of a line and you capture the whole field. The vertical test
 * keeps the line above and below out, and the horizontal one keeps the
 * neighbouring column out.
 */
export async function snapToText(
  documentId: string,
  pageNumber: number,
  rect: NormalizedRect,
): Promise<SnappedText> {
  const layer = await getTextLayer(documentId, pageNumber);
  const touched = layer.textItems.filter((item) => touches(item, rect));

  if (touched.length === 0) return { text: '', rect: null };

  return {
    text: joinInReadingOrder(touched, layer.pageHeight),
    rect: boundingBoxOf(touched),
  };
}

/**
 * Snap to the nearest line when the rectangle itself catches nothing.
 *
 * Week 6 replays a rectangle saved from one of a vendor's invoices onto
 * another, and the two are never quite aligned: an address one line longer
 * pushes everything below it down, and a rectangle that misses its line by
 * more than a line's height catches no text at all.
 *
 * So when the exact rectangle finds nothing, the search widens vertically by
 * `tolerance` and takes the single nearest line within it. Widening only
 * vertically is what keeps this honest — the horizontal test still applies, so
 * the search stays in the rectangle's own column and cannot wander into the
 * one beside it — and taking the *nearest* line rather than everything in the
 * band stops a generous tolerance from swallowing the field above as well.
 *
 * `tolerance` is 0 for an ordinary highlight: there the user drew the
 * rectangle over the text they meant, and second-guessing them would be wrong.
 */
export async function snapToTextNear(
  documentId: string,
  pageNumber: number,
  rect: NormalizedRect,
  tolerance: number,
  options: { prefer?: (text: string) => boolean } = {},
): Promise<SnappedText> {
  const exact = await snapToText(documentId, pageNumber, rect);
  if (exact.text !== '' || tolerance <= 0) return exact;

  const candidates = await linesNear(documentId, pageNumber, rect, tolerance);
  if (candidates.length === 0) return { text: '', rect: null };

  // Distance alone cannot separate two lines that are equally far — the field
  // above and the field below, when the layout has shifted by half a line.
  // `prefer` is how the caller breaks that tie with what it knows: Week 6 is
  // placing a *named* field, so it can ask for the line that actually reads
  // like one.
  const preferred = options.prefer
    ? candidates.find((candidate) => options.prefer?.(candidate.text) === true)
    : undefined;

  return preferred ?? (candidates[0] as SnappedText);
}

/**
 * Whole lines within `tolerance` of a rectangle, nearest first.
 *
 * Only lines that overlap the rectangle horizontally, so the search stays in
 * its own column rather than wandering into the one beside it.
 */
export async function linesNear(
  documentId: string,
  pageNumber: number,
  rect: NormalizedRect,
  tolerance: number,
): Promise<{ text: string; rect: NormalizedRect }[]> {
  const layer = await getTextLayer(documentId, pageNumber);

  const widened: NormalizedRect = {
    x: rect.x,
    y: Math.max(0, rect.y - tolerance),
    width: rect.width,
    height: rect.height + tolerance * 2,
  };

  const touching = layer.textItems.filter((item) => touches(item, widened));
  if (touching.length === 0) return [];

  // Group into lines, the same way the rest of the file does.
  const sorted = [...touching].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextItem[][] = [];
  for (const item of sorted) {
    const current = lines.at(-1);
    const previous = current?.at(-1);
    const lineTolerance = previous ? Math.max(previous.height * 0.5, 0.002) : 0;
    const sameLine =
      previous !== undefined && Math.abs(centre(item) - centre(previous)) <= lineTolerance;

    if (sameLine && current) current.push(item);
    else lines.push([item]);
  }

  const wantedCentre = rect.y + rect.height / 2;

  return lines
    .flatMap((items) => {
      const box = boundingBoxOf(items);
      const text = joinInReadingOrder(items, layer.pageHeight);
      if (box === null || text === '') return [];
      return [{ text, rect: box, distance: Math.abs(box.y + box.height / 2 - wantedCentre) }];
    })
    .sort((a, b) => a.distance - b.distance)
    .map(({ text, rect: box }) => ({ text, rect: box }));
}

/** The smallest rectangle containing every run, clamped to the page. */
function boundingBoxOf(items: readonly TextItem[]): NormalizedRect | null {
  if (items.length === 0) return null;

  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));

  return {
    x: clamp(left),
    y: clamp(top),
    width: clamp(right - left, 1 - clamp(left)),
    height: clamp(bottom - top, 1 - clamp(top)),
  };
}

/** True when the rectangle covers most of the run's height and any of its width. */
function touches(item: TextItem, rect: NormalizedRect): boolean {
  const overlapHeight =
    Math.min(item.y + item.height, rect.y + rect.height) - Math.max(item.y, rect.y);
  if (item.height <= 0 || overlapHeight / item.height < 0.5) return false;

  const overlapWidth =
    Math.min(item.x + item.width, rect.x + rect.width) - Math.max(item.x, rect.x);
  // A hair of overlap, so a selection ending exactly on a glyph edge still counts.
  return overlapWidth > 0.0005;
}

const clamp = (value: number, max = 1): number => Math.max(0, Math.min(value, max));

/**
 * Sort items top-to-bottom then left-to-right, joining lines with newlines.
 *
 * Items whose vertical centres are within half a line of each other are treated
 * as the same line, which is what keeps a row of an invoice table together.
 */
function joinInReadingOrder(items: TextItem[], pageHeight: number): string {
  if (items.length === 0) return '';

  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextItem[][] = [];

  for (const item of sorted) {
    const line = lines.at(-1);
    const previous = line?.at(-1);
    // Half the line's own height, expressed in normalised units.
    const tolerance = previous ? previous.height * 0.5 : 0;
    const sameLine =
      previous !== undefined &&
      Math.abs(centre(item) - centre(previous)) <= Math.max(tolerance, 2 / pageHeight);

    if (sameLine && line) line.push(item);
    else lines.push([item]);
  }

  return lines
    .map((line) =>
      [...line]
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text.trim())
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

const centre = (item: TextItem): number => item.y + item.height / 2;

/** Four decimals: sub-pixel at any sane zoom, and matches how regions store. */
const round = (value: number): number => Number(value.toFixed(4));
