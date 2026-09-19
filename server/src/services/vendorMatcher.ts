import type { TextLayer } from '../types/index.js';

/**
 * Recognising which vendor issued a document.
 *
 * Week 5 guesses a vendor name from the largest text at the top of the page.
 * Week 6 needs the opposite question: given a page, is this the same vendor as
 * a template we already hold? The spec's answer is to read the text at the top
 * of the page — where an invoice puts the issuing company — and compare it
 * against each template's vendor identifier, applying the template when the
 * match is better than 80%.
 *
 * That comparison has to tolerate the two ways the same name comes out
 * differently on two invoices: wording ("Acme Supply Co" against "Acme Supply
 * Company Ltd") and characters (OCR reading "Acme Supp1y Co"). One measure
 * handles each, and the score is the better of the two.
 *
 * Pure: takes a text layer and a string, returns a number. No database, no
 * PDF, no I/O.
 */

/** The fraction of the page counted as the header. The spec says a third. */
const HEADER_FRACTION = 1 / 3;

/**
 * Company-form suffixes, dropped before comparing.
 *
 * "Acme Ltd" and "Acme Limited" are the same vendor, and leaving these in
 * rewards two unrelated companies for both being limited.
 */
const LEGAL_SUFFIXES = new Set([
  'ltd',
  'limited',
  'llc',
  'llp',
  'inc',
  'incorporated',
  'co',
  'corp',
  'corporation',
  'company',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'srl',
  'bv',
  'nv',
  'as',
  'ab',
  'oy',
  'pty',
  'pte',
]);

/**
 * Reduce a name to comparable tokens.
 *
 * Lowercased, punctuation to spaces, accents stripped, legal suffixes removed.
 * Everything that survives is a word someone would use to tell two vendors
 * apart.
 */
export function normalizeVendorName(value: string): string[] {
  return value
    .normalize('NFD')
    // Combining marks, so "Café" and "Cafe" compare equal.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token !== '' && !LEGAL_SUFFIXES.has(token));
}

/**
 * The lines an invoice puts its letterhead on.
 *
 * Runs are grouped into lines the same way the rest of the project groups
 * them, then anything below the header fraction is dropped.
 */
export function headerLines(layer: TextLayer, fraction = HEADER_FRACTION): string[] {
  const inHeader = layer.textItems.filter((item) => item.y < fraction);
  if (inHeader.length === 0) return [];

  const sorted = [...inHeader].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: (typeof sorted)[] = [];

  for (const item of sorted) {
    const current = lines.at(-1);
    const previous = current?.at(-1);
    const tolerance = previous ? Math.max(previous.height * 0.5, 0.002) : 0;
    const sameLine =
      previous !== undefined &&
      Math.abs(centre(item) - centre(previous)) <= tolerance;

    if (sameLine && current) current.push(item);
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
    .filter((line) => line.trim() !== '');
}

const centre = (item: { y: number; height: number }): number => item.y + item.height / 2;

export interface VendorMatch {
  /** 0-1. The spec's threshold for auto-applying a template is 0.8. */
  score: number;
  /** The header line that scored best, for showing the user what matched. */
  matchedText: string;
}

/**
 * How well a page's header matches a known vendor name.
 *
 * Every header line is scored on its own and the best wins, rather than
 * scoring the header as one blob: the vendor name is one line, and diluting it
 * with the address and phone number beneath would sink every real match.
 *
 * A line that *contains* the vendor's words scores 1 — "Invoice from Acme
 * Supply" is Acme Supply — because an extra word or two around the name is
 * normal and must not be penalised the way a missing word is.
 */
export function matchVendor(layer: TextLayer, vendorIdentifier: string): VendorMatch {
  const wanted = normalizeVendorName(vendorIdentifier);
  if (wanted.length === 0) return { score: 0, matchedText: '' };

  let best: VendorMatch = { score: 0, matchedText: '' };

  for (const line of headerLines(layer)) {
    const score = scoreLine(line, wanted);
    if (score > best.score) best = { score, matchedText: line.trim() };
  }

  return best;
}

/** Score one header line against the wanted tokens. */
function scoreLine(line: string, wanted: string[]): number {
  const found = normalizeVendorName(line);
  if (found.length === 0) return 0;

  // Every wanted word is present: the line names the vendor, whatever else it
  // also says.
  const foundSet = new Set(found);
  if (wanted.every((token) => foundSet.has(token))) return 1;

  // Otherwise take the better of the two measures. Word-level catches a
  // missing or reordered word; character-level catches a misread one.
  return Math.max(diceCoefficient(wanted, found), similarity(wanted.join(' '), found.join(' ')));
}

/**
 * Token overlap, as Sørensen-Dice.
 *
 * `2 * shared / (a + b)`: shares the penalty between words the line is missing
 * and words it adds, which is what keeps "Acme Supply" from scoring the same
 * against "Acme" as against "Acme Supply Services International".
 */
function diceCoefficient(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const remaining = [...b];
  let shared = 0;
  for (const token of a) {
    const index = remaining.indexOf(token);
    if (index !== -1) {
      shared += 1;
      remaining.splice(index, 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/** 1 minus the edit distance as a fraction of the longer string. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Levenshtein distance, two rows at a time.
 *
 * The full matrix is never needed — only the previous row — and these are
 * company names, so the rows are short.
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] as number) + 1;
      const deletion = (previous[j] as number) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length] as number;
}
