import type { DetectedField, FieldType, NormalizedRect, TextItem, TextLayer } from '../types/index.js';

/**
 * Find the obvious invoice fields without being asked.
 *
 * A born-digital invoice already says where its own values are — it writes
 * "Invoice No: INV-2026-0042" in the text layer. Week 4 gave us that text with
 * exact positions, so the processing job can pre-draw the regions a user would
 * otherwise draw by hand and let them correct rather than start from nothing.
 *
 * This is deliberately regex over labels, not a model. It gets the common
 * English invoice layouts and leaves everything else to the two manual modes,
 * which is why every detected region is flagged `autoDetected` for review
 * instead of being presented as fact.
 *
 * A scanned page has no text layer and gets nothing from here; recognising a
 * whole page to guess at its fields is a different and much slower job.
 */

/** How a label is spelled on real invoices, and what it labels. */
interface FieldPattern {
  fieldType: FieldType;
  /** Matches the label and, optionally, the value after it on the same run. */
  label: RegExp;
  /** The value must look like this, wherever it is found. */
  value: RegExp;
  /**
   * Ranking when two patterns claim the same field. "Amount Due" and "Total"
   * both mean TOTAL; the more specific label wins.
   */
  weight: number;
}

/**
 * Currency amount: optional symbol, then either a group-separated integer
 * (`1,250` / `1.250`) or a plain one (`5040`), then optional decimals.
 *
 * The two integer forms are separate alternatives on purpose. One pattern
 * treating the separators as optional matches `504` out of `5040.00`, because
 * the `.00` is then neither a group nor a decimal part.
 */
const AMOUNT =
  /-?[$€£¥]?\s?-?(?:\d{1,3}(?:[,.\s]\d{3})+|\d+)(?:[.,]\d{2})?(?:\s?(?:USD|EUR|GBP|CAD|AUD))?/;

