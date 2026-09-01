# Technical Decisions

**Status: normative.** Where any other document in this repo disagrees with this
one, this one wins. Week specs reference decisions by ID (`D4`, `D9`) rather than
restating them — that is deliberate. Restating a constraint in five places is how
the original specs drifted apart.

Changing a decision means editing it here and noting the change, not overriding it
locally in a week spec.

---

## D1 — Backend is Node 20 + Express + TypeScript

The overview originally offered "Node.js/Express **or** Python/FastAPI" and left the
choice open. Week 1 quietly picked Node without recording it, so the option was never
actually closed.

It is closed now: **Node 20 LTS, Express 4, TypeScript 5, ESM.** FastAPI is not a
fallback. The frontend is TypeScript regardless, and one language across both halves
means shared type definitions for the API contract instead of a hand-maintained
mirror.

## D2 — File limits: 25 MB per file, 50 files per batch, 100 MB per batch

The overview said 25 MB / 50 files / 100 MB. Week 1 said 10 MB, in four separate
places including a user-facing error string and an acceptance criterion that tested
for it (`11MB file rejected`).

The overview's numbers are the product requirement and they win. A 10 MB cap rejects
ordinary multi-page scanned invoices, which is the exact input this product exists to
process.

```
MAX_FILE_BYTES   = 26_214_400    // 25 MiB
MAX_BATCH_FILES  = 50
MAX_BATCH_BYTES  = 104_857_600   // 100 MiB
```

These live in one module (`server/src/config/limits.ts`) and are imported by the
multer config, the validation layer, and the client's dropzone. No week spec restates
the numbers.

Week 1 accepts a single file at a time — that is a **UI** limitation while the batch
grid doesn't exist yet. The server enforces the full limits from day one, so Week 5
adds a queue rather than re-negotiating validation.

## D3 — Storage is local disk behind an interface; object storage deferred

The overview mandates S3/MinIO. Every week spec writes to `./uploads`. Neither
acknowledged the other, so nothing said when or how the switch happens.

v1 writes to local disk. All filesystem access goes through a single
`StorageAdapter` interface:

```typescript
interface StorageAdapter {
  put(key: string, data: Buffer | NodeJS.ReadableStream): Promise<void>;
  get(key: string): Promise<NodeJS.ReadableStream>;
  delete(keyPrefix: string): Promise<void>;   // prefix delete, for whole documents
  exists(key: string): Promise<boolean>;
}
```

`LocalStorageAdapter` is the only implementation in v1. No route, controller or
service calls `fs` directly. S3 becomes a second implementation, not a refactor.
See the appendix.

## D4 — PostgreSQL from Week 1, not Week 2

The most load-bearing correction in this document.

Week 1 as written had no database, but specified `GET /api/documents/:id` returning
persisted metadata and a client that polls it until `status` becomes `ready`. That
requires server-side state and nothing said where it lived. The acceptance criterion
"Refreshing page clears state (no persistence yet — expected)" is about *client*
state, but it reads as blanket permission to skip persistence entirely, which would
leave an in-memory `Map` that empties on every nodemon restart — during the exact
week you restart the server most.

Postgres and Prisma land in Week 1. The `Document` model exists from the first
migration; Week 2 adds `Region` alongside it. This also deletes Week 2's awkward
"Week 1 → Week 2 migration guide", which existed only to paper over the gap.

## D5 — PDF rendering: `pdfjs-dist` + `@napi-rs/canvas`; page count via `pdf-lib`

Week 1 named `pdf2pic` / `pdf-poppler` for rasterization and `pdf-parse` for page
count. Both choices carry problems that surface on someone else's machine, not yours:

- `pdf2pic` and `pdf-poppler` shell out to **poppler-utils** and **GraphicsMagick /
  ImageMagick**. Those are system binaries, absent from a stock CI runner and from a
  fresh `npm install`. The prerequisite was never documented, so the first CI run and
  the first new contributor both fail on it.
- `pdf-parse` is unmaintained, and its published entry point has historically
  executed a debug branch that reads a bundled test PDF when called without the
  expected shape — a well-known trap.

Both are replaced with pure-npm dependencies:

| Need | Package |
|---|---|
| Rasterize a page to PNG | `pdfjs-dist` rendering into `@napi-rs/canvas` |
| Page count, metadata | `pdf-lib` |
| Text layer with positions (W3) | `pdfjs-dist` `getTextContent()` |

`npm ci` is then the complete setup step on any machine.

## D6 — Thumbnails and page renders are different artifacts

Week 1 asked for "150px width, maintain aspect ratio" and "support 150 DPI minimum"
for the same output file. Those are two different things, and 150px wide is unusable
for the region-drawing that Week 2 builds on top of it.

They are separate, with separate names:

