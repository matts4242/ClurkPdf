# ClurkPdf — Product Overview

> Read [`00-decisions.md`](00-decisions.md) first. Where this document and the
> decisions document disagree, the decisions document wins.
>
> Scope marked **[deferred]** is documented in
> [`99-appendix-future.md`](99-appendix-future.md) and is not part of v1.

---

## Core concept

A browser-based tool for digitizing paper and PDF invoices through a dual-mode
extraction interface. It combines direct text-layer extraction with region-based OCR
to produce a hybrid, human-in-the-loop pipeline: the machine proposes, a person
confirms, and the corrections feed templates that reduce the work next time.

The bet is not that extraction is fully automatable. It is that a bookkeeper
confirming pre-filled fields is several times faster than one retyping them, and that
templates make the second invoice from a vendor much cheaper than the first.

## Users

- **Primary** — bookkeepers processing 50–200 invoices weekly
- **Secondary** — small business owners doing their own accounting
- **Tertiary** — AP clerks at mid-size companies

The primary persona drives the design. Volume is the problem; a tool that handles one
invoice beautifully and 80 tediously has failed them.

---

## Features

### 1. Document ingestion

- **Batch upload** — drag-and-drop or file picker, up to 50 PDFs, 25 MB per file,
  100 MB per batch (**D2**)
- **Formats** — PDF primary; JPEG, PNG, TIFF secondary
- **Validation** — magic-byte content check, not declared MIME type (**D15**)
- **Thumbnails** — 150px-wide preview per document, lazily loaded in the grid (**D6**)
- **[deferred]** auto-classification (invoice / receipt / other), hash-based
  duplicate detection

### 2. Dual-mode extraction

Two modes, and the order they are attempted matters.

**Mode A — text-layer highlighting** *(the common path, Week 3)*

Most invoices arriving as PDFs are digitally generated and carry an embedded text
layer. For those the exact characters and their positions are already in the file.

- Selectable text overlay rendered over the page image
- Highlight a span, tag it with an attribute
- Snapping to word and line boundaries
- Number-key shortcuts for quick tagging
- No OCR cost, no confidence score to review, no accuracy ceiling

**Mode B — region OCR** *(the fallback for scans, Week 4)*

For scanned or photographed invoices with no text layer:

- Click-and-drag rectangular regions over text areas
- Each region carries a semantic field type
- Tesseract.js crops and reads the region
- Confidence scoring, colour-coded: green >90%, amber 70–90%, red <70%
- Side-by-side correction panel with inline editing

**Mode selection is automatic.** A per-page classifier decides which applies, based
on extracted character count and glyph coverage; the user can override. The original
spec presented both modes as equal peers and left the choice entirely to the user,
which meant a user could burn OCR on a document whose text was already machine-readable
and get a worse result for it.

**Field types** (**D8** — one lowercase snake_case value everywhere):

| Group | Fields |
|---|---|
| Vendor | `vendor_name`, `vendor_address` |
| Invoice | `invoice_number`, `invoice_date`, `due_date`, `po_number` |
| Financial | `subtotal`, `tax`, `total` |
| Other | `line_items`, `custom` |

### 3. Batch workflow

- **Queue** — visual pipeline: Uploaded → Processing → Review → Exported
- **Bulk actions** — apply a template's regions or attribute map across similar
  documents
- **Templates** — save an extraction pattern per recurring vendor
- **Progress persistence** — every extraction writes through to Postgres immediately
  (**D4**), so there is no 30-second autosave window to lose work in

### 4. Validation and output

- **Field validation** — format rules for dates, currency amounts, identifiers
- **Cross-field logic** — line item sum equals subtotal; subtotal + tax equals total
- **Export** — JSON (per document and aggregated), CSV, XLSX
- **Audit trail** — timestamped record of every extraction and correction
- **[deferred]** QuickBooks / Xero OAuth, XML for ERP

---

## Architecture

Decisions **D1**, **D3**, **D5**, **D10**, **D11** fix these; the reasoning lives there.

**Frontend**
- React 18 + TypeScript, Vite
- Tailwind CSS
- `pdfjs-dist` for the text layer
- Raw HTML5 Canvas for region drawing — no Fabric.js, no Konva.js (**D11**)
- Local hooks through Week 4; Zustand from Week 5 (**D10**)

**Backend**
- Node 20 + Express + TypeScript (**D1**)
- PostgreSQL 14+ via Prisma, from Week 1 (**D4**)
- Local disk behind a `StorageAdapter` interface (**D3**)
- Redis + BullMQ for job queues, from Week 5
- WebSocket progress, from Week 5

**PDF processing** (**D5**)

| Need | Package |
|---|---|
| Rasterize page → PNG | `pdfjs-dist` + `@napi-rs/canvas` |
| Page count, metadata | `pdf-lib` |
| Text layer with positions | `pdfjs-dist` `getTextContent()` |
| OCR | `tesseract.js` |

All pure npm. No poppler, no ImageMagick, no system prerequisites.

