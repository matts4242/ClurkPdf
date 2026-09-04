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

## Weeks 3-7

Not started. One line of intent each in `Project_Overview/Week 3.1` through
`Week 7.1`: OCR, text-layer extraction, batch queueing, templates, export.

Week 3 (OCR) builds directly on the regions this week added: crop each stored
rectangle out of the rendered page image and run it through Tesseract.
