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

## Week 4 — Text layer extraction

- [x] `textLayerService` extracts positioned text runs with pdf.js, normalised
      to the same 0-1 space as regions
- [x] `GET /api/documents/:id/text-layer/:pageNumber`, reporting `hasText:
      false` for a scan
- [x] `TextLayer` component renders an invisible, selectable copy of the page
      text over the image
- [x] Floating toolbar on selection, with 1-9 keyboard shortcuts
- [x] Smart snapping to word and line boundaries

Also delivered:

- [x] Highlighting produces an ordinary `Region` with `textSource: TEXT_LAYER`,
      so corrections, the sidebar and Week 7's export need no second path
- [x] Text is derived server-side from the rectangle, so a moved text-layer
      region re-reads itself rather than dropping back to PENDING
- [x] The stored rectangle snaps onto the text it captured
- [x] 17 text-layer tests, 95 across the project

Two bugs found while testing this slice: the region canvas sat over the text
layer and swallowed the caret, and the first overlap rule required half a text
run to be inside the rectangle — which no ordinary selection satisfies, because
pdf.js emits a whole line as one run.

## Week 5 — Batch queueing

Acceptance criteria from Prompt 7 of the project overview.

- [x] A document processing queue, BullMQ on Redis
- [x] `POST /api/batches` adds one `extract-invoice` job per uploaded file
- [x] The processor converts every page to an image
- [x] The processor runs auto-detection for the common fields
- [x] Detected regions are saved to the database
- [x] A WebSocket event is emitted as each document settles, and again when the
      batch is done
- [x] `BatchUpload` with multi-file drag-drop, queue status, a thumbnail grid
      with status badges, and a click-through to `DocumentViewer`

Also delivered:

- [x] A `Batch` model whose counts are derived from its documents, so there is
      no second source of truth to keep in step
- [x] A rejected file is reported on its own rather than failing the batch
- [x] Per-document retry, and a document is only marked failed on the last
      attempt
- [x] Batch documents are left alone at startup recovery, because their jobs
      outlive the process in Redis
- [x] The client falls back to polling when the socket is unavailable, so a
      proxy that drops upgrades costs immediacy rather than correctness
- [x] 12 batch and detection tests against a real queue, worker and socket;
      107 across the project
- [x] Redis added to the dev compose file, the production stack and CI

A defect found while testing this slice: switching batches blanked the grid for
a round trip and showed the "drop a folder" empty state while the new batch
loaded. The upload response now seeds the view, and a genuine load shows a
spinner.

## Weeks 6-7

Not started. One line of intent each in `Project_Overview/Week 6.1` and
`Week 7.1`: templates, export.

Week 7's export is the first point where the two capture modes have to produce
one flat row per document; because both already write to `Region`, that should
be a single query rather than a merge.
