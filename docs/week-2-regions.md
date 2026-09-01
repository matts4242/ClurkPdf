# Week 2 — Canvas Region Drawing

> Governed by [`00-decisions.md`](00-decisions.md). Decisions are referenced by ID
> and not restated here.

**Goal:** draw rectangular regions on a page, tag each with a field type, persist
them, and have them reload in the right place at any zoom level.

**Phase 2 of 7.** Building on Week 1's upload, storage, database and viewer. No text
is extracted yet — this week defines *where* to extract from.

**Applies:** D4, D8, D9, D11, D12, D13

---

## What changed from the original Week 2

1. **No "Week 1 → Week 2 migration guide."** Postgres arrived in Week 1 (**D4**);
   this week adds one table.
2. **Enum values are lowercase snake_case in both TypeScript and SQL** (**D8**). The
   original had `'vendor_name'` on the wire and `VENDOR_NAME` in the database — every
   round trip would have corrupted the value.
3. **One minimum region size, in normalized units** (**D9**). The original gave a
   client rule of "20×20 px on screen" and no longer applies it; the server rule of
   0.01 × 0.01 normalized is now the only one. Those two disagree at every zoom
   level but one.
4. **`version` + `If-Match`** (**D13**), so the specified 409 can actually fire.
5. **Bounds validation is containment**, not just range (**D9**).
6. **One route for page filtering**, not two (see below).

---

## Structure

```
client/src/
  components/
    DocumentViewer.tsx        # UPDATE: toolbar, page nav, canvas overlay
    RegionCanvas.tsx          # NEW
    RegionList.tsx            # NEW
    FieldTypeSelector.tsx     # NEW
  hooks/
    useRegions.ts             # NEW: CRUD + optimistic updates
    useCanvasDrawing.ts       # NEW: pointer → rectangle
  utils/
    canvas.ts                 # NEW: coordinate conversion + validation (D9)
server/src/
  controllers/regionController.ts   # NEW
  services/regionService.ts         # NEW
  routes/documents.ts               # UPDATE
server/prisma/schema.prisma         # UPDATE: Region model
```

---

## Interface contracts

### Field types (**D8**)

One value, lowercase snake_case, on the wire and in the database:

```typescript
const FIELD_TYPES = [
  'vendor_name', 'vendor_address',
  'invoice_number', 'invoice_date', 'due_date', 'po_number',
  'subtotal', 'tax', 'total',
  'line_items', 'custom',
] as const;

type FieldType = typeof FIELD_TYPES[number];
```

A `const` array rather than a TypeScript `enum`: it gives the union type, a runtime
list to build the selector and validators from, and no dual-representation problem.
The original's `enum` with lowercase values looked equivalent but silently disagreed
with the Prisma enum it was paired with.

### Region

```typescript
interface Region {
  id: string;
  documentId: string;
  pageNumber: number;          // 1-indexed
  x: number;                   // normalized 0-1, left    (D9)
  y: number;                   // normalized 0-1, top
  width: number;               // normalized 0-1
  height: number;              // normalized 0-1
  fieldType: FieldType;
  fieldLabel: string | null;   // required when fieldType === 'custom'
  version: number;             // D13 — optimistic concurrency
  createdAt: string;
  updatedAt: string;
}
```

### Canvas-space region

Pixel coordinates, client-only, never persisted:

```typescript
interface CanvasRegion {
  id: string;
  x: number; y: number; width: number; height: number;   // pixels
  fieldType: FieldType;
  isSelected: boolean;
  isPending: boolean;          // optimistic, not yet confirmed by the server
}
```

### Endpoints

```
GET    /api/documents/:id/regions            → { regions, total }
GET    /api/documents/:id/regions?page=2     → same, filtered
POST   /api/documents/:id/regions            → { region }
PUT    /api/documents/:id/regions/:regionId  → { region }     requires If-Match
DELETE /api/documents/:id/regions/:regionId  → 204            requires If-Match
```

The original also had `GET /api/documents/:id/regions/page/:pageNumber`, duplicating
the query-parameter form. One way: `?page=`.

```typescript
interface CreateRegionRequest {
  pageNumber: number;
  x: number; y: number; width: number; height: number;
  fieldType: FieldType;
  fieldLabel?: string;
}

interface UpdateRegionRequest {
  x?: number; y?: number; width?: number; height?: number;
  fieldType?: FieldType;
  fieldLabel?: string;
}
```

`PUT` and `DELETE` require `If-Match: <version>` (**D13**). A mismatch returns 409
with the current server state in `error.details` so the client can reconcile without
a second round trip. A missing header returns 428.

