import fs from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { config } from '../config.js';
import { invalidPdf, processingError } from '../utils/errors.js';
import { resolveWithin } from '../utils/validation.js';

/**
 * PDF rendering, backed by pdf.js and a native canvas.
 *
 * The Week 1 spec suggests pdf2pic or pdf-poppler. Both shell out to
 * GraphicsMagick/Ghostscript or the poppler binaries, which means a system
 * dependency outside npm and no working Linux build for pdf-poppler.
 * pdfjs-dist plus @napi-rs/canvas renders the same pages from prebuilt npm
 * packages alone, so `npm install` is the whole setup story, and it reuses the
 * text-extraction engine Week 4 needs anyway.
 */

/** pdf.js ships as ESM only, so load it lazily and cache the module. */
let pdfjsModule: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null;

async function getPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  pdfjsModule ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsModule;
}

/**
 * Open a PDF and hand it to `use`, always tearing the document down after.
 *
 * pdf.js holds worker state per document, so leaking one leaks memory for the
 * life of the process.
 */
async function withDocument<T>(
  data: Uint8Array,
  use: (doc: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  const pdfjs = await getPdfjs();
  let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
  try {
    loadingTask = pdfjs.getDocument({
      data,
      // Untrusted input: keep font handling local and skip anything that would
      // reach outside the process.
      useSystemFonts: true,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
    });
    const doc = await loadingTask.promise;
    return await use(doc);
  } finally {
    await loadingTask?.destroy().catch(() => undefined);
  }
}

/** Read the page count, or throw INVALID_PDF if the file will not parse. */
export async function getPageCount(pdfBuffer: Buffer): Promise<number> {
  try {
    return await withDocument(toUint8Array(pdfBuffer), async (doc) => doc.numPages);
  } catch (error) {
    throw invalidPdf({ reason: error instanceof Error ? error.message : String(error) });
  }
}

export interface RenderOptions {
  /** Render at this pixel width instead of `config.pageDpi`. */
  targetWidth?: number;
  /** Dots per inch, relative to the PDF's 72dpi user space. */
  dpi?: number;
}

/**
 * Render one page of `pdfPath` to `{outputDir}/{pageNumber}.png`.
 *
 * Returns the absolute path of the written file. Page numbers are 1-indexed.
 */
export async function convertPageToImage(
  pdfPath: string,
  pageNumber: number,
  outputDir: string,
  options: RenderOptions = {},
): Promise<string> {
  const source = await fs.readFile(pdfPath);
  const png = await renderPageToPng(source, pageNumber, options);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = resolveWithin(outputDir, `${pageNumber}.png`);
  await fs.writeFile(outputPath, png);
  return outputPath;
}

/** Render one page of an in-memory PDF to PNG bytes. */
export async function renderPageToPng(
  pdfBuffer: Buffer,
  pageNumber: number,
  options: RenderOptions = {},
): Promise<Buffer> {
  return withDocument(toUint8Array(pdfBuffer), async (doc) => {
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      throw processingError(`Page ${pageNumber} is outside the document`, {
        pageNumber,
        pageCount: doc.numPages,
      });
    }

    const page = await doc.getPage(pageNumber);
    const unscaled = page.getViewport({ scale: 1 });
    const scale =
      options.targetWidth !== undefined
        ? options.targetWidth / unscaled.width
        : (options.dpi ?? config.pageDpi) / 72;
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    // PDF pages are transparent; paint white so the PNG is not see-through.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    page.cleanup();
    return canvas.encode('png');
  });
}

/** Create the uploads root if it is missing. Safe to call repeatedly. */
export async function ensureUploadsDirectory(dir: string = config.uploadsDir): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Node's Buffer is a Uint8Array view; hand pdf.js an exactly sized copy. */
function toUint8Array(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}
