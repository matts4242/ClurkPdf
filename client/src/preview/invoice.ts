/**
 * The synthetic invoice the preview build shows instead of a real PDF.
 *
 * One model, read three ways. The page image, the text layer and the OCR
 * answers all come from the same list of positioned runs, so a region drawn
 * over "Invoice number" on the image really does contain that run in the text
 * layer, and running OCR on it really does return that string. Faking the
 * three separately is what makes a mock look plausible in a screenshot and
 * fall apart the moment anyone uses it.
 *
 * Everything here is derived from a seed string (the document id), so a given
 * document looks the same on every render and across reloads.
 */

import type { FieldType, NormalizedRect, TextItem, TextLayerData } from '../types';

/** Page size in points, at the same 3:4-ish ratio as US Letter. */
export const PAGE_WIDTH = 850;
export const PAGE_HEIGHT = 1100;

/** One positioned run of text, in page pixels. */
export interface PreviewItem {
  text: string;
  /** Left edge, or the right edge when `align` is `end`. */
  x: number;
  /** Top of the run's box. */
  y: number;
  fontSize: number;
  bold?: boolean;
  /** `end` right-aligns the run on `x`, which is how the money columns line up. */
  align?: 'end';
  /** Figures are set in a monospace face so the columns read as columns. */
  mono?: boolean;
  dim?: boolean;
  /** Set on the runs the server's field detector would have picked out. */
  field?: FieldType;
}

/** A horizontal rule, in page pixels. */
export interface PreviewRule {
  x: number;
  y: number;
  width: number;
  /** Defaults to 1. */
  weight?: number;
}