### Component props

```typescript
interface RegionCanvasProps {
  documentId: string;
  pageNumber: number;
  renderWidth: number;         // displayed page width in CSS px
  renderHeight: number;
  regions: Region[];
  mode: 'draw' | 'select' | 'pan';
  selectedRegionId: string | null;
  scale: number;               // 0.5 - 4.0
  onRegionCreate: (draft: Omit<Region, 'id'|'version'|'createdAt'|'updatedAt'>) => void;
  onRegionUpdate: (id: string, updates: Partial<Region>) => void;
  onRegionDelete: (id: string) => void;
  onRegionSelect: (id: string | null) => void;
}

interface RegionListProps {
  regions: Region[];
  selectedRegionId: string | null;
  onRegionSelect: (id: string) => void;
  onRegionDelete: (id: string) => void;
  onRegionUpdate: (id: string, updates: Partial<Region>) => void;
}

interface FieldTypeSelectorProps {
  value: FieldType | null;
  onChange: (fieldType: FieldType, label?: string) => void;
  onCancel: () => void;
  allowCustom?: boolean;
}
```

`onRegionCreate` takes a draft without server-assigned fields — the original's
signature required the caller to invent an `id` and timestamps before the server had
issued them.

---

## Database (**D8**, **D9**, **D13**)

```prisma
model Region {
  id          String    @id @default(uuid())
  documentId  String
  pageNumber  Int
  x           Float
  y           Float
  width       Float
  height      Float
  fieldType   FieldType
  fieldLabel  String?
  version     Int       @default(1)          // D13
  userId      String?                        // D12 — reserved
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  document    Document  @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@map("extraction_regions")
  @@index([documentId, pageNumber])
  @@index([fieldType])
}

enum FieldType {
  VENDOR_NAME     @map("vendor_name")
  VENDOR_ADDRESS  @map("vendor_address")
  INVOICE_NUMBER  @map("invoice_number")
  INVOICE_DATE    @map("invoice_date")
  DUE_DATE        @map("due_date")
  PO_NUMBER       @map("po_number")
  SUBTOTAL        @map("subtotal")
  TAX             @map("tax")
  TOTAL           @map("total")
  LINE_ITEMS      @map("line_items")
  CUSTOM          @map("custom")
}
```

`@map` on every member is what makes **D8** true: Prisma model members stay
PascalCase in TypeScript, the stored values are lowercase snake_case, and the API
never translates between two spellings.

The composite index `[documentId, pageNumber]` replaces the original's two separate
indexes. Every read filters by document and usually by page; a standalone
`pageNumber` index is never used on its own.

Add `regions Region[]` to `Document`.

---

## Backend

### Validation (**D9**)

Every create and update runs, in order:

```typescript
// 1. Range
0 <= x && 0 <= y && width > 0 && height > 0

// 2. Containment — stricter than the original "between 0 and 1"
x + width <= 1 && y + height <= 1

// 3. Minimum size, normalized. No pixel rule anywhere.
width >= 0.01 && height >= 0.01

// 4. Page exists
1 <= pageNumber && pageNumber <= document.pageCount

// 5. Custom label
fieldType !== 'custom' || (fieldLabel && fieldLabel.trim().length > 0)
```

Check 2 matters: the original permitted `x: 0.9, width: 0.5`, a region extending half
a page past the right edge. Both endpoints, and partial updates re-validate the
*merged* region, not just the changed fields — moving `x` can push a valid width out
of bounds.

Coordinates are rounded to 6 dp on write (**D9**).

### Region service

```typescript
async function createRegion(documentId: string, data: CreateRegionRequest): Promise<Region>
async function listRegions(documentId: string, pageNumber?: number): Promise<Region[]>
async function updateRegion(documentId: string, regionId: string,
                            expectedVersion: number,
                            updates: UpdateRegionRequest): Promise<Region>
async function deleteRegion(documentId: string, regionId: string,
                            expectedVersion: number): Promise<void>
```

`documentId` is a required parameter on every single-region operation. This is not an
"ownership check stub" as the original called it — there are no users in v1 (**D12**).
It verifies the region actually belongs to the document in the URL, which prevents
`/documents/A/regions/{a-region-of-B}` from mutating B's data. That is a real
authorization check and worth naming correctly.

`updateRegion` uses a conditional write so the version check and the update are one
atomic statement:

```typescript
const { count } = await prisma.region.updateMany({
  where: { id: regionId, documentId, version: expectedVersion },
  data: { ...updates, version: { increment: 1 } },
});
if (count === 0) { /* distinguish 404 from 409 by re-reading */ }
```

