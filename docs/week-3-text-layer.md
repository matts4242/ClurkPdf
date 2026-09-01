# Week 3 — Text Layer & Attribute Tagging

> Governed by [`00-decisions.md`](00-decisions.md).

**Goal:** select real text from the PDF and tag it with field types — no OCR.

**Phase 3 of 7.** This was Week 4 in the original plan, scheduled after OCR. It is now
first, because most invoices arriving as PDFs are digitally generated and already
contain their text with exact positions. Extracting it costs nothing, cannot
misrecognize a character, and needs no confidence review. OCR (Week 4) becomes the
fallback for pages that genuinely lack a text layer.

**Applies:** D5, D8, D9, D13

---

## Structure

```
client/src/
  components/
    TextLayer.tsx             # NEW: positioned selectable spans
    AttributeToolbar.tsx      # NEW: floating field picker on selection
    ExtractionPanel.tsx       # NEW: tabbed data view
  hooks/
    useTextLayer.ts           # NEW: fetch + cache text items
    useTextSelection.ts       # NEW: selection → span range → bounds
server/src/
  services/textLayerService.ts    # NEW
  controllers/textLayerController.ts
server/prisma/schema.prisma       # UPDATE: extraction columns
```

---

## Interface contracts

### Text item

```typescript
interface TextItem {
  id: string;          // stable within a page render: `${pageNumber}:${index}`
  text: string;
  x: number;           // normalized 0-1, left   (D9)
  y: number;           // normalized 0-1, top
  width: number;
  height: number;
  fontSize: number;    // normalized to page height
  lineIndex: number;   // items sharing a baseline share this
}

interface TextLayerResponse {
  pageNumber: number;
  hasTextLayer: boolean;   // false → this page needs Week 4's OCR
  itemCount: number;
  items: TextItem[];
}
```

Coordinates are top-left origin, normalized, matching Week 2 exactly (**D9**). PDF's
native coordinate space is bottom-left origin in points; the conversion happens once,
server-side, so no client code ever handles two conventions.

`lineIndex` is assigned server-side by grouping items whose vertical centres fall
within half a line height. Doing it here rather than in the browser means Week 4 and
Week 6 get the same grouping for free.

### Extraction

```typescript
type ExtractionSource = 'text_layer' | 'ocr' | 'manual';

interface Extraction {
  id: string;
  documentId: string;
  pageNumber: number;
  fieldType: FieldType;         // reused from Week 2 (D8)
  fieldLabel: string | null;
  rawText: string | null;       // as extracted
  correctedText: string | null; // after user edit; null if untouched
  confidence: number | null;    // null for text_layer — it is exact
  source: ExtractionSource;
  x: number; y: number; width: number; height: number;   // bounding box, normalized
  version: number;              // D13
  createdAt: string;
  updatedAt: string;
}
```

`confidence` is deliberately `null`, not `1.0`, for text-layer extractions. There is
no measurement, and a fabricated 100% would sort alongside a genuinely measured OCR
score in the review queue.

The effective value of any extraction is `correctedText ?? rawText`. One rule, used by
the panel, validation and export.

### Endpoints

```
GET  /api/documents/:id/text-layer/:pageNumber   → TextLayerResponse
GET  /api/documents/:id/extractions              → { extractions, total }
GET  /api/documents/:id/extractions?page=2       → filtered
POST /api/documents/:id/extractions              → { extraction }
PUT  /api/documents/:id/extractions/:eid         → { extraction }   If-Match
DELETE /api/documents/:id/extractions/:eid       → 204              If-Match
```

```typescript
interface CreateExtractionRequest {
  pageNumber: number;
  fieldType: FieldType;
  fieldLabel?: string;
  rawText: string;
  source: ExtractionSource;
  x: number; y: number; width: number; height: number;
}

interface UpdateExtractionRequest {
  correctedText?: string;
  fieldType?: FieldType;
  fieldLabel?: string;
}
```

Geometry is immutable after creation. Moving an extraction's box would not change the
text it captured, so the two would silently disagree. To re-target, delete and
re-extract.

### Component props

```typescript
interface TextLayerProps {
  documentId: string;
  pageNumber: number;
  renderWidth: number;
  renderHeight: number;
  enabled: boolean;                 // false while in region-draw mode
  onSelection: (sel: TextSelection | null) => void;
}

interface TextSelection {
  text: string;
  itemIds: string[];
  bounds: { x: number; y: number; width: number; height: number };  // normalized
}

interface AttributeToolbarProps {
  selection: TextSelection;
  anchor: { x: number; y: number };   // viewport px
  onAssign: (fieldType: FieldType, label?: string) => void;
  onDismiss: () => void;
}
```

