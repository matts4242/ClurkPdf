# Task Plan Backlog

Track task completion. Check off tasks as they are implemented.

## Week 1 — Document upload and PDF viewer

Acceptance criteria from `Project_Overview/Week 1.1 Code`, verified in a real
browser against the running app.

- [x] Can drag-drop a PDF onto the browser
- [x] See upload progress bar advance
- [x] After upload, see "Processing" state briefly
- [x] First page of PDF renders as image in the viewer
- [x] Can zoom in/out on the image
- [x] Can upload multiple PDFs and switch between them
- [x] 11MB file rejected with clear error message
- [x] Non-PDF file rejected with clear error message
- [ ] Refreshing page clears state — **changed deliberately.** Documents now
      persist across a refresh; see the deviations section of the README
- [x] Server creates proper directory structure in `uploads/`

Also delivered beyond the checklist:

- [x] Page navigation for multi-page documents
- [x] Drag-to-pan when the page is zoomed past the viewport
- [x] Delete a document and its rendered pages
- [x] `GET /api/documents` so the client can list what the server holds
- [x] 28 automated tests covering endpoints, rendering, and path safety
- [x] CI running type-check, tests, and build on Node 20 and 22

## Week 2 — Database schema and canvas region drawing

- [x] PostgreSQL via Docker Compose, Prisma schema for `Document` and `Region`
      with a `FieldType` enum, indexes, and a cascade delete
- [x] Migrated `server/src/services/documentStore.ts` from the JSON sidecar
      store to Prisma, keeping its call surface so controllers were unchanged
- [x] `RegionCanvas` overlay on the page image, with normalised 0-1 coordinates
- [x] Region CRUD endpoints and `useRegions` hook
- [x] `FieldTypeSelector` and `RegionList`
- [x] `GET /api/documents/:id` returns `regionCount` and `pagesWithRegions`

Also delivered:

- [x] Draw, select, and pan modes; move and corner-resize; Delete key removes
      the selected region
- [x] Optimistic move and resize with rollback when the server rejects the edit
- [x] 22 server tests for regions and 15 client tests for the coordinate maths
- [x] CI runs a PostgreSQL service; the test suite refuses any database whose
      name does not end in `_test`

Deviation from the spec, recorded in the README: Prisma 7 no longer accepts
`url` in the datasource block, so the connection lives in `prisma.config.ts`
and the runtime client uses the `@prisma/adapter-pg` driver adapter.

## Week 3 — OCR

- [x] `ocrService` crops each region out of the rendered page and runs it
      through Tesseract.js against a shared worker pool
- [x] `POST /api/documents/:id/ocr`, processing every region or a named subset,
      with per-region error isolation
- [x] Results saved to the region rows: `rawText`, `confidence`, `ocrStatus`,
      `ocrError`, `ocrAt`
- [x] Confidence shown colour-coded in the UI (green >90, amber 70-90, red <70)
- [x] Text correction panel with inline editing

Also delivered:

- [x] `correctedText` is stored separately from `rawText`, so the original
      reading survives an edit and can be reverted to
- [x] Moving or resizing a region clears its OCR text, since the rectangle then
      covers different pixels
- [x] Re-read a single region, or only the ones not yet read
- [x] 13 OCR tests running real recognition against a generated invoice

Deviations from the spec, recorded in the README: the endpoint takes region ids
rather than raw rectangles (the regions already live in the database), and
recognition is bounded by `OCR_CONCURRENCY` rather than an unbounded
`Promise.all`, because each job holds a WASM instance.

## Weeks 4-7

Not started. One line of intent each in `Project_Overview/Week 4.1` through
`Week 7.1`: text-layer extraction, batch queueing, templates, export.

Week 4 is the alternative to OCR rather than a follow-on: extract the PDF's own
text layer with positions, so a born-digital invoice can be tagged by selecting
real text instead of drawing boxes. `pdfjs-dist` is already a dependency and
already exposes `getTextContent()`.