A read-then-write would leave a window in which two clients both read version 3 and
both write version 4.

### Errors

| Code | Status | When |
|---|---|---|
| `INVALID_COORDINATES` | 400 | Range or containment fails |
| `REGION_TOO_SMALL` | 400 | Below 0.01 × 0.01 normalized |
| `INVALID_PAGE` | 400 | Outside 1..pageCount |
| `MISSING_FIELD_LABEL` | 400 | `custom` with no label |
| `REGION_NOT_FOUND` | 404 | No such region on this document |
| `PRECONDITION_REQUIRED` | 428 | `If-Match` absent |
| `REGION_MODIFIED` | 409 | Version mismatch; current state in `details` |

---

## Frontend

### Coordinate utilities (`utils/canvas.ts`)

The single implementation of coordinate maths, shared with Week 3's text layer:

```typescript
function screenToNormalized(sx: number, sy: number, w: number, h: number): { x: number; y: number }
function normalizedToScreen(nx: number, ny: number, w: number, h: number): { x: number; y: number }
function clampNormalized(v: number): number
function roundCoord(v: number): number                 // 6 dp (D9)

// Two drag corners → a normalized rect. Handles dragging up/left (negative extents).
function normalizeRegionBounds(x1: number, y1: number, x2: number, y2: number):
  { x: number; y: number; width: number; height: number }

// Mirrors the server rules exactly (D9). Returns null when valid.
function validateRegion(r: { x: number; y: number; width: number; height: number }): string | null
```

`validateRegion` exists so the UI can disable an invalid commit instead of posting a
request it knows will fail. It is UX only — the server check is the contract, and the
client one is never trusted.

**Scale is not part of the stored coordinate.** Screen position is
`normalized × renderSize`, where `renderSize` already includes zoom. This is why a
region drawn at 200% reloads correctly at 75%.

### `useCanvasDrawing`

```typescript
interface UseCanvasDrawingReturn {
  isDrawing: boolean;
  draft: CanvasRegion | null;
  startDrawing: (x: number, y: number) => void;
  updateDrawing: (x: number, y: number) => void;
  endDrawing: () => CanvasRegion | null;   // null if below minimum
  cancelDrawing: () => void;
}
```

Pointer events, not mouse events — one code path covers mouse, touch and pen.
Shift constrains to a square. Escape cancels. A drag ending below the minimum returns
`null` and is silently discarded rather than opening the field selector for a region
that cannot be saved.

### `useRegions`

```typescript
interface UseRegionsReturn {
  regions: Region[];
  loading: boolean;
  error: string | null;
  createRegion: (draft: RegionDraft) => Promise<void>;
  updateRegion: (id: string, updates: Partial<Region>) => Promise<void>;
  deleteRegion: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}
```

- Optimistic: apply locally with `isPending`, reconcile or roll back on response
- **Commit on gesture end, not during it.** A drag emits a pointer event per frame;
  one `PUT` per frame would be ~60 requests per second per drag. Local state updates
  continuously, the request fires on pointer-up.
- Retry network errors only, max 3, with backoff. A 4xx is a real rejection — retrying
  a `REGION_TOO_SMALL` just fails again.
- On 409, take the server's state from `error.details`, replace local state, and show
  a brief "updated elsewhere" notice.

### `RegionCanvas` (**D11**)

Two stacked canvases over the page image:

- **Layer 1** — committed regions. Redrawn when `regions` or `scale` changes.
- **Layer 2** — interaction: the in-progress draft, selection handles, hover.

Splitting them means a drag repaints only the small top layer instead of every region
on every frame.

Raw Canvas API — no Fabric.js or Konva.js (**D11**).

**Modes**

| Mode | Cursor | Behaviour |
|---|---|---|
| `draw` | crosshair | Drag creates a region; release opens `FieldTypeSelector`; Escape cancels |
| `select` | default | Click selects and shows handles; click empty space deselects; Delete removes |
| `pan` | grab / grabbing | Drag pans the zoomed page |

**Visual design**

- Unselected: 2px border, 20% fill
- Selected: 3px dashed border, 30% fill, 8px corner handles
- Drawing: 2px dashed, 10% fill, dimension tooltip following the cursor
- Pending save: reduced opacity with a small spinner
- Below minimum while drawing: red border, so the constraint is visible before release

**Colour by field group**

| Group | Colour |
|---|---|
| Vendor | `#3B82F6` blue |
| Invoice metadata | `#10B981` green |
| Financial | `#8B5CF6` purple |
| Line items | `#F59E0B` amber |
| Custom | `#6B7280` grey |

