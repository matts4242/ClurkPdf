import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildXlsx, columnName } from '../services/xlsxWriter.js';

/**
 * The hand-rolled .xlsx writer, read back with a real ZIP reader.
 *
 * Writing the container by hand is only defensible if something other than the
 * writer says it is valid, so these tests shell out to `unzip`: `-t` verifies
 * every CRC, and `-p` gives the XML back to assert on. A file that Excel would
 * refuse fails here first.
 */

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-test-'));

afterAll(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

let counter = 0;

/** Write the workbook out and return a path to it. */
function write(buffer: Buffer): string {
  const file = path.join(workdir, `book-${(counter += 1)}.xlsx`);
  fs.writeFileSync(file, buffer);
  return file;
}

/** Every CRC checks out, per `unzip -t`. */
function verifyArchive(file: string): string {
  return execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
}

/** One part's bytes, read back out of the archive. */
function part(file: string, name: string): string {
  return execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' });
}

const sheetOf = (file: string): string => part(file, 'xl/worksheets/sheet1.xml');

describe('the archive', () => {
  it('is a valid zip with every part an .xlsx needs', () => {
    const file = write(buildXlsx(['a'], [['x']]));

    expect(verifyArchive(file)).toContain('No errors detected');

    const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]) {
      expect(listing).toContain(required);
    }
  });

  it('survives a workbook big enough to matter', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [
      `invoice-${i}.pdf`,
      `INV-${i}`,
      i * 1.5,
    ]);
    const file = write(buildXlsx(['filename', 'invoice_number', 'total'], rows));

    expect(verifyArchive(file)).toContain('No errors detected');
    expect(sheetOf(file)).toContain('<row r="501">');
  });

  it('round-trips text that would break the container or the XML', () => {
    const file = write(
      buildXlsx(
        ['name'],
        [['a & b'], ['<tag>'], ['"quoted"'], ["it's"], ['Café Rouge'], ['日本語']],
      ),
    );

    expect(verifyArchive(file)).toContain('No errors detected');
    const sheet = sheetOf(file);
    expect(sheet).toContain('a &amp; b');
    expect(sheet).toContain('&lt;tag&gt;');
    expect(sheet).toContain('Café Rouge');
    expect(sheet).toContain('日本語');
  });
});

describe('cells', () => {
  it('writes the header bold and freezes it', () => {
    const sheet = sheetOf(write(buildXlsx(['filename', 'total'], [['a.pdf', 1]])));

    expect(sheet).toContain('<c r="A1" s="1"');
    expect(sheet).toContain('state="frozen"');
  });

  it('writes a number as a number, not as text', () => {
    const sheet = sheetOf(write(buildXlsx(['total'], [[5040.5]])));

    expect(sheet).toContain('<v>5040.5</v>');
    expect(sheet).not.toContain('inlineStr"><is><t xml:space="preserve">5040.5');
  });

  it('writes a date as a spreadsheet serial', () => {
    const sheet = sheetOf(write(buildXlsx(['date'], [[{ date: '2026-03-14' }]])));

    // Days since 1899-12-30, which is what every spreadsheet counts from.
    expect(sheet).toContain('<v>46095</v>');
  });

  it('counts the 1900 leap-year bug the way spreadsheets do', () => {
    // 1900-03-01 is serial 61: the non-existent 1900-02-29 occupies 60.
    const sheet = sheetOf(write(buildXlsx(['date'], [[{ date: '1900-03-01' }]])));
    expect(sheet).toContain('<v>61</v>');
  });

  it('keeps an unparseable date as the text that was captured', () => {
    // Better a visible wrong value than a silently empty cell.
    const sheet = sheetOf(write(buildXlsx(['date'], [[{ date: 'sometime in March' }]])));

    expect(sheet).toContain('sometime in March');
  });

  it('keeps a leading zero on an identifier', () => {
    // The whole reason to offer .xlsx rather than only CSV.
    const sheet = sheetOf(write(buildXlsx(['invoice_number'], [['0042']])));

    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('>0042<');
  });

  it('omits an empty cell rather than writing a blank one', () => {
    const sheet = sheetOf(write(buildXlsx(['a', 'b', 'c'], [['x', null, 'z']])));

    expect(sheet).toContain('r="A2"');
    expect(sheet).not.toContain('r="B2"');
    expect(sheet).toContain('r="C2"');
  });

  it('writes a negative amount', () => {
    expect(sheetOf(write(buildXlsx(['total'], [[-12.34]])))).toContain('<v>-12.34</v>');
  });
});

describe('the sheet', () => {
  it('names itself, within what a sheet name may be', () => {
    const file = write(buildXlsx(['a'], [['x']], { name: 'March/2026: [final]' }));
    const workbook = part(file, 'xl/workbook.xml');

    // `: \ / ? * [ ]` are not allowed in a sheet name.
    expect(workbook).not.toMatch(/name="[^"]*[:\\/?*[\]]/);
    expect(workbook).toContain('sheetId="1"');
  });

  it('sets an autofilter over the whole used range', () => {
    const sheet = sheetOf(write(buildXlsx(['a', 'b'], [['1', '2'], ['3', '4']])));

    expect(sheet).toContain('<autoFilter ref="A1:B3"/>');
  });

  it('handles a sheet with a header and no rows', () => {
    const file = write(buildXlsx(['a', 'b'], []));

    expect(verifyArchive(file)).toContain('No errors detected');
    expect(sheetOf(file)).toContain('<autoFilter ref="A1:B1"/>');
  });
});

describe('columnName', () => {
  it('counts the way spreadsheet columns do', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    // The carry that a naive base-26 conversion gets wrong.
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');
    expect(columnName(51)).toBe('AZ');
    expect(columnName(52)).toBe('BA');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });
});