/** Dates as invoices write them: 2026-04-01, 01/04/2026, 1 April 2026, Apr 1, 2026. */
const DATE =
  /(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/;

/** An identifier: letters, digits, dashes. Must contain at least one digit. */
const IDENTIFIER = /(?=[^\s]*\d)[A-Za-z0-9][A-Za-z0-9/_-]*/;

const PATTERNS: FieldPattern[] = [
  {
    fieldType: 'INVOICE_NUMBER',
    label: /\b(?:invoice|inv)\s*(?:no\.?|number|num\.?|#|id)\b/i,
    value: IDENTIFIER,
    weight: 3,
  },
  {
    fieldType: 'PO_NUMBER',
    label: /\b(?:p\.?o\.?|purchase\s+order)\s*(?:no\.?|number|num\.?|#)?\b/i,
    value: IDENTIFIER,
    weight: 3,
  },
  {
    fieldType: 'DUE_DATE',
    label: /\b(?:due\s*date|payment\s+due|due\s+on|pay\s+by)\b/i,
    value: DATE,
    weight: 4,
  },
  {
    fieldType: 'INVOICE_DATE',
    label: /\b(?:invoice\s*date|date\s+of\s+issue|issue[d]?\s*date|dated)\b/i,
    value: DATE,
    weight: 3,
  },
  {
    // Bare "Date:" is weaker than "Invoice Date:" and must not outrank "Due Date".
    fieldType: 'INVOICE_DATE',
    label: /\bdate\b/i,
    value: DATE,
    weight: 1,
  },
  {
    fieldType: 'SUBTOTAL',
    label: /\b(?:sub[\s-]?total|net\s+(?:amount|total))\b/i,
    value: AMOUNT,
    weight: 3,
  },
  {
    fieldType: 'TAX',
    label: /\b(?:tax|vat|gst|hst|sales\s+tax)\b(?:\s*\([^)]*\))?/i,
    value: AMOUNT,
    weight: 3,
  },
  {
    fieldType: 'TOTAL',
    label: /\b(?:amount\s+due|balance\s+due|total\s+due|grand\s+total)\b/i,
    value: AMOUNT,
    weight: 4,
  },
  {
    // Plain "Total" also ends a line-item column, so it ranks below the above.
    fieldType: 'TOTAL',
    label: /\btotal\b/i,
    value: AMOUNT,
    weight: 2,
  },
];

/**
 * Words that mean a run is a label or boilerplate rather than a vendor name.
 * The vendor guess is positional, so it needs this to avoid returning the
 * document's own title.
 */
const NOT_A_VENDOR =
  /^(?:invoice|receipt|bill|statement|tax\s+invoice|credit\s+note|page\s+\d|date|due|to|from|bill\s+to|ship\s+to|invoice\s+to)\b/i;

export interface DetectOptions {
  /** Skip fields already covered by a region the user drew. */
  exclude?: readonly FieldType[];
}

/**
 * Read every field this page plausibly declares.
 *
 * At most one region per field type comes back: a document has one invoice
 * number, and offering three candidates would be worse than offering the best
 * one and letting the user redraw it.
 */
export function detectFields(layer: TextLayer, options: DetectOptions = {}): DetectedField[] {
  if (!layer.hasText) return [];

  const excluded = new Set<FieldType>(options.exclude ?? []);
  const lines = groupIntoLines(layer.textItems);

  /** Best candidate per field, by weight then confidence. */
  const best = new Map<FieldType, { field: DetectedField; weight: number }>();

  const offer = (field: DetectedField, weight: number): void => {
    if (excluded.has(field.fieldType)) return;
    const current = best.get(field.fieldType);
    if (
      current === undefined ||
      weight > current.weight ||
      (weight === current.weight && field.confidence > current.field.confidence)
    ) {
      best.set(field.fieldType, { field, weight });
    }
  };

  for (const [index, line] of lines.entries()) {
    for (const pattern of PATTERNS) {
      const found = matchOnLine(pattern, line, lines[index + 1], layer.pageNumber);
      if (found) offer(found, pattern.weight);
    }
  }

  const vendor = guessVendor(lines, layer.pageNumber);
  if (vendor) offer(vendor, 1);

  return [...best.values()].map((entry) => entry.field);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** One visual line: the runs on it, left to right, plus their joined text. */
interface Line {
  items: TextItem[];
  text: string;
}

/**
 * Look for `pattern` on one line, then on the line below it.
 *
 * Invoices put the value after the label ("Total: $1,234.00"), in a column to
 * the right (the label and value are separate runs on the same line), or
 * directly beneath a heading. The first two are the same case once the line's
 * runs are joined; the third needs the following line.
 */
function matchOnLine(
  pattern: FieldPattern,
  line: Line,
  next: Line | undefined,
  pageNumber: number,
): DetectedField | null {
  const labelMatch = pattern.label.exec(line.text);
  if (!labelMatch) return null;

  const afterLabel = labelMatch.index + labelMatch[0].length;
  const tail = line.text.slice(afterLabel);

  // The value normally follows the label on the same line.
  const onSameLine = anchoredValue(pattern.value, tail);
  if (onSameLine) {
    const start = afterLabel + onSameLine.index;
    const rect = rectForSpan(line, start, start + onSameLine.text.length);
    if (rect) {
      return {
        fieldType: pattern.fieldType,
        value: onSameLine.text,
        pageNumber,
        rect,
        confidence: 90,
      };
    }
  }

  // Otherwise the label is a heading and the value sits under it. Only accept
  // that when the label was the whole line, or a column header would steal the
  // number from the row below it.
  if (next && line.text.slice(afterLabel).trim().replace(/^[:.\-–—]\s*/, '') === '') {
    const below = anchoredValue(pattern.value, next.text);
    if (below) {
      const rect = rectForSpan(next, below.index, below.index + below.text.length);
      if (rect) {
        return {
          fieldType: pattern.fieldType,
          value: below.text,
          pageNumber,
          rect,
          // A value inferred from position is a weaker claim than one that
          // followed its label directly.
          confidence: 70,
        };
      }
    }
  }

  return null;
}

/**
 * Find `value` in `text`, requiring it to start at the beginning modulo
 * separators.
 *
 * Without the anchor, "Invoice Date:" on a line that also mentions a due date
 * further right would happily match the wrong date.
 */
function anchoredValue(value: RegExp, text: string): { text: string; index: number } | null {
  const separators = /^[\s:.\-–—#]*/.exec(text)?.[0].length ?? 0;
  const rest = text.slice(separators);
  const match = new RegExp(`^(?:${value.source})`, value.flags.replace('g', '')).exec(rest);
  if (!match || match[0].trim() === '') return null;

  const leading = match[0].length - match[0].trimStart().length;
  return {
    text: match[0].trim(),
    index: separators + leading,
  };
}

// ---------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------

/**
 * Guess the vendor from the top of the page.
 *
 * Invoices put the issuing company's name at the top, usually as the largest
 * text there. There is no label to key off, so this is the one positional
 * guess in the file — hence the low confidence it reports.
 *
 * This works on individual runs rather than the assembled lines, because the
 * company name and the word "INVOICE" are very often set on the same visual
 * line in opposite corners. As one line the pair reads "Acme Ltd INVOICE" and
 * neither half can be rejected; as two runs, the boilerplate one can be.
 */
function guessVendor(lines: Line[], pageNumber: number): DetectedField | null {
  const candidates = lines
    .flatMap((line) => line.items)
    .filter((item) => {
      if (item.y >= 0.25) return false;
      const text = item.text.trim();
      if (text.length < 3 || text.length > 60) return false;
      if (NOT_A_VENDOR.test(text)) return false;
      // A run that is mostly digits is an address, a date or a phone number.
      const digits = (text.match(/\d/g) ?? []).length;
      return digits / text.length < 0.3;
    });
  if (candidates.length === 0) return null;

  // Largest type first; ties go to whichever sits higher on the page.
  const best = candidates.reduce((winner, item) =>
    item.fontSize > winner.fontSize ||
    (item.fontSize === winner.fontSize && item.y < winner.y)
      ? item
      : winner,
  );

  const rect = boundingBox([
    { x: best.x, y: best.y, width: best.width, height: best.height },
  ]);
  if (!rect) return null;

  return {
    fieldType: 'VENDOR_NAME',
    value: best.text.trim(),
    pageNumber,
    rect,
    confidence: 50,
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Group runs into visual lines, top to bottom then left to right.
 *
 * Mirrors the line grouping in `textLayerService.joinInReadingOrder`, but
 * keeps the runs rather than only their text, because a detection has to come
 * back with a rectangle.
 */
function groupIntoLines(items: TextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: TextItem[][] = [];

  for (const item of sorted) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const tolerance = previous ? Math.max(previous.height * 0.5, 0.002) : 0;
    const sameLine =
      previous !== undefined && Math.abs(centre(item) - centre(previous)) <= tolerance;

    if (sameLine && current) current.push(item);
    else groups.push([item]);
  }

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    return { items: ordered, text: ordered.map((item) => item.text.trim()).join(' ') };
  });
}

const centre = (item: TextItem): number => item.y + item.height / 2;

/**
 * The rectangle covering characters `[start, end)` of a line's joined text.
 *
 * Runs are mapped back to their character ranges in the joined string, so a
 * value in its own run — the usual two-column invoice layout — gets that run's
 * exact box. When the label and the value share a run, the box is narrowed
 * within it by character count, which assumes an even advance width. That is
 * wrong for a proportional font, but only ever by a few percent of a single
 * run, and it is used to draw a highlight rather than to read text: the value
 * itself comes from the regex, not from measuring the box.
 */
function rectForSpan(line: Line, start: number, end: number): NormalizedRect | null {
  const touched: NormalizedRect[] = [];
  let cursor = 0;

  for (const item of line.items) {
    const text = item.text.trim();
    const from = cursor;
    const to = from + text.length;
    // The join inserts one space between runs.
    cursor = to + 1;

    if (text.length === 0 || to <= start || from >= end) continue;

    const clippedFrom = Math.max(start - from, 0);
    const clippedTo = Math.min(end - from, text.length);
    const covers = clippedFrom === 0 && clippedTo === text.length;

    touched.push(
      covers
        ? { x: item.x, y: item.y, width: item.width, height: item.height }
        : {
            x: item.x + (item.width * clippedFrom) / text.length,
            y: item.y,
            width: (item.width * (clippedTo - clippedFrom)) / text.length,
            height: item.height,
          },
    );
  }

  return boundingBox(touched);
}

/** The smallest rectangle containing all of `parts`, clamped to the page. */
function boundingBox(parts: readonly NormalizedRect[]): NormalizedRect | null {
  if (parts.length === 0) return null;

  const left = Math.min(...parts.map((part) => part.x));
  const top = Math.min(...parts.map((part) => part.y));
  const right = Math.max(...parts.map((part) => part.x + part.width));
  const bottom = Math.max(...parts.map((part) => part.y + part.height));

  const x = clamp(left);
  const y = clamp(top);
  const width = clamp(right - left, 1 - x);
  const height = clamp(bottom - top, 1 - y);

  // A zero-area box would be rejected by the region validator anyway.
  if (width <= 0 || height <= 0) return null;
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

const clamp = (value: number, max = 1): number => Math.max(0, Math.min(value, max));

/** Four decimals, matching how regions are stored. */
const round = (value: number): number => Number(value.toFixed(4));
