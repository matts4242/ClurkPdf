import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where pdf.js finds the fourteen standard fonts.
 *
 * A PDF is not obliged to embed Helvetica, Times or Courier — a reader is
 * expected to have them — and plenty of generated invoices rely on exactly
 * that. pdf.js can satisfy it from the machine's own fonts, which is why a
 * page that rendered correctly in development came back blank from a
 * container: a slim base image has no fonts installed at all, so every glyph
 * drew nothing and no error was raised.
 *
 * pdfjs-dist ships its own copies of those fonts, so pointing at them makes
 * the render identical everywhere and independent of what the host happens to
 * have installed.
 */
export const STANDARD_FONT_DATA_URL = `${path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'))),
  '..',
  '..',
  'standard_fonts',
)}/`;