export interface PreviewPage {
  width: number;
  height: number;
  items: PreviewItem[];
  rules: PreviewRule[];
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness
// ---------------------------------------------------------------------------

/** FNV-1a. Small, dependency-free, and stable across reloads. */
function hash(input: string): number {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Index into a pool without tripping `noUncheckedIndexedAccess`. */
function pick<T>(pool: readonly T[], index: number): T {
  const item = pool[index % pool.length];
  if (item === undefined) throw new Error('preview: cannot pick from an empty pool');
  return item;
}

// ---------------------------------------------------------------------------
// The invoice itself
// ---------------------------------------------------------------------------

interface Vendor {
  name: string;
  street: string;
  city: string;
  email: string;
}

const VENDORS: readonly Vendor[] = [
  {
    name: 'Northwind Supply Co.',
    street: '1420 Harbour Road, Suite 300',
    city: 'Seattle, WA 98104',
    email: 'accounts@northwind-supply.example',
  },
  {
    name: 'Beacon Paper & Print',
    street: '7 Dockside Way',
    city: 'Bristol BS1 6XN',
    email: 'billing@beaconpaper.example',
  },
  {
    name: 'Halden Logistik GmbH',
    street: 'Hafenstrasse 12',
    city: '20457 Hamburg',
    email: 'rechnung@halden-log.example',
  },
  {
    name: 'Pine & Coral Interiors',
    street: '221 Mission Street',
    city: 'San Francisco, CA 94105',
    email: 'ap@pinecoral.example',
  },
];

interface CatalogueEntry {
  description: string;
  unit: number;
}

const CATALOGUE: readonly CatalogueEntry[] = [
  { description: 'Thermal receipt rolls, 80mm (box of 20)', unit: 18.5 },
  { description: 'Laser toner cartridge, black', unit: 94 },
  { description: 'A4 archive boxes, lidded', unit: 6.4 },
  { description: 'Document scanning, per 1,000 pages', unit: 115 },
  { description: 'Courier delivery, next working day', unit: 42 },
  { description: 'Warehouse handling surcharge', unit: 28 },
  { description: 'Pallet wrap, 500mm heavy duty', unit: 21.75 },
  { description: 'Off-site storage, per box per month', unit: 3.2 },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface InvoiceLine {
  description: string;
  quantity: number;
  unit: number;
  amount: number;
}

export interface InvoiceFacts {
  vendor: Vendor;
  number: string;
  issued: string;
  due: string;
  poNumber: string;
  lines: InvoiceLine[];
  subtotal: number;
  tax: number;
  total: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

const money = (value: number): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatDate(date: Date): string {
  const month = MONTHS[date.getUTCMonth()] ?? 'Jan';
  return `${String(date.getUTCDate()).padStart(2, '0')} ${month} ${date.getUTCFullYear()}`;
}

/** Everything on the invoice, derived from the seed. Totals really add up. */
export function invoiceFacts(seed: string): InvoiceFacts {
  const base = hash(seed);
  const vendor = pick(VENDORS, base);

  const issuedAt = new Date(Date.UTC(2026, 2, 1 + (base % 27)));
  const dueAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000);

  const lineCount = 4 + (hash(`${seed}:lines`) % 3);
  const lines: InvoiceLine[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    const entry = pick(CATALOGUE, base + index * 3);
    const quantity = 1 + (hash(`${seed}:qty:${index}`) % 14);
    lines.push({
      description: entry.description,
      quantity,
      unit: entry.unit,
      amount: round2(quantity * entry.unit),
    });
  }

  const subtotal = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const tax = round2(subtotal * 0.2);

  return {
    vendor,
    number: `INV-2026-${String(1000 + (base % 8999))}`,
    issued: formatDate(issuedAt),
    due: formatDate(dueAt),
    poNumber: `PO-${String(10000 + (hash(`${seed}:po`) % 89999))}`,
    lines,
    subtotal,
    tax,
    total: round2(subtotal + tax),
  };
}

// ---------------------------------------------------------------------------
// Laying it out
// ---------------------------------------------------------------------------

/** Rough advance width. Exact enough for boxes nobody measures with a ruler. */
function glyphWidth(item: PreviewItem): number {
  if (item.mono === true) return item.fontSize * 0.6;
  return item.fontSize * (item.bold === true ? 0.57 : 0.51);
}

/** The run's box in page pixels, resolving right-aligned runs to a left edge. */
export function runBox(item: PreviewItem): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const width = item.text.length * glyphWidth(item);
  return {
    x: item.align === 'end' ? item.x - width : item.x,
    y: item.y,
    width,
    height: item.fontSize * 1.18,
  };
}

/** Page 1: the invoice. Later pages: a remittance slip, so paging shows change. */
export function buildPage(seed: string, pageNumber: number): PreviewPage {
  return pageNumber <= 1 ? buildInvoicePage(seed) : buildRemittancePage(seed, pageNumber);
}

function buildInvoicePage(seed: string): PreviewPage {
  const facts = invoiceFacts(seed);
  const items: PreviewItem[] = [];
  const rules: PreviewRule[] = [];

  // Vendor block.
  items.push(
    { text: facts.vendor.name, x: 56, y: 58, fontSize: 25, bold: true, field: 'VENDOR_NAME' },
    { text: facts.vendor.street, x: 56, y: 96, fontSize: 12, dim: true, field: 'VENDOR_ADDRESS' },
    { text: facts.vendor.city, x: 56, y: 114, fontSize: 12, dim: true },
    { text: facts.vendor.email, x: 56, y: 132, fontSize: 12, dim: true },
  );

  // Invoice metadata, right-aligned against a 794pt margin.
  items.push({ text: 'INVOICE', x: 794, y: 56, fontSize: 30, bold: true, align: 'end' });

  const meta: { label: string; value: string; field: FieldType }[] = [
    { label: 'Invoice number', value: facts.number, field: 'INVOICE_NUMBER' },
    { label: 'Invoice date', value: facts.issued, field: 'INVOICE_DATE' },
    { label: 'Due date', value: facts.due, field: 'DUE_DATE' },
    { label: 'PO number', value: facts.poNumber, field: 'PO_NUMBER' },
  ];
  meta.forEach((row, index) => {
    const y = 108 + index * 22;
    items.push(
      { text: row.label, x: 604, y, fontSize: 11, dim: true, align: 'end' },
      { text: row.value, x: 794, y: y - 1, fontSize: 12, mono: true, align: 'end', field: row.field },
    );
  });

  // Bill-to block.
  items.push(
    { text: 'BILL TO', x: 56, y: 206, fontSize: 10, dim: true },
    { text: 'Clurk Holdings Ltd', x: 56, y: 226, fontSize: 13, bold: true },
    { text: '88 Fenwick Street', x: 56, y: 248, fontSize: 12, dim: true },
    { text: 'Manchester M1 4WB', x: 56, y: 266, fontSize: 12, dim: true },
  );

  // Line-item table.
  const tableTop = 320;
  items.push(
    { text: 'Description', x: 56, y: tableTop, fontSize: 11, dim: true },
    { text: 'Qty', x: 540, y: tableTop, fontSize: 11, dim: true, align: 'end' },
    { text: 'Unit', x: 660, y: tableTop, fontSize: 11, dim: true, align: 'end' },
    { text: 'Amount', x: 794, y: tableTop, fontSize: 11, dim: true, align: 'end' },
  );
  rules.push({ x: 56, y: tableTop + 18, width: 738 });

  facts.lines.forEach((line, index) => {
    const y = tableTop + 36 + index * 28;
    items.push(
      { text: line.description, x: 56, y, fontSize: 12 },
      { text: String(line.quantity), x: 540, y, fontSize: 12, mono: true, align: 'end' },
      { text: money(line.unit), x: 660, y, fontSize: 12, mono: true, align: 'end' },
      { text: money(line.amount), x: 794, y, fontSize: 12, mono: true, align: 'end' },
    );
  });

  const totalsTop = tableTop + 36 + facts.lines.length * 28 + 16;
  rules.push({ x: 440, y: totalsTop - 8, width: 354 });

  const totals: { label: string; value: string; strong: boolean; field?: FieldType }[] = [
    { label: 'Subtotal', value: money(facts.subtotal), strong: false, field: 'SUBTOTAL' },
    { label: 'VAT 20%', value: money(facts.tax), strong: false, field: 'TAX' },
    { label: 'TOTAL DUE', value: `${money(facts.total)} USD`, strong: true, field: 'TOTAL' },
  ];
  totals.forEach((row, index) => {
    const y = totalsTop + 8 + index * 28;
    const fontSize = row.strong ? 15 : 12;
    items.push({
      text: row.label,
      x: 660,
      y,
      fontSize,
      align: 'end',
      bold: row.strong,
      dim: !row.strong,
    });
    items.push({
      text: row.value,
      x: 794,
      y,
      fontSize,
      align: 'end',
      mono: true,
      bold: row.strong,
      ...(row.field === undefined ? {} : { field: row.field }),
    });
  });

  // Notes. Partly to fill the space a short invoice leaves between the totals
  // and the footer, and partly because a block of prose is what a region drawn
  // over body text has to cope with.
  const notesTop = Math.max(totalsTop + 120, 700);
  items.push(
    { text: 'NOTES', x: 56, y: notesTop, fontSize: 10, dim: true },
    {
      text: `Goods despatched from our ${facts.vendor.city} depot. Delivery is included`,
      x: 56,
      y: notesTop + 22,
      fontSize: 11,
    },
    {
      text: 'in the unit price unless a separate carriage line appears above.',
      x: 56,
      y: notesTop + 40,
      fontSize: 11,
    },
    {
      text: `Queries within 14 days to ${facts.vendor.email}, quoting ${facts.number}.`,
      x: 56,
      y: notesTop + 58,
      fontSize: 11,
    },
  );

  // Footer.
  rules.push({ x: 56, y: 1004, width: 738 });
  items.push(
    {
      text: 'Payment due within 30 days of the invoice date.',
      x: 56,
      y: 1020,
      fontSize: 10,
      dim: true,
    },
    {
      text: `Remit to ${facts.vendor.name} · sort 20-45-11 · account 7781 2204 · ref ${facts.number}`,
      x: 56,
      y: 1038,
      fontSize: 10,
      dim: true,
    },
  );

  return { width: PAGE_WIDTH, height: PAGE_HEIGHT, items, rules };
}

function buildRemittancePage(seed: string, pageNumber: number): PreviewPage {
  const facts = invoiceFacts(seed);
  const items: PreviewItem[] = [
    { text: 'REMITTANCE ADVICE', x: 56, y: 64, fontSize: 22, bold: true },
    { text: facts.vendor.name, x: 56, y: 100, fontSize: 13, dim: true },
    { text: `Page ${pageNumber}`, x: 794, y: 66, fontSize: 12, dim: true, align: 'end' },
    { text: 'Detach and return with payment.', x: 56, y: 150, fontSize: 12, dim: true },
    { text: 'Invoice', x: 56, y: 210, fontSize: 11, dim: true },
    { text: facts.number, x: 56, y: 230, fontSize: 14, mono: true },
    { text: 'Amount enclosed', x: 794, y: 210, fontSize: 11, dim: true, align: 'end' },
    { text: `${money(facts.total)} USD`, x: 794, y: 228, fontSize: 16, mono: true, bold: true, align: 'end' },
    { text: 'Payer reference', x: 56, y: 300, fontSize: 11, dim: true },
    { text: '________________________________', x: 56, y: 322, fontSize: 14, mono: true, dim: true },
    { text: 'Signature', x: 56, y: 380, fontSize: 11, dim: true },
    { text: '________________________________', x: 56, y: 402, fontSize: 14, mono: true, dim: true },
  ];

  return {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    items,
    rules: [
      { x: 56, y: 186, width: 738 },
      { x: 56, y: 268, width: 738 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Reading the page: image, text layer, regions
// ---------------------------------------------------------------------------

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, monospace";

/** The page as an SVG document. */
export function renderPageSvg(page: PreviewPage): string {
  const rules = page.rules
    .map(
      (rule) =>
        `<rect x="${rule.x}" y="${rule.y}" width="${rule.width}" height="${rule.weight ?? 1}" fill="#cbd5e1"/>`,
    )
    .join('');

  const text = page.items
    .map((item) => {
      // SVG positions text on its baseline; the model positions it on the box.
      const baseline = item.y + item.fontSize * 0.82;
      const anchor = item.align === 'end' ? ' text-anchor="end"' : '';
      const weight = item.bold === true ? ' font-weight="700"' : '';
      const family = item.mono === true ? MONO : SANS;
      const fill = item.dim === true ? '#64748b' : '#0f172a';
      return (
        `<text x="${item.x}" y="${baseline}" font-family="${family}" font-size="${item.fontSize}"` +
        `${weight}${anchor} fill="${fill}">${escapeXml(item.text)}</text>`
      );
    })
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" ` +
    `viewBox="0 0 ${page.width} ${page.height}">` +
    `<rect width="${page.width}" height="${page.height}" fill="#ffffff"/>` +
    rules +
    text +
    '</svg>'
  );
}

/**
 * Rendered pages, cached by seed and page.
 *
 * The viewer remounts the `<img>` on every page change and every reload of the
 * same page, and re-encoding a whole page each time is visible as a flicker.
 */
const imageCache = new Map<string, string>();

/** The page as a data URL, ready for an `<img src>`. */
export function pageImageDataUrl(seed: string, pageNumber: number): string {
  const key = `${seed}#${pageNumber}`;
  const cached = imageCache.get(key);
  if (cached !== undefined) return cached;

  const svg = renderPageSvg(buildPage(seed, pageNumber));
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  imageCache.set(key, url);
  return url;
}

/** One run, normalised the way the server's text-layer endpoint returns it. */
function toTextItem(item: PreviewItem, page: PreviewPage): TextItem {
  const box = runBox(item);
  return {
    text: item.text,
    x: box.x / page.width,
    y: box.y / page.height,
    width: box.width / page.width,
    height: box.height / page.height,
    fontSize: item.fontSize,
  };
}

/** The page's own text, as `fetchTextLayer` would return it. */
export function pageTextLayer(seed: string, pageNumber: number): TextLayerData {
  const page = buildPage(seed, pageNumber);
  return {
    pageNumber,
    pageWidth: page.width,
    pageHeight: page.height,
    textItems: page.items.map((item) => toTextItem(item, page)),
    hasText: true,
  };
}

/** Normalised box around a run, padded so the glyphs are comfortably inside. */
function regionRect(item: PreviewItem, page: PreviewPage): NormalizedRect {
  const box = runBox(item);
  const pad = 5;
  const x = Math.max(0, (box.x - pad) / page.width);
  const y = Math.max(0, (box.y - pad) / page.height);
  return {
    x,
    y,
    width: Math.min(1 - x, (box.width + pad * 2) / page.width),
    height: Math.min(1 - y, (box.height + pad * 2) / page.height),
  };
}

export interface DetectedField {
  pageNumber: number;
  fieldType: FieldType;
  rect: NormalizedRect;
  text: string;
}

/** What the processing job would have found on its own, for `autoDetected`. */
export function detectedFields(seed: string): DetectedField[] {
  const page = buildPage(seed, 1);
  return page.items
    .filter((item): item is PreviewItem & { field: FieldType } => item.field !== undefined)
    .map((item) => ({
      pageNumber: 1,
      fieldType: item.field,
      rect: regionRect(item, page),
      text: item.text,
    }));
}

/**
 * The text under a rectangle.
 *
 * A run counts as inside when its centre is, which is what a human drawing a
 * loose box around a line expects, and what keeps a box that clips a descender
 * from silently dropping the line.
 */
export function textInRect(seed: string, pageNumber: number, rect: NormalizedRect): string {
  const page = buildPage(seed, pageNumber);

  return page.items
    .map((item) => ({ item, box: runBox(item) }))
    .filter(({ box }) => {
      const centreX = (box.x + box.width / 2) / page.width;
      const centreY = (box.y + box.height / 2) / page.height;
      return (
        centreX >= rect.x &&
        centreX <= rect.x + rect.width &&
        centreY >= rect.y &&
        centreY <= rect.y + rect.height
      );
    })
    .sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x)
    .map(({ item }) => item.text)
    .join(' ')
    .trim();
}

/**
 * A confidence for a piece of recognised text.
 *
 * Deliberately spread across the specification's three bands — above 90,
 * 70-90, below 70 — so the colour coding in the region list is visible in a
 * preview rather than uniformly green.
 */
export function confidenceFor(text: string): number {
  if (text === '') return 0;
  return round2(61 + (hash(text) % 3801) / 100);
}
