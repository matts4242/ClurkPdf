# ClurkPdf

An invoice batch processor: upload PDFs, pull structured data out of them, export it
to your accounting tooling.

Most invoices arriving as PDFs are digitally generated and already contain their text
with exact positions. ClurkPdf reads that directly, falls back to OCR only for real
scans, and keeps a person in the loop to confirm what it found. Templates make the
second invoice from a vendor much cheaper than the first.

---

## Status

**Specification stage. There is no application code yet.**

This repository currently contains the design documents for a seven-week build. The
`client/` and `server/` directories referenced by the root `package.json` scripts do
not exist — those scripts describe the Week 1 target, not something you can run today.

| | |
|---|---|
| Specs | Complete for all seven weeks |
| Code | Not started — Week 1 is next |
| CI | Lints the documentation. Build and test steps land with Week 1. |

---

## Documentation

Read in this order:

| Document | What it covers |
|---|---|
| [`docs/00-decisions.md`](docs/00-decisions.md) | **Start here.** Fifteen normative technical decisions. Where any other document disagrees with this one, this one wins. |
| [`docs/01-overview.md`](docs/01-overview.md) | Product scope, users, architecture, data model, open questions |
| [`docs/week-1-upload-viewer.md`](docs/week-1-upload-viewer.md) | Upload, storage, database, page rendering, viewer |
| [`docs/week-2-regions.md`](docs/week-2-regions.md) | Canvas region drawing and persistence |
| [`docs/week-3-text-layer.md`](docs/week-3-text-layer.md) | Text-layer extraction and attribute tagging |
| [`docs/week-4-ocr.md`](docs/week-4-ocr.md) | Page classification and OCR fallback |
| [`docs/week-5-batch-queue.md`](docs/week-5-batch-queue.md) | Job queue, batch grid, live progress |
| [`docs/week-6-templates.md`](docs/week-6-templates.md) | Template capture, matching, application |
| [`docs/week-7-export.md`](docs/week-7-export.md) | Validation, export, audit trail |
| [`docs/99-appendix-future.md`](docs/99-appendix-future.md) | Deferred scope, and rejected options with reasons |
| [`REVIEW.md`](REVIEW.md) | What was wrong with the original specs and how each item was resolved |

Every week spec references decisions by ID (`D4`, `D9`) rather than restating them.
That is deliberate — restating a constraint in five places is how the original specs
drifted apart in the first place.

---

## Starting Week 1

1. Read [`docs/00-decisions.md`](docs/00-decisions.md) end to end. It is short, and it
   settles choices the week specs assume have been made.
2. Read [`docs/week-1-upload-viewer.md`](docs/week-1-upload-viewer.md). It should be
   buildable without needing any other document to answer a question — if it isn't,
   that's a bug in the spec worth fixing before writing code.
3. Scaffold `client/` and `server/` as laid out in that document.
4. Work to its acceptance criteria. Week 2 assumes all of them pass.

Track progress in [`.scaffold/sections/tasks/backlog.md`](.scaffold/sections/tasks/backlog.md).

### What Week 1 will need

- Node 20 LTS
- Docker, for local PostgreSQL
- Nothing else. PDF handling is pure npm — no poppler, no ImageMagick, no system
  Tesseract (see **D5**).

---

## Build sequence

Vertical slices, not horizontal layers. Each week ends with something that runs
end-to-end, which keeps architectural mistakes cheap.

```
Week 1  Upload, storage, database, viewer
Week 2  Region drawing              ← needs 1
Week 3  Text layer + tagging        ← needs 1, 2
Week 4  Page classifier + OCR       ← needs 2, 3
Week 5  Batch queue + progress      ← needs 1-4
Week 6  Templates                   ← needs 5
Week 7  Validation + export         ← needs all
```

Weeks 3 and 4 are in this order on purpose. Text extraction handles the common case
exactly and for free; OCR then arrives as a scoped fallback for pages that genuinely
have no text layer, with a classifier routing between them. Built the other way round,
OCR becomes the default and gets used on documents that never needed it.

---

## Scope note

v1 has **no authentication**. Every document is visible to every caller. It is a local
or internal tool until an auth phase is scheduled — see **D12** and the appendix.