Colour is never the only signal — every region carries its field label, and the list
panel names each one. Several of these hues are hard to separate with common colour
vision deficiencies.

**Handles** are 8px squares drawn at the corners, with a 12px hit area — an 8px target
is below every touch guideline and awkward with a mouse. Resizing re-validates
continuously and refuses to shrink below the minimum.

### `RegionList`

Regions on the current page: sortable by field type, creation time or vertical
position; filterable by type; click to select and scroll into view; inline edit of
field type and custom label; delete with confirmation.

### `FieldTypeSelector`

Grouped options matching the colour groups. Choosing `custom` reveals a required text
input. Number keys 1–9 select the common types. Recently used types float to the top —
invoice batches repeat, so the second document should be faster than the first.

### `DocumentViewer` updates

Toolbar with mode toggles, zoom, page navigation (prev/next and direct entry), and a
region count for the current page.

**Keyboard**

| Key | Action |
|---|---|
| `D` / `S` | Draw / Select mode |
| `Space` (hold) | Temporary pan |
| `Delete` / `Backspace` | Delete selected |
| `Escape` | Cancel draw, or deselect |
| `Ctrl+Z` | Undo last creation (local only) |
| Arrows | Nudge selected region by one screen pixel |
| `Shift`+Arrows | Nudge by ten |

Arrow nudge converts one screen pixel to normalized units at the current scale, so
the movement matches what the user sees at any zoom.

---

## Acceptance criteria

Setup:
1. [ ] `npx prisma migrate dev` creates `extraction_regions`
2. [ ] `\d extraction_regions` shows the table and composite index
3. [ ] The `field_type` column stores `vendor_name`, lowercase (**D8**)

Drawing:
4. [ ] Draw mode: drag renders a live rectangle with a dimension tooltip
5. [ ] Release opens `FieldTypeSelector`
6. [ ] Choosing a type saves the region and it appears in the list
7. [ ] Escape mid-drag cancels with nothing saved
8. [ ] A drag below 1% of the page shows a red border and saves nothing (**D9**)
9. [ ] `custom` requires a label before the selector will commit

Editing:
10. [ ] Click selects and shows corner handles
11. [ ] Dragging a handle resizes; one `PUT` fires on release, not during (**D9**)
12. [ ] Dragging the body moves the region; one `PUT` on release
13. [ ] Delete removes it from the database and the UI
14. [ ] Arrow keys nudge by one screen pixel at any zoom

Coordinates — the core of the week:
15. [ ] Draw at 200%, reload at 100% — the region is over the same text (**D9**)
16. [ ] Draw at 50%, zoom to 400% — it stays aligned
17. [ ] Regions render correctly on both portrait and landscape pages
18. [ ] Stored values are 6 dp normalized floats
19. [ ] A region drawn to the exact page edge stores `x + width == 1` and reloads flush

Pages:
20. [ ] Regions can be drawn on several pages
21. [ ] Page navigation shows only that page's regions
22. [ ] The page counter matches the list

Validation:
23. [ ] `POST` with `x: -0.1` → 400 `INVALID_COORDINATES`
24. [ ] `POST` with `x: 0.9, width: 0.5` → 400 `INVALID_COORDINATES` (**D9**)
25. [ ] `POST` with `width: 0.005` → 400 `REGION_TOO_SMALL`
26. [ ] `POST` with `pageNumber: 999` → 400 `INVALID_PAGE`
27. [ ] `POST` with `fieldType: 'not_a_field'` → 400
28. [ ] `PUT` moving a region out of bounds is rejected on the merged result

Concurrency (**D13**):
29. [ ] `PUT` without `If-Match` → 428
30. [ ] `PUT` with a stale version → 409 with current state in `details`
31. [ ] Two tabs: editing in one, then the other, shows the reconcile notice rather
       than silently overwriting

Integrity:
32. [ ] `DELETE /api/documents/:id` cascades and removes its regions
33. [ ] A region id from document B, requested under document A, returns 404
34. [ ] Refresh restores every region in the correct position

---

## Notes for Week 3

- `FieldType`, `useRegions` and `utils/canvas.ts` are reused directly. The text layer
  produces the same normalized coordinates — it does not get a second coordinate
  system.
- `extraction_regions` gains `rawText`, `confidence`, `correctedText` and `source` in
  Week 3, so text-layer and OCR extractions land in one table.
- `source` will distinguish `text_layer`, `ocr` and `manual`.
