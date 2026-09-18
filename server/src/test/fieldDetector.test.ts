import { describe, expect, it } from 'vitest';
import { detectFields } from '../services/fieldDetector.js';
import type { DetectedField, FieldType, TextItem, TextLayer } from '../types/index.js';

/**
 * Field detection, tested against text layers built by hand.
 *
 * No PDF and no database here: `detectFields` takes a text layer and returns
 * fields, so it can be driven directly with the layouts that matter. The
 * end-to-end path — a real PDF through the queue into region rows — is covered
 * in `queue.test.ts`.
 */

/** Build a text layer from lines, top to bottom. Each line is its own run. */
function layerOf(lines: string[], options: { fontSize?: number } = {}): TextLayer {
  const fontSize = options.fontSize ?? 12;
  const textItems = lines.map<TextItem>((text, index) => ({
    text,
    x: 0.1,
    y: 0.1 + index * 0.04,
    width: Math.min(0.8, text.length * 0.011),
    height: 0.02,
    fontSize,
  }));
  return { pageNumber: 1, pageWidth: 612, pageHeight: 792, textItems, hasText: true };
}

/** Build a text layer from runs given explicit positions. */
function layerOfRuns(runs: Omit<TextItem, 'fontSize'>[], fontSize = 12): TextLayer {
  return {
    pageNumber: 1,
    pageWidth: 612,
    pageHeight: 792,
    textItems: runs.map((run) => ({ ...run, fontSize })),
    hasText: true,
  };
}

const valueOf = (fields: DetectedField[], fieldType: FieldType): string | undefined =>
  fields.find((field) => field.fieldType === fieldType)?.value;

describe('detectFields', () => {
  it('reads label and value from a single run', () => {
    const fields = detectFields(
      layerOf([
        'Invoice No: INV-2026-0042',
        'Date: 14 March 2026',
        'PO Number: PO-88123',
        'Total: 5040.00',
      ]),
    );

    expect(valueOf(fields, 'INVOICE_NUMBER')).toBe('INV-2026-0042');
    expect(valueOf(fields, 'INVOICE_DATE')).toBe('14 March 2026');
    expect(valueOf(fields, 'PO_NUMBER')).toBe('PO-88123');
    expect(valueOf(fields, 'TOTAL')).toBe('5040.00');
  });

  it('reads a value written as a separate run in a second column', () => {
    const fields = detectFields(
      layerOfRuns([
        { text: 'Invoice Number', x: 0.6, y: 0.1, width: 0.15, height: 0.02 },
        { text: 'NW-99120', x: 0.8, y: 0.1, width: 0.1, height: 0.02 },
      ]),
    );

    expect(valueOf(fields, 'INVOICE_NUMBER')).toBe('NW-99120');
  });

  it('keeps a due date and an invoice date apart', () => {
    const fields = detectFields(
      layerOf(['Invoice Date: 2026-03-14', 'Due Date: 2026-04-13']),
    );

    expect(valueOf(fields, 'INVOICE_DATE')).toBe('2026-03-14');
    expect(valueOf(fields, 'DUE_DATE')).toBe('2026-04-13');
  });

  it('prefers a specific label over a generic one for the same field', () => {
    // "Total" ends the line-item column; "Amount Due" is the real total.
    const fields = detectFields(
      layerOf(['Total 123.00', 'Subtotal 1,250.00', 'Amount Due 1,500.00']),
    );

    expect(valueOf(fields, 'TOTAL')).toBe('1,500.00');
    expect(valueOf(fields, 'SUBTOTAL')).toBe('1,250.00');
  });

  it('does not let a bare Date outrank an Invoice Date', () => {
    const fields = detectFields(layerOf(['Date: 2026-01-01', 'Invoice Date: 2026-03-14']));

    expect(valueOf(fields, 'INVOICE_DATE')).toBe('2026-03-14');
  });

  it('reads a value from the line below a bare heading', () => {
    const fields = detectFields(layerOf(['Invoice Number', 'INV-777']));

    const found = fields.find((field) => field.fieldType === 'INVOICE_NUMBER');
    expect(found?.value).toBe('INV-777');
    // A positional read is a weaker claim than one that followed its label.
    expect(found?.confidence).toBeLessThan(90);
  });

  it('does not take the row below a label that already had a value', () => {
    const fields = detectFields(layerOf(['Total: 5040.00', '9999.99']));

    expect(valueOf(fields, 'TOTAL')).toBe('5040.00');
  });

  it('recognises currency symbols and thousands separators', () => {
    const fields = detectFields(layerOf(['Amount Due: $12,345.67']));

    expect(valueOf(fields, 'TOTAL')).toBe('$12,345.67');
  });

  it('returns at most one region per field type', () => {
    const fields = detectFields(
      layerOf(['Total: 1.00', 'Total: 2.00', 'Grand Total: 3.00']),
    );

    expect(fields.filter((field) => field.fieldType === 'TOTAL')).toHaveLength(1);
  });

  it('guesses the vendor from the largest text at the top', () => {
    const layer = layerOfRuns([
      { text: 'ACME Supply Co', x: 0.1, y: 0.05, width: 0.3, height: 0.03 },
      { text: '119 Harbour Road, Bristol', x: 0.1, y: 0.1, width: 0.3, height: 0.015 },
    ]);
    // Make the company name the larger type.
    layer.textItems[0]!.fontSize = 22;
    layer.textItems[1]!.fontSize = 10;

    expect(valueOf(detectFields(layer), 'VENDOR_NAME')).toBe('ACME Supply Co');
  });

  it('does not offer the word INVOICE as the vendor', () => {
    const layer = layerOfRuns([
      { text: 'INVOICE', x: 0.6, y: 0.04, width: 0.2, height: 0.04 },
      { text: 'Northwind Traders Ltd', x: 0.1, y: 0.05, width: 0.3, height: 0.03 },
    ]);
    layer.textItems[0]!.fontSize = 30;
    layer.textItems[1]!.fontSize = 18;

    expect(valueOf(detectFields(layer), 'VENDOR_NAME')).toBe('Northwind Traders Ltd');
  });

  it('finds nothing in prose, rather than guessing', () => {
    const fields = detectFields(
      layerOf([
        'Thank you for your custom this year.',
        'We look forward to working with you again.',
      ]),
    );

    expect(fields.filter((field) => field.fieldType !== 'VENDOR_NAME')).toEqual([]);
  });

  it('returns nothing for a page with no text layer', () => {
    const layer: TextLayer = {
      pageNumber: 1,
      pageWidth: 612,
      pageHeight: 792,
      textItems: [],
      hasText: false,
    };

    expect(detectFields(layer)).toEqual([]);
  });

  it('skips field types the caller already has', () => {
    const layer = layerOf(['Invoice No: INV-1', 'Total: 5040.00']);

    const fields = detectFields(layer, { exclude: ['INVOICE_NUMBER'] });

    expect(valueOf(fields, 'INVOICE_NUMBER')).toBeUndefined();
    expect(valueOf(fields, 'TOTAL')).toBe('5040.00');
  });
});