---

## Database

```prisma
model Extraction {
  id            String    @id @default(uuid())
  documentId    String
  pageNumber    Int
  fieldType     FieldType
  fieldLabel    String?
  rawText       String?
  correctedText String?
  confidence    Float?
  source        ExtractionSource
  x     Float
  y     Float
  width Float
  height Float
  version   Int      @default(1)
  userId    String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@map("extractions")
  @@index([documentId, pageNumber])
  @@index([documentId, fieldType])
}

enum ExtractionSource {
  TEXT_LAYER @map("text_layer")
  OCR        @map("ocr")
  MANUAL     @map("manual")
}
```

`@map` on every member, per **D8**.

**Why a new table rather than columns on `extraction_regions`:** Week 2's regions are
*instructions* — "read here" — and a template (Week 6) copies them onto a new
document. Extractions are *results*, bound to one document's actual content. Week 2's
note anticipated adding text columns to the region table; separating them keeps a
template from carrying another invoice's values along with its geometry.

`Region.extractionId String?` links an OCR result (Week 4) back to the region that
produced it. Text-layer extractions have no region.

---

## Backend

### Text layer service (**D5**)

```typescript
async function getTextLayer(documentId: string, pageNumber: number): Promise<TextLayerResponse>
async function classifyPage(documentId: string, pageNumber: number): Promise<PageClass>
```

Using `pdfjs-dist` `getTextContent()`:

1. Load the document from storage (**D3**) and get the page.
2. Read `viewport` dimensions at scale 1 — the normalization basis.
3. For each item, convert its transform matrix to a top-left-origin normalized box.
4. Drop whitespace-only items.
5. Group into lines by baseline proximity, assign `lineIndex`.
6. Sort by `lineIndex`, then by `x` — reading order, not PDF draw order, which is
   arbitrary and frequently not left-to-right.

Results are cached in-process keyed by `documentId:pageNumber`; a page's text never
changes. Cache is bounded by an LRU so a large batch cannot exhaust memory.

**Rotation:** pages carry a `/Rotate` attribute. Normalize against the *rotated*
viewport so text boxes align with the rendered image from Week 1, which also uses the
rotated viewport. Getting this wrong shows up as text boxes transposed on landscape
pages only — worth an explicit test.

### Page classification

Shared with Week 4, defined here because this week needs it first:

```typescript
type PageClass = 'digital' | 'scanned' | 'mixed';
```

| Signal | Meaning |
|---|---|
| Extracted characters < 50 | Almost certainly a scan |
| Text bounding boxes cover < 5% of page area | Scan with a small caption or stamp |
| Otherwise | Digital |

`mixed` is a digital page containing a large embedded raster — a scanned receipt
pasted into a generated PDF. It offers both modes and lets the user pick.

The thresholds are starting values, to be tuned against the Week 4 fixture set. They
are in `config/classifier.ts`, not scattered as literals.

### Extraction service

Validation reuses Week 2's rules (**D9**): range, containment, minimum size, page
bounds, and a required label for `custom`. `rawText` must be non-empty after
trimming — an extraction with no text is not a record of anything.

Concurrency is `version` + `If-Match` exactly as Week 2 (**D13**), including the
conditional `updateMany` so the check and write stay atomic.

---

## Frontend

### `TextLayer`

Absolutely positioned transparent spans over the page image, one per `TextItem`,
inside a `position: relative` container matching the rendered page exactly.

- `color: transparent`, so browser-native selection highlighting shows through
- `font-size` scaled from `fontSize × renderHeight`, letter-spacing adjusted so the
  invisible text's width approximates the box — selection feels wrong when the hit
  areas drift from the glyphs underneath
- `user-select: text` on spans, `none` on the container
- `pointer-events: none` when `enabled` is false, so region drawing (Week 2) and text
  selection never compete for the same drag

The two modes are mutually exclusive by mode toggle, not by z-order. A pointer-down
belongs to exactly one of them.

### `useTextSelection`

Wraps the native Selection API:

1. On `selectionchange` (debounced ~150ms), read the range.
2. Map the range's start and end containers back to `TextItem` ids via a `data-item-id`
   attribute.
3. Union their boxes into `bounds`.
4. Reconstruct `text` from the items in reading order — not `selection.toString()`,
   which returns DOM order and inserts stray whitespace between absolutely positioned
   spans.

**Snapping:**
- Double-click — the whole word (native behaviour, preserved)
- Triple-click — the whole `lineIndex`, extended across span boundaries. Native
  triple-click stops at one span, which is usually a fragment of the visual line.
