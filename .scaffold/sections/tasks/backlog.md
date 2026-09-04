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

Not started. See `Project_Overview/Week 2.1 Database Schema, Canvas Region Drawing`.

- [ ] PostgreSQL via Docker Compose, Prisma schema for `documents` and
      `extraction_regions`
- [ ] Migrate `server/src/services/documentStore.ts` from the JSON sidecar store
      to Prisma
- [ ] `RegionCanvas` overlay on the page image, with normalised 0-1 coordinates
- [ ] Region CRUD endpoints and `useRegions` hook
- [ ] `FieldTypeSelector` and `RegionList`

## Weeks 3-7

Not started. One line of intent each in `Project_Overview/Week 3.1` through
`Week 7.1`: OCR, text-layer extraction, batch queueing, templates, export.