describe('detected rectangles', () => {
  it('stay inside the page', () => {
    for (const field of detectFields(layerOf(['Invoice No: INV-2026-0042', 'Total: 99.00']))) {
      expect(field.rect.x).toBeGreaterThanOrEqual(0);
      expect(field.rect.y).toBeGreaterThanOrEqual(0);
      expect(field.rect.width).toBeGreaterThan(0);
      expect(field.rect.height).toBeGreaterThan(0);
      expect(field.rect.x + field.rect.width).toBeLessThanOrEqual(1);
      expect(field.rect.y + field.rect.height).toBeLessThanOrEqual(1);
    }
  });

  it('cover exactly the value run when the value has its own run', () => {
    const fields = detectFields(
      layerOfRuns([
        { text: 'Invoice Number', x: 0.6, y: 0.1, width: 0.15, height: 0.02 },
        { text: 'NW-99120', x: 0.8, y: 0.1, width: 0.1, height: 0.02 },
      ]),
    );

    const rect = fields.find((field) => field.fieldType === 'INVOICE_NUMBER')?.rect;
    expect(rect).toEqual({ x: 0.8, y: 0.1, width: 0.1, height: 0.02 });
  });

  it('narrow to the value when it shares a run with its label', () => {
    const fields = detectFields(
      layerOfRuns([{ text: 'Total: 5040.00', x: 0.5, y: 0.4, width: 0.2, height: 0.02 }]),
    );

    const rect = fields.find((field) => field.fieldType === 'TOTAL')?.rect;
    // The value is the tail of the run, so the box starts after the label and
    // ends with the run. Exact widths depend on the font; the ordering does not.
    expect(rect!.x).toBeGreaterThan(0.5);
    expect(rect!.x + rect!.width).toBeCloseTo(0.7, 3);
  });
});
