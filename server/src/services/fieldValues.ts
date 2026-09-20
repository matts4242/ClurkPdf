/**
 * Reading the values captured off an invoice as numbers and dates.
 *
 * Every field arrives as text — OCR read it, or it came out of the PDF's text
 * layer — so exporting and checking it means parsing strings a human wrote for
 * another human. The two hard cases are worth stating plainly:
 *
 * - `1.500,00` and `1,500.00` are the same amount written either side of the
 *   Atlantic, and `1.500` is ambiguous on its own.
 * - `03/04/2026` is the 3rd of April or the 4th of March depending on who
 *   printed it, and nothing in the string says which.
 *
 * Both are handled by refusing to guess where guessing would be wrong: an
 * ambiguous date reports that it is ambiguous rather than picking, and the
 * caller decides what to do about it.
 */

/** A currency amount, with the currency if the text named one. */
export interface ParsedAmount {
  value: number;
  /** `$`, `£`, `EUR`… exactly as written, when present. */
  currency?: string;
}

const CURRENCY_SYMBOL = /[$€£¥]/;
const CURRENCY_CODE = /\b(USD|EUR|GBP|CAD|AUD|CHF|JPY|NZD|SEK|NOK|DKK)\b/i;

/**
 * Read a currency amount, or null if the text is not one.
 *
 * Handles a leading or trailing symbol, a currency code, brackets or a minus
 * for negatives, and either separator convention. Where both `.` and `,`
 * appear, the last one is the decimal point — true of `1.500,00` and
 * `1,500.00` alike. Where only one appears it is a decimal point only if
 * exactly two digits follow it at the end of the number; `1,500` is fifteen
 * hundred, not one and a half.
 */
export function parseAmount(text: string | undefined): ParsedAmount | null {
  if (text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // Accounting style puts a negative in brackets.
  const bracketed = /^\((.*)\)$/.exec(trimmed);
  const body = bracketed ? (bracketed[1] as string) : trimmed;

  const symbol = CURRENCY_SYMBOL.exec(body)?.[0];
  const code = CURRENCY_CODE.exec(body)?.[0].toUpperCase();

  const negative = bracketed !== null || /^\s*-/.test(body);

  // Everything that could be part of the number itself.
  const digits = body.replace(CURRENCY_CODE, '').replace(/[^\d.,]/g, '');
  if (!/\d/.test(digits)) return null;

  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');

  let normalised: string;
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the later one is the decimal separator.
    const decimalAt = Math.max(lastDot, lastComma);
    normalised =
      digits.slice(0, decimalAt).replace(/[.,]/g, '') + '.' + digits.slice(decimalAt + 1);
  } else if (lastDot !== -1 || lastComma !== -1) {
    const at = lastDot !== -1 ? lastDot : lastComma;
    const after = digits.slice(at + 1);
    // Two trailing digits means a decimal; anything else is grouping.
    normalised =
      /^\d{2}$/.test(after) ? digits.slice(0, at).replace(/[.,]/g, '') + '.' + after
      : digits.replace(/[.,]/g, '');
  } else {
    normalised = digits;
  }

  const value = Number.parseFloat(normalised);
  if (!Number.isFinite(value)) return null;

  return {
    value: negative ? -Math.abs(value) : value,
    ...(symbol !== undefined ? { currency: symbol } : code !== undefined ? { currency: code } : {}),
  };
}

/** A date, and whether the text said unambiguously which day it meant. */
export interface ParsedDate {
  /** Midnight UTC on the day named. */
  date: Date;
  /**
   * False for a numeric date like `03/04/2026`, where day-first and
   * month-first both read, and the string itself cannot say which.
   */
  unambiguous: boolean;
  /** ISO `YYYY-MM-DD`, the form every export writes. */
  iso: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Read a date, or null if the text is not one.
 *
 * ISO and any form naming its month in words are unambiguous. A wholly numeric
 * date is only unambiguous when one of its parts is too large to be a month.
 */
export function parseDate(text: string | undefined): ParsedDate | null {
  if (text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // 2026-03-14
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) {
    return build(Number(iso[1]), Number(iso[2]), Number(iso[3]), true);
  }

  // 14 March 2026 / 14 Mar 2026
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(trimmed);
  if (dayFirst) {
    const month = MONTHS[(dayFirst[2] as string).slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      return build(Number(dayFirst[3]), month, Number(dayFirst[1]), true);
    }
  }

  // March 14, 2026 / Mar 14 2026
  const monthFirst = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(trimmed);
  if (monthFirst) {
    const month = MONTHS[(monthFirst[1] as string).slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      return build(Number(monthFirst[3]), month, Number(monthFirst[2]), true);
    }
  }

  // 14/03/2026, 03-14-26, 14.03.2026
  const numeric = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(trimmed);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = fullYear(Number(numeric[3]));

    // Only one ordering can be right when a part exceeds twelve.
    if (first > 12 && second <= 12) return build(year, second, first, true);
    if (second > 12 && first <= 12) return build(year, first, second, true);
    if (first > 12 && second > 12) return null;

    // Both plausible as months. Read it day-first, which is the majority of
    // the world and of this project's fixtures, but say that it is a guess so
    // a caller comparing two dates can decline to.
    return build(year, second, first, false);
  }

  return null;
}

function build(year: number, month: number, day: number, unambiguous: boolean): ParsedDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects the 31st of a thirty-day month, which rolls over rather than failing.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  return { date, unambiguous, iso: date.toISOString().slice(0, 10) };
}

/** Two-digit years: 70-99 are last century, everything else is this one. */
function fullYear(year: number): number {
  if (year >= 100) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

/** Round to whole pence, so 0.1 + 0.2 compares equal to 0.3. */
export const toPence = (value: number): number => Math.round(value * 100);
