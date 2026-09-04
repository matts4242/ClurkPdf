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
