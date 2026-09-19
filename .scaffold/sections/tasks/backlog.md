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

## Week 5 — Batch queue, live progress, and automatic fields

- [x] `Batch` model, `Document.batchId`, and batch CRUD endpoints. Progress is
      derived from the documents on every read rather than kept as a counter,
      since three workers updating one would race
- [x] BullMQ queue plus a worker bounded by `QUEUE_CONCURRENCY`; the upload
      endpoint queues and returns `queued` instead of rendering inline
- [x] WebSocket at `/ws` carrying `ProcessingEvent`, filterable by batch. The
      client's polling loop is gone
- [x] `BatchGrid` thumbnail grid with per-document status badges and progress,
      and `BatchProgress` for the pipeline stages
- [x] Auto-detection of the fields an invoice declares, from the text layer

Also delivered:

- [x] A restart no longer loses work. A document stranded mid-render returns to
      `queued` and is re-enqueued, rather than being marked failed as in Weeks
      1-4 — the main thing the queue buys
- [x] Hash-based duplicate detection, reported as `duplicateOf`. A warning, not
      a refusal
- [x] Detected regions are flagged `autoDetected`: marked in the sidebar, drawn
      dashed on the canvas, and cleared the moment a person edits one
- [x] Uploads run three at a time instead of strictly serially, now that the
      transfer is the whole wait
- [x] Redis added to docker-compose, CI, and the VPS installer — including the
      nginx `/ws` upgrade, without which live progress fails silently behind
      the proxy
- [x] 43 new server tests and 18 new client tests; 158 across the project

Deviations from the spec, recorded in the README: BullMQ rather than Bull
(Bull 4 is in maintenance, BullMQ is its successor); progress events travel
over Redis pub/sub rather than an in-process emitter, so a second worker
process can still reach a browser connected to the first; and only the first
`EAGER_RENDER_PAGES` pages are rendered up front rather than every page, so one
200-page PDF cannot hold a worker while a batch waits.

Two bugs found while testing this slice. Using the document id as the BullMQ
job id deduplicates concurrent submissions, which is wanted — but BullMQ
retains finished jobs, and `add` against a retained id does nothing *silently*,
so recovering a document that had already completed once left it queued for
ever. And the amount pattern matched `504` out of `5040.00`, because with the
group separators optional the `.00` was neither a group nor a decimal part.

## Week 6 — Templates

- [x] `Template` model holding the vendor identifier and the saved rectangles
      as JSON, plus `Document.templateId` and `templateScore`
- [x] Save a document's regions as a template; the vendor identifier defaults
      to its VENDOR_NAME region, so Week 5's detection feeds Week 6 and saving
      needs no typing
- [x] `vendorMatcher`: read the top third of page 1 and score it against each
      template's vendor, applying above the spec's 80%
- [x] The processing job applies a matching template before detection runs, so
      the stronger claim wins and detection fills only what is left
- [x] `POST /api/templates/:id/apply` for one document or a whole batch — the
      spec's "Apply to Similar Documents"
- [x] `GET /api/documents/:id/template-suggestions` for matches too weak to
      apply on their own
- [x] `TemplatePanel` in the viewer: save, suggest, apply, delete; a Template
      badge on the grid card

Also delivered:

- [x] A replayed rectangle **snaps to the text actually underneath it** on the
      new invoice, so a layout that shifted by a line still reads correctly
- [x] When the search has to widen, the line that *reads like* the field being
      placed wins over the one that merely sits nearest
- [x] `extractValue` strips the label from a captured line, so a replayed
      TOTAL stores `1800.00` rather than `Total: 1800.00`
- [x] Applying never overwrites a field the document already has, and applying
      twice is a no-op
- [x] A template outlives the document it was learned from, and deleting a
      template leaves the regions it already placed
- [x] 60 new server tests; 218 across the project

Deviation from the spec, recorded in the README: no `user_id` on the template,
because the project still has no accounts — the same omission the earlier weeks
made.

Two bugs found while testing this slice, both in the replay path. A rectangle
saved from one invoice and replayed onto another caught no text at all when the
layout had shifted by more than a line, because snapping only ever looked
inside the rectangle it was given. And once the search was widened, two lines
equidistant from the saved rectangle — the field above and the field below —
were separated only by which came first in document order, so a PO number
quietly picked up a date.

## Week 7

Not started. One line of intent in `Project_Overview/Week 7.1`: export.

Week 7's export is the first point where the two capture modes have to produce
one flat row per document; because both already write to `Region`, that should
be a single query rather than a merge. Week 6 helps twice over: `extractValue`
already reduces a captured line to the value a column wants, and a document
filled in from a template needs no per-document work before it can be
exported.