```
uploads/{documentId}/
  original.pdf
  thumb.png              # 150px wide, page 1 only, for the batch grid
  pages/{n}.png          # 150 DPI full render, for the viewer and for OCR crops
```

`thumb.png` is generated eagerly on upload. `pages/{n}.png` is generated lazily on
first request and cached. OCR (W4) crops from `pages/{n}.png`, never from the thumb.

## D7 — Upload is asynchronous: `202`, then poll

Week 1 described `uploadDocument` as converting page 1 and then returning the
finished `Document`. It also described a client hook that polls until `status` is
`ready`, with exponential backoff. If the upload is synchronous the document is
already `ready` when it returns and the entire poll loop is dead code — the contract
contradicted itself.

Upload is asynchronous:

1. `POST /api/documents/upload` validates, persists the original, writes a row with
   `status: 'processing'`, and returns **`202 Accepted`** with that row.
2. Rendering (page count, `thumb.png`, `pages/1.png`) runs after the response.
3. `GET /api/documents/:id` reports `processing`, then `ready` or `error`.
4. The client polls with backoff, exactly as its hook already described.

This shape is also what Week 5's job queue needs, so the queue replaces the
after-response call without changing the API contract.

## D8 — One enum value, lowercase snake_case, on the wire and in the database

Week 2 defined the field type twice and the two definitions did not match:

```typescript
enum FieldType { VENDOR_NAME = 'vendor_name', ... }   // TypeScript: lowercase value
```
```prisma
enum FieldType { VENDOR_NAME  ... }                    // Prisma: emits "VENDOR_NAME"
```

Prisma generates its enum members as their own uppercase names. So the API would
accept `vendor_name`, hand `VENDOR_NAME` to the database, and return `VENDOR_NAME` to
a client that only recognizes `vendor_name`. Every round trip corrupts the value, and
because both halves individually look correct, this is the kind of defect that gets
found in the browser rather than in review.

**One value, everywhere: lowercase snake_case.** Prisma maps explicitly:

```prisma
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

Table names are mapped the same way, since the overview's data model used
snake_case (`extraction_regions`) while the Prisma models did not:
`@@map("documents")`, `@@map("extraction_regions")`, `@@map("document_templates")`.
Prisma model names stay PascalCase in TypeScript; only the SQL identifiers change.

## D9 — Coordinates: normalized 0–1, 6 dp; minimum region 0.01 × 0.01 normalized

Week 2 specified a minimum region size twice, incompatibly:

- Client: "Minimum region size: 20x20 pixels on screen"
- Server: `REGION_TOO_SMALL` — "at least 0.01 x 0.01 (1% of page)"

Screen pixels depend on zoom. On an 800px-wide render at 100%, 1% of the page is 8px
— the server accepts regions the client refuses to draw. At 400% zoom the same 1% is
32px and the client permits regions the server rejects after the user has already
drawn them. There is no zoom level at which both rules agree for all page sizes.

**Normalized units are the only unit of validation.**

- Stored as `Float`, rounded to **6 decimal places** on write. (Week 2 said 4 dp;
  at 4 dp one unit is ~0.25px on a 300 DPI render, so a drag-resize round trip can
  visibly drift. 6 dp is free and doesn't.)
- Minimum region: `width >= 0.01 && height >= 0.01`.
- Bounds: `0 <= x`, `0 <= y`, `x + width <= 1`, `y + height <= 1`. Note this is
  stricter than Week 2's "coordinates between 0 and 1", which permitted a region
  starting at 0.9 with width 0.5 to extend past the page edge.
- The client mirrors the same normalized check and disables the commit rather than
  posting a request it knows will be rejected. It does not apply a separate pixel
  rule.

Shared implementation in `client/src/utils/canvas.ts` and validated server-side in
`regionService`. The client check is UX; the server check is the contract.

## D10 — Local state through Week 2; Zustand at Week 5

The overview mandated Zustand or Redux Toolkit. Weeks 1–2 use lifted `useState` in
`App.tsx` and say nothing about a store, so there was no stated trigger for adopting
one.

The trigger is **Week 5**. Through Week 4, state is per-document and a single owner
component holds it. Week 5 introduces the batch grid, where queue status, per-document
progress and WebSocket events are read by components that don't share a parent — the
point at which prop-drilling actually costs something.

Zustand, not Redux Toolkit: no async middleware is needed, the store is small, and
the boilerplate difference is real.

## D11 — Raw Canvas API; no Fabric.js or Konva.js

The overview named "Fabric.js or Konva.js". Week 2 explicitly rejected both: "no
external libraries yet — keep it lightweight".

Week 2 is right and the overview is corrected. The requirement is axis-aligned
rectangles with corner handles over a static image. Neither library's object model,
serialization or event system earns its bundle size here, and both would have to be
fought to keep coordinates normalized rather than in their own scene space.

## D12 — No authentication in v1

The overview specifies `user_id` on documents, three RBAC roles (Admin, Booker,
Viewer), a SOC 2 Type II roadmap, GDPR retention, and four pricing tiers. Week 2 asks
for an "ownership check stub for now".

Across all seven weeks there is no `User` model, no login, no session, and no week in
which auth is built. The plan assumes multi-tenancy while scheduling zero hours for
it.

v1 is **single-tenant with no authentication.** It is a local/internal tool until an
auth week is scheduled.

To keep that from becoming a painful migration:

- Every table that would eventually be user-scoped gets a **nullable `userId
  String?`** column now, plus an index. Adding a nullable column later is easy;
  backfilling ownership onto rows that have no owner is not.
- "Ownership checks" in Week 2 are renamed to what they actually are: verifying the
  region belongs to the document in the URL. That is a real check and should not be
  called a stub.

RBAC, SOC 2, GDPR retention and pricing move to `99-appendix-future.md`. They are
product intentions, not v1 requirements, and leaving them in the main spec makes the
seven-week plan look like it covers ground it does not.

## D13 — Optimistic concurrency via `version` + `If-Match`

Week 2 defined a `REGION_MODIFIED` 409 error and an acceptance criterion for
concurrent modification, against a model with no version column, no `updatedAt`
precondition, and no header to carry one. There was nothing to compare, so the error
could never fire.

Either drop it or make it real. Making it real is four lines:

- `Region.version Int @default(1)`, incremented on every update.
- `PUT` and `DELETE` on a region require `If-Match: <version>`.
- Mismatch → `409 REGION_MODIFIED`; the response body carries the current server
  state so the client can reconcile without a second request.
- Missing header → `428 PRECONDITION_REQUIRED`.

This is also what makes Week 2's optimistic UI safe: a stale write is rejected rather
than silently overwriting a change the user made in another tab.

## D14 — Original PDFs are never statically served

Week 1: "Static file serving for `/uploads` (but NOT `/uploads/*/original.pdf` for
security)".

`express.static` has no exclusion pattern. Written literally, that line produces a
static mount that serves everything under `uploads/`, including every original — and
it fails open, silently, looking exactly like the secure version.

- `express.static` is **not** used for `uploads/`.
- Rendered images are served by an explicit route that validates the document ID as a
  UUID, validates the page number as a positive integer within `pageCount`, resolves
  the path, and confirms the resolved path is still inside the document's directory
  before streaming. Path resolution happens before any filesystem call.
- Originals are served only by `GET /api/documents/:id/original`, a deliberate
  endpoint. When auth arrives it is one route to protect rather than a mount to
  unpick.

## D15 — Uploads are validated by content, not by declared type

Not a contradiction in the original specs — an omission, recorded here because two
weeks depend on it.

Week 1 validates "PDF only" via multer's `mimetype`, which is the `Content-Type` the
client sends. It is attacker-controlled and also routinely wrong from ordinary
browsers.

Validation is, in order:

1. Extension check — cheap rejection.
2. **Magic bytes** — the file must begin with `%PDF-`. This is the authoritative
   check.
3. `pdf-lib` parses it and reports a page count. A file that does not parse is
   rejected `422 INVALID_PDF` before anything else touches it.

Stored filenames are the document UUID, never the uploaded name. The original name is
kept in the database column `originalName` for display and is HTML-escaped at render.
This removes path traversal as a category rather than sanitizing for it — Week 1's
"sanitize filenames (remove path traversal attempts)" is a denylist, and denylists
for this are historically leaky.

---

## Decision index

| ID | Decision | Primary weeks |
|---|---|---|
| D1 | Node 20 + Express + TypeScript | 1 |
| D2 | 25 MB / 50 files / 100 MB limits | 1, 5 |
| D3 | Local storage behind `StorageAdapter` | 1 |
| D4 | PostgreSQL + Prisma from Week 1 | 1, 2 |
| D5 | `pdfjs-dist` + `@napi-rs/canvas`, `pdf-lib` | 1, 3, 4 |
| D6 | Thumbnail ≠ page render | 1, 5 |
| D7 | Async upload, `202` + poll | 1, 5 |
| D8 | Lowercase snake_case enum, `@map` | 2, 3, 4 |
| D9 | Normalized coords, 6 dp, 0.01 minimum | 2, 3, 4 |
| D10 | Zustand introduced at Week 5 | 5 |
| D11 | Raw Canvas API | 2 |
| D12 | No auth in v1, nullable `userId` reserved | 1, 2 |
| D13 | `version` + `If-Match` concurrency | 2, 3 |
| D14 | No static serving of `uploads/` | 1 |
| D15 | Magic-byte upload validation | 1, 5 |
