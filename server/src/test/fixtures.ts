/**
 * Test fixtures.
 *
 * `buildPdf` assembles a valid multi-page PDF byte-for-byte so the suite needs
 * no binary files in the repository and no PDF-writing dependency.
 */

export function buildPdf(pageTexts: string[] = ['Hello invoice']): Buffer {
  const pageCount = Math.max(1, pageTexts.length);
  const texts = pageTexts.length > 0 ? pageTexts : ['Hello invoice'];

  // Object numbering: 1 catalog, 2 pages, 3 font, then a page and a content
  // stream object for each page.
  const firstPageObj = 4;
  const kids = Array.from({ length: pageCount }, (_, i) => `${firstPageObj + i * 2} 0 R`).join(' ');

  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  for (let i = 0; i < pageCount; i++) {
    const pageObj = firstPageObj + i * 2;
    const contentObj = pageObj + 1;
    const escaped = (texts[i] ?? '').replace(/([()\\])/g, '\\$1');
    const stream = `BT /F1 24 Tf 72 700 Td (${escaped}) Tj ET`;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  const total = objects.length - 1;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i <= total; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const startxref = out.length;
  out += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}

/** Bytes that claim to be a PDF but will not parse. */
export const invalidPdfBytes = Buffer.from('%PDF-1.4\nnot actually a pdf\n', 'latin1');

/** One text run on a page: position in PDF points, size, and the text itself. */
export type TextRun = [x: number, y: number, size: number, text: string];

/**
 * A single-page invoice with well-separated fields.
 *
 * The OCR tests assert on the exact strings placed here, so recognition is
 * measured against known input rather than a stub. Positions are in PDF user
 * space, where y counts up from the bottom of a 612x792 page.
 */
export function buildInvoicePdf(): Buffer {
  return buildPositionedPdf([
    [72, 720, 22, 'ACME Supply Co'],
    [72, 690, 12, '119 Harbour Road, Bristol'],
    [400, 720, 14, 'INVOICE'],
    [400, 695, 12, 'Invoice No: INV-2026-0042'],
    [400, 675, 12, 'Date: 14 March 2026'],
    [400, 655, 12, 'PO Number: PO-88123'],
    [72, 560, 12, 'Consulting services'],
    [72, 540, 12, 'Hardware rental'],
    [400, 480, 12, 'Subtotal: 4200.00'],
    [400, 460, 12, 'Tax: 840.00'],
    [400, 435, 14, 'Total: 5040.00'],
  ]);
}

/**
 * An invoice laid out in two columns, with the label and its value written as
 * separate runs.
 *
 * The common real-world shape, and the one that distinguishes a detector that
 * reads whole lines from one that only handles "Label: value" in a single run.
 */
export function buildColumnarInvoicePdf(): Buffer {
  return buildPositionedPdf([
    [72, 730, 20, 'Northwind Traders Ltd'],
    [72, 706, 10, 'VAT GB 123 4567 89'],
    [380, 730, 16, 'TAX INVOICE'],

    [380, 700, 11, 'Invoice Number'],
    [480, 700, 11, 'NW-99120'],
    [380, 682, 11, 'Invoice Date'],
    [480, 682, 11, '2026-03-14'],
    [380, 664, 11, 'Due Date'],
    [480, 664, 11, '2026-04-13'],

    [380, 500, 11, 'Subtotal'],
    [490, 500, 11, '1,250.00'],
    [380, 482, 11, 'VAT (20%)'],
    [490, 482, 11, '250.00'],
    [380, 460, 13, 'Amount Due'],
    [490, 460, 13, '1,500.00'],
  ]);
}

/** A page of text with no invoice fields on it at all. */
export function buildProsePdf(): Buffer {
  return buildPositionedPdf([
    [72, 700, 12, 'Thank you for your custom this year.'],
    [72, 680, 12, 'We look forward to working with you again.'],
  ]);
}

/** Build a one-page PDF from explicitly positioned runs. */
export function buildPositionedPdf(runs: TextRun[]): Buffer {
  const stream = runs
    .map(
      ([x, y, size, text]) =>
        `BT /F1 ${size} Tf ${x} ${y} Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`,
    )
    .join('\n');

  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  const total = objects.length - 1;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i <= total; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const startxref = out.length;
  out += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}
