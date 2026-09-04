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