- Shift-click — extend from the current anchor

### `AttributeToolbar`

Floating panel anchored above the selection, flipping below when near the top edge.
Same grouped field list and colours as Week 2's selector, and the same number-key
shortcuts — 1–9 assign directly without opening the menu, which is what makes tagging
a whole invoice fast.

Dismiss on Escape, on click-away, or when the selection clears.

### `ExtractionPanel`

Tabs: **Regions** (Week 2) | **Attributes** (this week) | **Data** (merged view).

The Data tab is the review surface: one row per field type, the effective value,
source badge, confidence where measured, and inline editing that writes
`correctedText`. Fields with no extraction show as empty rows, so a missing
`invoice_number` is visible rather than absent.

Hovering a row highlights its box on the page; clicking scrolls it into view.

### Mode routing

On opening a document, `GET /text-layer/1` reports `hasTextLayer`:

- `digital` → attribute mode, with a note that text is exact
- `scanned` → region mode, with "This page has no text layer — regions will be read by
  OCR" (Week 4; until then, region + manual entry)
- `mixed` → attribute mode, with region mode one click away

The user can always override. The default should simply be right most of the time.

---

## Errors

| Code | Status | When |
|---|---|---|
| `TEXT_LAYER_UNAVAILABLE` | 422 | Page has no extractable text (`hasTextLayer: false`) |
| `EMPTY_EXTRACTION` | 400 | `rawText` empty after trim |
| `INVALID_COORDINATES` | 400 | Week 2 rules (**D9**) |
| `INVALID_PAGE` | 400 | Outside 1..pageCount |
| `EXTRACTION_NOT_FOUND` | 404 | Not on this document |
| `PRECONDITION_REQUIRED` | 428 | `If-Match` absent |
| `EXTRACTION_MODIFIED` | 409 | Version mismatch |

`TEXT_LAYER_UNAVAILABLE` is a 422, not a 404 — the page exists; it just has no text.
The client uses this to route to region mode rather than showing an error.

---

## Acceptance criteria

Extraction:
1. [ ] `GET /text-layer/1` on a digital PDF returns items with sane text
2. [ ] Items are sorted in reading order, not PDF draw order
3. [ ] `lineIndex` groups items on the same visual line
4. [ ] Coordinates are normalized 0–1, top-left origin
5. [ ] A landscape page returns correctly oriented boxes
6. [ ] A rotated page (`/Rotate 90`) aligns with the rendered image
7. [ ] A scanned PDF returns `hasTextLayer: false` with an empty array

Classification:
8. [ ] A digital invoice classifies `digital`
9. [ ] A scanned invoice classifies `scanned`
10. [ ] Opening a digital document defaults to attribute mode
11. [ ] Opening a scanned document defaults to region mode with an explanation
12. [ ] The user can override in both directions

Selection:
13. [ ] Dragging across text selects it with visible highlighting
14. [ ] Double-click selects a word
15. [ ] Triple-click selects the full visual line across span boundaries
16. [ ] Selected text matches what is visually on the page, without stray whitespace
17. [ ] Selection works at every zoom level 50–400%
18. [ ] Selection is disabled in region-draw mode, and drawing is disabled in
        attribute mode

Tagging:
19. [ ] Selecting text shows the toolbar near the selection
20. [ ] The toolbar flips below the selection near the top edge
21. [ ] Assigning a field saves an extraction with `source: 'text_layer'`
22. [ ] Number keys assign without opening the menu
23. [ ] Escape dismisses without saving
24. [ ] `confidence` is `null`, not 1.0, for text-layer extractions

Review:
25. [ ] The Data tab lists every field type, empty ones included
26. [ ] Inline editing writes `correctedText` and leaves `rawText` intact
27. [ ] The displayed value is `correctedText ?? rawText`
28. [ ] Hovering a row highlights its box on the page
29. [ ] Multi-page: extractions are scoped to their page and all appear in Data

Persistence:
30. [ ] Refresh restores every extraction with correct text and position
31. [ ] `DELETE /api/documents/:id` cascades to extractions
32. [ ] `PUT` without `If-Match` → 428; stale version → 409

---

## Notes for Week 4

- `classifyPage` is already built; Week 4 uses it to decide which pages need OCR
- OCR writes to the same `extractions` table with `source: 'ocr'` and a real
  `confidence`
- The Data tab already renders confidence; Week 4 adds the colour coding
- `Region.extractionId` links an OCR result back to its region
- The fixture set Week 4 introduces should be used to tune the classifier thresholds
