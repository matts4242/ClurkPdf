import { describe, expect, it } from 'vitest';
import { exportCell, worstSeverity } from './index';
import type { ExportRow } from './index';

/**
 * The preview's cell lookup.
 *
 * It mirrors the server's `cellValue`, and the two disagreeing would mean the
 * table on screen showing something other than the file that downloads — the
 * one bug in an export nobody would catch by looking. These cases pin the
 * mapping that has to match.
 */

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  documentId: 'd1',
  filename: 'acme.pdf',
  status: 'ready',
  pages: 1,
  uploadedAt: '2026-03-14T09:00:00.000Z',
  fields: { invoice_number: 'INV-1', total: '5040.00' },
  custom: {},
  parsed: { total: 5040 },
  issues: [],
  needsReview: false,
  ...over,
});

describe('exportCell', () => {
  it('reads the fixed fields', () => {
    expect(exportCell(row(), 'invoice_number')).toBe('INV-1');
    expect(exportCell(row(), 'total')).toBe('5040.00');
  });

  it('reads the filename from the row itself, not from the fields', () => {
    expect(exportCell(row(), 'filename')).toBe('acme.pdf');
  });

  it('reads a custom column by its label', () => {
    const withCustom = row({ custom: { 'Cost centre': 'CC-12' } });
    expect(exportCell(withCustom, 'Cost centre')).toBe('CC-12');
  });

  it('gives an empty string for a field that was never captured', () => {
    expect(exportCell(row(), 'po_number')).toBe('');
    expect(exportCell(row(), 'a column that does not exist')).toBe('');
  });

  it('renders needs_review as the yes/no the file carries', () => {
    expect(exportCell(row({ needsReview: false }), 'needs_review')).toBe('no');
    expect(exportCell(row({ needsReview: true }), 'needs_review')).toBe('yes');
  });

  it('joins the issue messages', () => {
    const withIssues = row({
      issues: [
        { code: 'TOTAL_MISMATCH', severity: 'error', message: 'does not add up' },
        { code: 'LOW_CONFIDENCE', severity: 'warning', message: 'read at 60%' },
      ],
    });

    expect(exportCell(withIssues, 'issues')).toBe('does not add up; read at 60%');
  });
});

describe('worstSeverity', () => {
  it('is null for a clean row', () => {
    expect(worstSeverity(row())).toBeNull();
  });

  it('reports a warning when that is all there is', () => {
    const warned = row({
      issues: [{ code: 'MISSING_FIELD', severity: 'warning', message: 'no vendor' }],
      needsReview: true,
    });
    expect(worstSeverity(warned)).toBe('warning');
  });

  it('reports the error when a row has both', () => {
    // The row is tinted for the worst thing wrong with it, not the first.
    const both = row({
      issues: [
        { code: 'MISSING_FIELD', severity: 'warning', message: 'no vendor' },
        { code: 'TOTAL_MISMATCH', severity: 'error', message: 'does not add up' },
      ],
      needsReview: true,
    });
    expect(worstSeverity(both)).toBe('error');
  });
});
