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

/**
 * The text lying inside a rectangle, in reading order.
 *
 * Used both when a region is first created from a text selection and whenever
 * one is moved, so a text-layer region always describes the words it currently
 * covers rather than the ones it covered when it was drawn.
 */
export async function getTextInRect(
  documentId: string,
  pageNumber: number,
  rect: NormalizedRect,
): Promise<string> {
  return (await snapToText(documentId, pageNumber, rect)).text;
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

  const left = Math.min(...touched.map((item) => item.x));
  const top = Math.min(...touched.map((item) => item.y));
  const right = Math.max(...touched.map((item) => item.x + item.width));
  const bottom = Math.max(...touched.map((item) => item.y + item.height));

  return {
    text: joinInReadingOrder(touched, layer.pageHeight),
    rect: {
      x: clamp(left),
      y: clamp(top),
      width: clamp(right - left, 1 - clamp(left)),
      height: clamp(bottom - top, 1 - clamp(top)),
    },
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