**On-disk layout** (**D6**)

```
uploads/{documentId}/
  original.pdf        # never statically served (D14)
  thumb.png           # 150px wide, page 1
  pages/{n}.png       # 150 DPI, generated lazily, cached
```

**[deferred]** Docker deployment, horizontal worker scaling, CDN. Local disk means
one server; scaling is blocked on object storage.

---

## Interface layout

```
┌─────────────────────────────────────────────────────────┐
│  HEADER: Logo | Batch Progress | User Menu | Export      │
├──────────┬──────────────────────────────────────────────┤
│          │                                              │
│  THUMB-  │         DOCUMENT VIEWER                      │
│  NAIL    │         (PDF Canvas + Text Layer)            │
│  PANEL   │                                              │
│          │         [Toolbar: Zoom | Pan | Draw | Text]  │
│          │                                              │
│          ├──────────────────────────────────────────────┤
│          │         EXTRACTION PANEL                     │
│          │         [Tabs: Regions | Attributes | Data]  │
│          │                                              │
└──────────┴──────────────────────────────────────────────┘
```

**Flow**

1. Upload batch → thumbnail grid
2. Open first document → classifier picks text-layer or OCR mode
3. Extract — highlight spans, or draw regions
4. Review and correct in the data panel
5. Mark complete → advance to next
6. Export when the batch is done

**Key interactions**
- **Highlight** — triple-click selects a line → floating toolbar assigns a field →
  value appears in the data panel
- **Draw** — drag a box → pick a field type → OCR runs on release
- **Template** — "Apply to similar documents" matches on vendor text from the top
  third of page 1

---

## Data model

Table names are snake_case in SQL, PascalCase as Prisma models (**D8**).

**`documents`**
`id`, `filename`, `originalName`, `mimeType`, `size`, `pageCount`, `uploadPath`,
`status`, `userId?`, `createdAt`, `updatedAt`

**`extraction_regions`**
`id`, `documentId`, `pageNumber`, `x`, `y`, `width`, `height`, `fieldType`,
`fieldLabel?`, `rawText?`, `confidence?`, `correctedText?`, `source`, `version`,
`createdAt`, `updatedAt`

**`document_templates`**
`id`, `name`, `vendorIdentifier`, `regionMappings` (JSONB), `userId?`, `createdAt`

Notes:
- Coordinates are normalized 0–1 floats at 6 dp (**D9**)
- `version` supports `If-Match` optimistic concurrency (**D13**)
- `source` distinguishes `text_layer`, `ocr` and `manual` extractions
- `userId` is nullable and unused in v1, reserved so auth is not a backfill (**D12**)

---

## Build sequence

Vertical slices, not horizontal layers. Each week ends with something that runs
end-to-end, which keeps architectural mistakes cheap — you find them in week 2 rather
than in integration week.

| Week | Deliverable | Depends on |
|---|---|---|
| [1](week-1-upload-viewer.md) | Upload, storage, database, page viewer | — |
| [2](week-2-regions.md) | Canvas region drawing, persistence | 1 |
| [3](week-3-text-layer.md) | Text layer + attribute tagging | 1, 2 |
| [4](week-4-ocr.md) | Page classifier + OCR fallback | 2, 3 |
| [5](week-5-batch-queue.md) | Job queue, batch grid, progress | 1–4 |
| [6](week-6-templates.md) | Template save, match, apply | 5 |
| [7](week-7-export.md) | Validation and export | all |

**Weeks 3 and 4 are deliberately in this order.** The original plan built OCR first
and text extraction second, described as "parallel". Text layer first means the
common case — a digital PDF — is handled exactly and for free, and OCR arrives as a
scoped fallback for the pages that actually need it, with a classifier to route
between them. Built the other way round, OCR is the default path and gets used on
documents that never needed it.

---

## Success metrics

- **Throughput** — 50 invoices in under 15 minutes; under 5 with templates matching
- **Text-layer accuracy** — 100% on digital PDFs, by construction. This is the metric
  the Week 3-first ordering is meant to move.
- **OCR accuracy** — target >95% on printed text, measured against the fixture set
  introduced in Week 4. Until fixtures with ground truth exist this number is a
  target, not a claim.
- **Handwriting** — **[deferred]**. Tesseract does not reach the originally stated
  85%; that needs a cloud vision model.
- **Retention** — 70% of users return within 7 days

---

## Open questions

Unresolved, and worth settling before the week they bite:

1. **Line items** are a table, not a field. Both extraction modes currently produce a
   single blob of text for `line_items`. Turning that into rows needs either table
   structure detection or a manual column-mapping UI. Week 7 has to export
   *something* — decide by Week 4.
2. **Multi-page invoices** — templates assume field positions are stable. Does a
   template apply per page or per document? Decide by Week 6.
3. **Currency** — the field list has `total` and `tax` but no currency. Multi-currency
   vendors will need it, and adding it after export exists means changing the export
   schema.
