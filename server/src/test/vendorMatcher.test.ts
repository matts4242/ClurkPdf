import { describe, expect, it } from 'vitest';
import {
  headerLines,
  matchVendor,
  normalizeVendorName,
  similarity,
} from '../services/vendorMatcher.js';
import type { TextItem, TextLayer } from '../types/index.js';

/**
 * Vendor recognition, driven directly with hand-built text layers.
 *
 * The cases that matter are the ways one company's name comes out differently
 * on two of its own invoices: a legal suffix appearing or not, a word added,
 * OCR misreading a character. The end-to-end path — a real PDF matched against
 * a saved template — is covered in `templates.test.ts`.
 */

/** A layer whose lines run down the page from `startY`. */
function layerOf(lines: string[], startY = 0.02, lineHeight = 0.04): TextLayer {
  const textItems = lines.map<TextItem>((text, index) => ({
    text,
    x: 0.1,
    y: startY + index * lineHeight,
    width: Math.min(0.8, text.length * 0.011),
    height: 0.02,
    fontSize: 12,
  }));
  return { pageNumber: 1, pageWidth: 612, pageHeight: 792, textItems, hasText: true };
}

const scoreFor = (lines: string[], vendor: string): number =>
  matchVendor(layerOf(lines), vendor).score;

describe('normalizeVendorName', () => {
  it('lowercases and splits on punctuation', () => {
    expect(normalizeVendorName('ACME Supply, Co.')).toEqual(['acme', 'supply']);
  });

  it('drops legal suffixes so Ltd and Limited agree', () => {
    expect(normalizeVendorName('Northwind Traders Ltd')).toEqual(['northwind', 'traders']);
    expect(normalizeVendorName('Northwind Traders Limited')).toEqual(['northwind', 'traders']);
  });

  it('strips accents', () => {
    expect(normalizeVendorName('Café Rouge')).toEqual(['cafe', 'rouge']);
  });

  it('returns nothing for a name that is only a legal suffix', () => {
    expect(normalizeVendorName('Ltd.')).toEqual([]);
  });
});

describe('headerLines', () => {
  it('takes only the top third of the page', () => {
    const layer = layerOf(['Top of page', 'Still near the top']);
    layer.textItems[1]!.y = 0.8;

    expect(headerLines(layer)).toEqual(['Top of page']);
  });

  it('joins runs that sit on the same line', () => {
    const layer: TextLayer = {
      pageNumber: 1,
      pageWidth: 612,
      pageHeight: 792,
      hasText: true,
      textItems: [
        { text: 'Northwind', x: 0.1, y: 0.05, width: 0.2, height: 0.02, fontSize: 14 },
        { text: 'Traders', x: 0.32, y: 0.05, width: 0.15, height: 0.02, fontSize: 14 },
        { text: 'INVOICE', x: 0.7, y: 0.05, width: 0.15, height: 0.02, fontSize: 14 },
      ],
    };

    expect(headerLines(layer)).toEqual(['Northwind Traders INVOICE']);
  });

  it('returns nothing for a page with no text near the top', () => {
    const layer = layerOf(['Way down the page'], 0.9);
    expect(headerLines(layer)).toEqual([]);
  });
});

describe('matchVendor', () => {
  it('scores an exact name 1', () => {
    expect(scoreFor(['ACME Supply Co'], 'ACME Supply Co')).toBe(1);
  });

  it('ignores a difference in legal suffix', () => {
    expect(scoreFor(['Northwind Traders Limited'], 'Northwind Traders Ltd')).toBe(1);
  });

  it('still matches when the line says more than the name', () => {
    // An extra word around the name is normal and must not be punished.
    expect(scoreFor(['Invoice from ACME Supply Co'], 'ACME Supply Co')).toBe(1);
  });

  it('tolerates an OCR misread within a word', () => {
    // "Supp1y" for "Supply": one character in fifteen.
    expect(scoreFor(['ACME Supp1y Co'], 'ACME Supply Co')).toBeGreaterThan(0.8);
  });

  it('scores a different company low', () => {
    expect(scoreFor(['Globex Industries'], 'ACME Supply Co')).toBeLessThan(0.5);
  });

  it('does not match a vendor whose name is merely a prefix', () => {
    // "Acme" alone should not pass for "Acme Supply Services International".
    const score = scoreFor(['Acme'], 'Acme Supply Services International');
    expect(score).toBeLessThan(0.8);
  });

  it('scores each header line on its own, not the header as a blob', () => {
    // The vendor is one line; the address and phone beneath would dilute it.
    const score = scoreFor(
      [
        'ACME Supply Co',
        '119 Harbour Road, Bristol BS1 4RN',
        'Telephone 0117 496 0000',
        'accounts@acmesupply.example',
      ],
      'ACME Supply Co',
    );
    expect(score).toBe(1);
  });

  it('reports which line matched', () => {
    const match = matchVendor(
      layerOf(['INVOICE', 'Northwind Traders Ltd', 'VAT GB 123']),
      'Northwind Traders',
    );

    expect(match.score).toBe(1);
    expect(match.matchedText).toBe('Northwind Traders Ltd');
  });

  it('looks only at the header, not the whole page', () => {
    const layer = layerOf(['Some other heading', 'ACME Supply Co']);
    // Push the vendor name below the header fraction.
    layer.textItems[1]!.y = 0.6;

    expect(matchVendor(layer, 'ACME Supply Co').score).toBeLessThan(0.8);
  });

  it('scores 0 for an empty vendor identifier', () => {
    expect(scoreFor(['ACME Supply Co'], '   ')).toBe(0);
  });

  it('scores 0 against a page with no header text', () => {
    const empty: TextLayer = {
      pageNumber: 1,
      pageWidth: 612,
      pageHeight: 792,
      textItems: [],
      hasText: false,
    };
    expect(matchVendor(empty, 'ACME Supply Co').score).toBe(0);
  });

  it('separates two vendors that share a word', () => {
    const acme = scoreFor(['ACME Supply Co'], 'ACME Supply Co');
    const other = scoreFor(['ACME Logistics Group'], 'ACME Supply Co');

    expect(acme).toBe(1);
    // Sharing "ACME" must not be enough to apply the wrong template.
    expect(other).toBeLessThan(0.8);
  });
});

describe('similarity', () => {
  it('is 1 for identical strings and 0 for nothing in common', () => {
    expect(similarity('acme', 'acme')).toBe(1);
    expect(similarity('', '')).toBe(1);
    expect(similarity('abcd', 'wxyz')).toBe(0);
  });

  it('falls off with the number of edits', () => {
    expect(similarity('acme supply', 'acme supply')).toBe(1);
    expect(similarity('acme supply', 'acme supp1y')).toBeCloseTo(1 - 1 / 11, 5);
  });
});
