# Task Plan Backlog

Track task completion. Check off tasks as they are implemented.

Each week's detailed acceptance criteria live in its spec under `docs/`. A week is
done when every criterion in its spec passes — the boxes below are the coarse view.

## Planning

- [x] Product overview and architecture
- [x] Normative technical decisions (`docs/00-decisions.md`)
- [x] Week specs 1–7 at full detail
- [x] Deferred scope recorded (`docs/99-appendix-future.md`)

## Week 1 — Upload, storage, database, viewer

- [ ] Scaffold `client/` and `server/`
- [ ] PostgreSQL + Prisma, `documents` table (D4)
- [ ] `StorageAdapter` + local implementation (D3)
- [ ] Upload with magic-byte validation, 25 MB limit (D2, D15)
- [ ] Async upload: `202` + status poll (D7)
- [ ] Page render and thumbnail as separate artifacts (D5, D6)
- [ ] Viewer with zoom and pan
- [ ] All 23 acceptance criteria pass

## Week 2 — Region drawing

- [ ] `extraction_regions` table with enum `@map` (D8)
- [ ] Region CRUD with `If-Match` concurrency (D13)
- [ ] Normalized coordinate validation, 0.01 minimum (D9)
- [ ] Canvas overlay, draw/select/pan modes (D11)
- [ ] Region list and field type selector
- [ ] All 34 acceptance criteria pass

## Week 3 — Text layer and tagging

- [ ] Text layer endpoint with normalized positions
- [ ] Page classifier: digital / scanned / mixed
- [ ] `extractions` table
- [ ] Selection, snapping, floating attribute toolbar
- [ ] Extraction review panel
- [ ] All 32 acceptance criteria pass

## Week 4 — OCR fallback

- [ ] Fixture set with ground truth
- [ ] Crop and preprocess from the 150 DPI render (D6)
- [ ] Tesseract worker pool, bounded
- [ ] Per-region failure isolation
- [ ] Confidence bands and review workflow
- [ ] Classifier thresholds tuned against fixtures
- [ ] All 33 acceptance criteria pass

## Week 5 — Batch queue

- [ ] Redis + BullMQ, three-stage job chain
- [ ] Batch upload, 50 files / 100 MB (D2)
- [ ] Duplicate detection by content hash
- [ ] WebSocket progress with REST reconciliation
- [ ] Zustand store (D10)
- [ ] Document grid
- [ ] All 32 acceptance criteria pass

## Week 6 — Templates

- [ ] Header fingerprinting (solves the bootstrap problem)
- [ ] Exact-hash and token-overlap matching
- [ ] Template application with coordinate re-validation
- [ ] `match-template` queue stage
- [ ] Batch apply
- [ ] All 33 acceptance criteria pass

## Week 7 — Validation and export

- [ ] Field and cross-field validation, integer minor units
- [ ] Ambiguous date flagging
- [ ] CSV, JSON, XLSX streaming formatters
- [ ] Unconfirmed-field export guard
- [ ] Append-only audit trail
- [ ] All 45 acceptance criteria pass

## Open questions — resolve before the week noted

- [ ] Line items: table structure or manual column mapping? *(by Week 4)*
- [ ] Multi-page templates: per page or per document? *(by Week 6)*
- [ ] Currency field: add before export schema is fixed? *(by Week 7)*

## Deferred — not v1

See `docs/99-appendix-future.md`. Authentication, object storage, accounting
integrations, billing, compliance.
