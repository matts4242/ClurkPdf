import { getTextLayer } from './textLayerService.js';
import type { FieldType, NormalizedRect, TextItem } from '../types/index.js';

/**
 * Find the usual invoice fields in a document's own text layer.
 *
 * This is a first guess, not an answer: it saves drawing eight boxes by hand on
 * a document that follows the ordinary layout, and the user corrects whatever
 * it got wrong. A scanned page has no text layer, so nothing is detected there
 * and the page is left for OCR.
 *
 * Each hit becomes an ordinary region created through the normal
 * `TEXT_LAYER` path, so the text is read from the rectangle by the same code a
 * hand-drawn highlight uses, and no second notion of "detected text" exists.
 */

export interface DetectedField {
  fieldType: FieldType;
  pageNumber: number;
  rect: NormalizedRect;
  /** The text the rectangle covers. Handy in tests and logs. */
  text: string;
}

/**
 * Label patterns, in the order they are tried.
 *
 * Order is what keeps them apart: "Due Date" would satisfy the invoice-date
 * pattern too, so it is claimed first, and a run claimed by one field is never
 * offered to another.
 */
const LABEL_PATTERNS: ReadonlyArray<{ fieldType: FieldType; pattern: RegExp }> = [
  { fieldType: 'INVOICE_NUMBER', pattern: /invoice\s*(?:no\.?|num(?:ber)?|#)/i },
  { fieldType: 'PO_NUMBER', pattern: /\b(?:p\.?\s?o\.?|purchase\s*order)\s*(?:no\.?|num(?:ber)?|#)?\b/i },
  { fieldType: 'DUE_DATE', pattern: /\bdue\s*(?:date|on)\b/i },
  { fieldType: 'INVOICE_DATE', pattern: /\b(?:invoice\s*)?date\b/i },
  { fieldType: 'SUBTOTAL', pattern: /\bsub\s*-?\s*total\b/i },
  { fieldType: 'TAX', pattern: /\b(?:tax|vat|gst)\b/i },
  // "Subtotal" has no word boundary before "total", so this does not match it.
  { fieldType: 'TOTAL', pattern: /\btotal\b/i },
];

/** How far down the page the vendor name is looked for. */
const VENDOR_BAND = 1 / 3;

export async function detectFields(
  documentId: string,
  pageCount: number,
): Promise<DetectedField[]> {
  const detected: DetectedField[] = [];
  const claimedTypes = new Set<FieldType>();

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const layer = await getTextLayer(documentId, pageNumber);
    if (!layer.hasText) continue;

    const claimedItems = new Set<TextItem>();

    if (pageNumber === 1 && !claimedTypes.has('VENDOR_NAME')) {
      const vendor = findVendorName(layer.textItems);
      if (vendor) {
        claimedItems.add(vendor);
        claimedTypes.add('VENDOR_NAME');
        detected.push({
          fieldType: 'VENDOR_NAME',
          pageNumber,
          rect: toRect(vendor),
          text: vendor.text.trim(),
        });
      }
    }

    for (const { fieldType, pattern } of LABEL_PATTERNS) {
      if (claimedTypes.has(fieldType)) continue;

      const label = layer.textItems.find(
        (item) => !claimedItems.has(item) && pattern.test(item.text),
      );
      if (!label) continue;

      // The value usually sits in the same run ("Total: 5040.00"); when the
      // label stands alone it is in the next run along the same line.
      const value = hasValueAfterLabel(label.text, pattern)
        ? null
        : findValueToTheRight(label, layer.textItems, claimedItems);

      claimedItems.add(label);
      if (value) claimedItems.add(value);
      claimedTypes.add(fieldType);

      detected.push({
        fieldType,
        pageNumber,
        rect: value ? union(toRect(label), toRect(value)) : toRect(label),
        text: value ? `${label.text.trim()} ${value.text.trim()}` : label.text.trim(),
      });
    }
  }

  return detected;
}

/**
 * The vendor name is the largest text in the top third of the first page.
 *
 * Invoices put the sender's name at the top and set it larger than anything
 * around it, which is a far better signal than any word list.
 */
function findVendorName(items: TextItem[]): TextItem | undefined {
  const candidates = items.filter(
    (item) => item.y < VENDOR_BAND && /\p{L}{2,}/u.test(item.text),
  );
  if (candidates.length === 0) return undefined;

  return candidates.reduce((best, item) =>
    item.fontSize > best.fontSize || (item.fontSize === best.fontSize && item.y < best.y)
      ? item
      : best,
  );
}

/** True when the run holds more than the label — "Invoice No: INV-42" does. */
function hasValueAfterLabel(text: string, pattern: RegExp): boolean {
  const match = pattern.exec(text);
  if (!match) return false;
  const rest = text.slice(match.index + match[0].length);
  return /[\p{L}\p{N}]/u.test(rest);
}

/** The nearest unclaimed run on the same line, to the right of the label. */
function findValueToTheRight(
  label: TextItem,
  items: TextItem[],
  claimed: Set<TextItem>,
): TextItem | null {
  const labelCentre = label.y + label.height / 2;
  const tolerance = Math.max(label.height * 0.5, 0.002);

  const candidates = items
    .filter(
      (item) =>
        !claimed.has(item) &&
        item !== label &&
        item.x >= label.x + label.width - 0.001 &&
        Math.abs(item.y + item.height / 2 - labelCentre) <= tolerance &&
        /[\p{L}\p{N}]/u.test(item.text),
    )
    .sort((a, b) => a.x - b.x);

  return candidates[0] ?? null;
}

const toRect = (item: TextItem): NormalizedRect => ({
  x: item.x,
  y: item.y,
  width: item.width,
  height: item.height,
});

function union(a: NormalizedRect, b: NormalizedRect): NormalizedRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
