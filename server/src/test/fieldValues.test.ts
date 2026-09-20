import { describe, expect, it } from 'vitest';
import { parseAmount, parseDate, toPence } from '../services/fieldValues.js';

/**
 * Reading amounts and dates off an invoice.
 *
 * The cases worth writing down are the ambiguous ones: `1.500` is fifteen
 * hundred or one-and-a-half depending on the country, and `03/04/2026` is two
 * different days. Both are checked here because both silently corrupt an
 * export if guessed wrongly.
 */

const value = (text: string): number | null => parseAmount(text)?.value ?? null;

describe('parseAmount', () => {
  it('reads a plain amount', () => {
    expect(value('5040.00')).toBe(5040);
    expect(value('1800')).toBe(1800);
    expect(value('0.99')).toBe(0.99);
  });

  it('reads thousands separators either way round', () => {
    expect(value('1,500.00')).toBe(1500);
    expect(value('1.500,00')).toBe(1500);
    expect(value('12,345,678.90')).toBe(12345678.9);
    expect(value('12.345.678,90')).toBe(12345678.9);
  });

  it('treats a lone separator with three digits after it as grouping', () => {
    // The case that silently turns fifteen hundred into one and a half.
    expect(value('1,500')).toBe(1500);
    expect(value('1.500')).toBe(1500);
  });

  it('treats a lone separator with two digits after it as a decimal', () => {
    expect(value('1500.50')).toBe(1500.5);
    expect(value('1500,50')).toBe(1500.5);
  });

  it('reads currency symbols and codes, and reports them', () => {
    expect(parseAmount('$1,234.56')).toEqual({ value: 1234.56, currency: '$' });
    expect(parseAmount('£99.00')).toEqual({ value: 99, currency: '£' });
    expect(parseAmount('1234.56 EUR')).toEqual({ value: 1234.56, currency: 'EUR' });
  });

  it('reads negatives, written either way', () => {
    expect(value('-50.00')).toBe(-50);
    // Accounting puts a negative in brackets.
    expect(value('(50.00)')).toBe(-50);
    expect(value('($1,250.00)')).toBe(-1250);
  });

  it('ignores surrounding text', () => {
    expect(value('  5040.00  ')).toBe(5040);
  });

  it('returns null for anything that is not an amount', () => {
    expect(parseAmount('see attached')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('   ')).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount('$')).toBeNull();
  });
});

describe('parseDate', () => {
  it('reads ISO dates as unambiguous', () => {
    const parsed = parseDate('2026-03-14');
    expect(parsed?.iso).toBe('2026-03-14');
    expect(parsed?.unambiguous).toBe(true);
  });

  it('reads dates that name their month', () => {
    expect(parseDate('14 March 2026')?.iso).toBe('2026-03-14');
    expect(parseDate('14 Mar 2026')?.iso).toBe('2026-03-14');
    expect(parseDate('March 14, 2026')?.iso).toBe('2026-03-14');
    expect(parseDate('Mar 14 2026')?.iso).toBe('2026-03-14');
    // Naming the month leaves nothing to guess.
    expect(parseDate('14 March 2026')?.unambiguous).toBe(true);
  });

  it('resolves a numeric date when only one reading is possible', () => {
    // 20 cannot be a month.
    const parsed = parseDate('20/04/2026');
    expect(parsed?.iso).toBe('2026-04-20');
    expect(parsed?.unambiguous).toBe(true);
  });

  it('flags a numeric date that reads both ways as ambiguous', () => {
    const parsed = parseDate('03/04/2026');
    // Read day-first, but honest that it is a guess.
    expect(parsed?.iso).toBe('2026-04-03');
    expect(parsed?.unambiguous).toBe(false);
  });

  it('accepts the separators invoices actually use', () => {
    expect(parseDate('14/03/2026')?.iso).toBe('2026-03-14');
    expect(parseDate('14-03-2026')?.iso).toBe('2026-03-14');
    expect(parseDate('14.03.2026')?.iso).toBe('2026-03-14');
  });

  it('expands two-digit years', () => {
    expect(parseDate('14/03/26')?.iso).toBe('2026-03-14');
    expect(parseDate('14/03/99')?.iso).toBe('1999-03-14');
  });

  it('rejects a day that does not exist', () => {
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('2026-02-31')).toBeNull();
    // Both parts over twelve cannot be a date either way round.
    expect(parseDate('20/13/2026')).toBeNull();
  });

  it('returns null for anything that is not a date', () => {
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('2026')).toBeNull();
  });

  it('handles a leap day correctly', () => {
    expect(parseDate('2024-02-29')?.iso).toBe('2024-02-29');
    expect(parseDate('2026-02-29')).toBeNull();
  });
});

describe('toPence', () => {
  it('makes floating point amounts compare exactly', () => {
    // The reason cross-field arithmetic works on pence rather than pounds.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toPence(0.1) + toPence(0.2)).toBe(toPence(0.3));
    expect(toPence(4200) + toPence(840)).toBe(toPence(5040));
  });
});
