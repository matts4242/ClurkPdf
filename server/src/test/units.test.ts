import { describe, expect, it } from 'vitest';
import { getPageCount, renderPageToPng } from '../services/pdfService.js';
import { AppError } from '../utils/errors.js';
import {
  assertUuid,
  isUuid,
  parsePageNumber,
  resolveWithin,
  sanitizeFilename,
} from '../utils/validation.js';
import { buildPdf, invalidPdfBytes } from './fixtures.js';

describe('sanitizeFilename', () => {
  it('strips directory components from traversal attempts', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32\\config')).toBe('config');
  });

  it('replaces characters outside the safe alphabet', () => {
    expect(sanitizeFilename('my invoice (final);rm -rf.pdf')).toBe('my_invoice__final__rm_-rf.pdf');
  });

  it('keeps ordinary names intact', () => {
    expect(sanitizeFilename('ACME-2026_01.pdf')).toBe('ACME-2026_01.pdf');
  });

  it('falls back when nothing usable survives', () => {
    expect(sanitizeFilename('...')).toBe('document.pdf');
    expect(sanitizeFilename('')).toBe('document.pdf');
  });
});

describe('uuid validation', () => {
  const valid = '11111111-1111-4111-8111-111111111111';

  it('accepts a UUID v4', () => {
    expect(isUuid(valid)).toBe(true);
    expect(assertUuid(valid)).toBe(valid);
  });

  it('rejects other shapes', () => {
    expect(isUuid('11111111-1111-1111-8111-111111111111')).toBe(false);
    expect(() => assertUuid('../../etc')).toThrow(AppError);
    expect(() => assertUuid(undefined)).toThrow(AppError);
    expect(() => assertUuid([valid, valid])).toThrow(AppError);
  });
});

describe('parsePageNumber', () => {
  it('accepts positive integers', () => {
    expect(parsePageNumber('1')).toBe(1);
    expect(parsePageNumber('42')).toBe(42);
  });

  it('rejects anything else', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', undefined]) {
      expect(() => parsePageNumber(bad)).toThrow(AppError);
    }
  });
});

describe('resolveWithin', () => {
  it('resolves paths under the root', () => {
    expect(resolveWithin('/srv/uploads', 'abc', 'pages', '1.png')).toBe(
      '/srv/uploads/abc/pages/1.png',
    );
  });

  it('refuses to escape the root', () => {
    expect(() => resolveWithin('/srv/uploads', '..', 'secrets')).toThrow(AppError);
    expect(() => resolveWithin('/srv/uploads', '/etc/passwd')).toThrow(AppError);
  });
});

describe('pdfService', () => {
  it('counts pages', async () => {
    await expect(getPageCount(buildPdf(['a']))).resolves.toBe(1);
    await expect(getPageCount(buildPdf(['a', 'b', 'c', 'd']))).resolves.toBe(4);
  });

  it('reports INVALID_PDF for unparseable input', async () => {
    await expect(getPageCount(invalidPdfBytes)).rejects.toMatchObject({ code: 'INVALID_PDF' });
  });

  it('renders a page to PNG bytes', async () => {
    const png = await renderPageToPng(buildPdf(['Invoice 12345']), 1, { dpi: 72 });
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(png.length).toBeGreaterThan(100);
  });

  it('finds the standard fonts pdfjs-dist ships', async () => {
    // The render falls back to the machine's own fonts if this path is wrong,
    // so on a developer's laptop nothing looks amiss and a container — which
    // has no fonts at all — draws blank pages. Check the path itself, where a
    // pdfjs-dist upgrade that moves the directory shows up immediately.
    const { readdir } = await import('node:fs/promises');
    const { STANDARD_FONT_DATA_URL } = await import('../services/pdfFonts.js');

    const files = await readdir(STANDARD_FONT_DATA_URL);
    // The Helvetica stand-in and the Times one: between them they cover the
    // fonts an invoice is likeliest to name without embedding.
    expect(files).toContain('LiberationSans-Regular.ttf');
    expect(files).toContain('FoxitSerif.pfb');
  });

  it('draws the text of a page that embeds no fonts', async () => {
    // The fixture asks for Helvetica without embedding it, the way a great
    // many invoices do. Left to the machine's own fonts that renders blank
    // wherever none are installed — a container, a minimal server — and says
    // nothing about it, so the check is for ink rather than for bytes.
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const png = await renderPageToPng(buildPdf(['Invoice 12345']), 1, { dpi: 72 });

    const image = await loadImage(png);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);

    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 200) dark++;

    expect(dark).toBeGreaterThan(100);
  });

  it('honours an explicit target width', async () => {
    // A 612pt-wide page rendered at 150px should be 150px wide. Bytes 16-20 of
    // a PNG hold the IHDR width.
    const png = await renderPageToPng(buildPdf(['Invoice']), 1, { targetWidth: 150 });
    expect(png.readUInt32BE(16)).toBe(150);
  });

  it('refuses a page outside the document', async () => {
    await expect(renderPageToPng(buildPdf(['only']), 5)).rejects.toMatchObject({
      code: 'PROCESSING_ERROR',
    });
  });
});
