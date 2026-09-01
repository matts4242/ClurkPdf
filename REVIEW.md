# Specification Review

A record of what the original planning documents got wrong and how each item was
resolved. Kept as a standing document rather than a throwaway note, so the revisions
are auditable — otherwise the specs simply change and nobody can tell later what was
decided from what was quietly dropped.

**Reviewed:** the original `Project_Overview/` — a product overview and two detailed
week prompts, with Weeks 3–7 as one-line stubs.

**Verdict:** the product thinking was sound. The specs were not executable. An
engineer handed the original Week 1 would have hit a file-size limit contradicting the
overview, an endpoint with no store behind it, and a dependency needing system
binaries that were never mentioned — before writing any feature code.

The root cause is structural, not careless: the documents were written top-down (the
overview) and bottom-up (the week prompts) and nothing reconciled them. The same
constraint was restated in several places and the copies diverged. That is why the fix
is a normative [`docs/00-decisions.md`](docs/00-decisions.md) that everything else
references, rather than a pass of local edits — local edits would drift again as
Weeks 3–7 were written.

---

## Defects

Ordered by what they would have cost to find later.

### 1. Enum values disagreed between the API and the database — **D8**

Week 2 defined the field type twice:

```typescript
enum FieldType { VENDOR_NAME = 'vendor_name', ... }   // wire: lowercase
```
```prisma
enum FieldType { VENDOR_NAME  ... }                    // Prisma emits "VENDOR_NAME"
```

Prisma generates enum members as their own uppercase names. The API would accept
`vendor_name`, store `VENDOR_NAME`, and return `VENDOR_NAME` to a client that only
recognizes `vendor_name`.

Both halves look correct in isolation, which is what makes this expensive: it is found
in the browser, not in review, and it corrupts data in every round trip until it is.

**Resolved:** one value everywhere, lowercase snake_case, with `@map` on every Prisma
enum member. Table names mapped the same way, since the overview's data model used
snake_case (`extraction_regions`) while the Prisma models did not.

`scripts/check-docs.mjs` now fails the build on a Prisma enum member without an
`@map`. This class of defect does not come back.

### 2. Week 1 needed persistence it did not have — **D4**

Week 1 had no database, but specified `GET /api/documents/:id` returning persisted
metadata and a client polling it until `status` became `ready`. Both require
server-side state, and nothing said where it lived.

The acceptance criterion "Refreshing page clears state (no persistence yet — expected)"
is about *client* state, but reads as blanket permission to skip persistence — leaving
an in-memory `Map` that empties on every nodemon restart, during the week you restart
the server most.

**Resolved:** Postgres and Prisma move into Week 1. This also deletes Week 2's
"Week 1 → Week 2 migration guide", which existed only to paper over the gap.

### 3. Two incompatible minimum region sizes — **D9**

- Client: "Minimum region size: 20x20 pixels on screen"
- Server: `REGION_TOO_SMALL` — "at least 0.01 x 0.01 (1% of page)"

Screen pixels depend on zoom. On an 800px-wide render at 100%, 1% of the page is 8px —
the server accepts what the client refuses to draw. At 400% the same 1% is 32px and
the client permits regions the server rejects *after* the user has drawn them. There
is no zoom level at which both rules agree for all page sizes.

**Resolved:** normalized units are the only unit of validation. The client mirrors the
same rule as UX; the server check is the contract. Also caught while here: the original
bounds check ("coordinates between 0 and 1") permitted `x: 0.9, width: 0.5` — a region
extending half a page past the edge. Containment is now checked, not just range.

### 4. Upload contradicted its own client contract — **D7**

Week 1 described `uploadDocument` as converting page 1 then returning the finished
document, *and* described a client hook polling until `status` was `ready` with
exponential backoff. If upload is synchronous the document is already ready on return
and the entire poll loop is dead code.

**Resolved:** upload is async — `202`, render after the response, client polls as its
hook already described. This is also the shape Week 5's queue needs, so the queue
replaces the post-response call without changing the API contract.

### 5. Undocumented system dependencies — **D5**

Week 1 named `pdf2pic` / `pdf-poppler` for rasterization. Both shell out to
**poppler-utils** and **ImageMagick/GraphicsMagick** — system binaries absent from a
stock CI runner and from a fresh `npm install`. The prerequisite appeared nowhere in
the setup section, so the first CI run and the first new contributor both fail on it.

`pdf-parse`, used for page count, is unmaintained, and its published entry point has
historically executed a debug branch reading a bundled test PDF.

**Resolved:** `pdfjs-dist` + `@napi-rs/canvas` for rendering, `pdf-lib` for page count.
Pure npm; `npm ci` is the complete setup.

### 6. A security control that fails open — **D14**

> "Static file serving for `/uploads` (but NOT `/uploads/*/original.pdf` for security)"

`express.static` has no exclusion pattern. Written literally this produces a mount
serving every original PDF — and it fails silently, looking exactly like the secure
version.

**Resolved:** no static mount. Rendered images are served by an explicit route that
validates the UUID and page number, resolves the path, and confirms it is still inside
the document directory before any filesystem call. Originals get a deliberate endpoint
that is one route to protect when auth arrives.

### 7. Client-controlled upload validation — **D15**

Week 1 validated "PDF only" via multer's `mimetype`, which is the `Content-Type` the
client sends — attacker-controlled, and routinely wrong from ordinary browsers.

Filename handling was "sanitize filenames (remove path traversal attempts)": a
denylist, and denylists for path traversal are historically leaky.

**Resolved:** extension check, then **magic bytes** (`%PDF-`) as the authoritative
check, then structural parse. Stored filenames are the document UUID; the original
name is kept in a column for display. This removes traversal as a category rather than
filtering for it.

### 8. An error that could never fire — **D13**

Week 2 defined `REGION_MODIFIED` (409) and an acceptance criterion for concurrent
modification, against a model with no version column, no `updatedAt` precondition, and
no header to carry one. There was nothing to compare.

**Resolved:** `version Int` plus `If-Match`, with the check and the write as one
conditional `updateMany` — a read-then-write leaves a window where two clients both
read version 3 and both write version 4.

### 9. Thumbnail and page render conflated — **D6**

Week 1 asked for "150px width, maintain aspect ratio" and "support 150 DPI minimum"
for the same file. Those are different artifacts, and 150px wide is unusable for the
region drawing Week 2 builds on it — or for Week 4's OCR crops.

**Resolved:** `thumb.png` (150px, eager) and `pages/{n}.png` (150 DPI, lazy, cached)
are separate files with separate functions.

### 10. Unbounded OCR concurrency

The original Week 3 specified processing regions "in parallel (Promise.all)". A
40-region page would attempt 40 concurrent Tesseract WASM instances and exhaust
memory. `Promise.all` is the right shape only over a bounded pool.

**Resolved:** a worker pool of `min(4, cpus - 1)`, created once at startup. Week 5
bounds concurrency twice — documents in flight *and* workers within a document —
because four concurrent documents times four workers is sixteen instances.

### 11. Smaller items

- **File limits** — overview 25 MB / 50 files / 100 MB; Week 1 10 MB in four places
  including a user-facing error string and an acceptance criterion. A 10 MB cap
  rejects ordinary multi-page scans, the exact input this product exists to process.
  Overview wins (**D2**), and the numbers now live in one module.
- **Prisma path** given as both `server/prisma/` and `server/src/prisma/` in different
  sections. Now the Prisma default.
- **Duplicate route** — `GET /regions/page/:pageNumber` alongside `GET /regions?page=`.
  One way now.
- **Backend language** left as "Node/Express **or** Python/FastAPI" and never closed;
  Week 1 chose silently. Closed explicitly (**D1**).
- **Canvas library** — the overview mandated Fabric.js or Konva.js; Week 2 explicitly
  rejected both. Week 2 is right; the overview is corrected (**D11**).
- **State management** — the overview mandated Zustand/Redux; the weeks used lifted
  state with no stated trigger for switching. Trigger is now named: Week 5 (**D10**).
- **`onRegionCreate`** required the caller to invent an `id` and timestamps before the
  server had issued them.
- **Region drag** — "optimistic updates" over pointer events, with no debounce
  guidance, implies a `PUT` per frame. Now: local state during the gesture, one
  request on release.
- **Retry policy** — "auto-retry on network failure (3 attempts)" was applied to all
  failures. Retrying a `REGION_TOO_SMALL` just fails again. Network errors only.
- **`'uploaded'` status** was indistinguishable from `'processing'`; a row exists only
  after upload succeeds. Removed.
- **`onPageChange`** was in Week 1's viewer props, but page navigation arrives in
  Week 2. Moved.
- **8px resize handles** are below every touch-target guideline. Now 8px drawn, 12px
  hit area.
- **Colour-only status** — the confidence bands are red/amber/green, the worst pairing
  for the most common colour vision deficiency, on the signal the user is meant to act
  on. Badges now carry a number and a label.
- **No delete endpoint** existed for documents anywhere in seven weeks, so testing the
  upload path accumulated permanent junk. Added in Week 1.

---

## Gaps

Things absent rather than wrong.

### Weeks 3–7 did not exist

Five one-line stubs, each a copy of its line from the overview's dependency list:

> `Week 5: Queue system → Batch processing (needs Weeks 1-3)`

All five are now written at Week 1–2 parity: interface contracts, error tables,
implementation notes, acceptance criteria.

### Authentication was assumed but never scheduled — **D12**

The overview specified `user_id` on documents, three RBAC roles, a SOC 2 roadmap,
GDPR retention and four pricing tiers. Week 2 asked for an "ownership check stub".

Across all seven weeks there is no `User` model, no login, no session, and no week in
which auth is built. The plan assumed multi-tenancy while scheduling zero hours for
it, which made seven weeks look like they delivered a sellable multi-tenant SaaS. They
deliver a working single-tenant tool — a good outcome, but a different one.

**Resolved:** v1 is explicitly single-tenant with no auth, stated in the README and in
Week 7's closing section. A nullable `userId` column is reserved now on every table
that would become user-scoped, because backfilling ownership onto ownerless rows is
the expensive migration. RBAC, SOC 2, GDPR and pricing move to the appendix.

Week 2's "ownership check" is also renamed to what it is: verifying the region belongs
to the document in the URL. That is a real authorization check — it stops
`/documents/A/regions/{a-region-of-B}` mutating B — and calling it a stub undersold it.

### No test fixtures, but a quantified accuracy claim

The overview commits to ">95% OCR accuracy for printed text, >85% for handwritten".
Nothing in the repo could measure either.

**Resolved:** Week 4 introduces `fixtures/` with six documents and ground-truth JSON,
plus a harness reporting per-field exact match and character error rate. The printed
target is restated as measured-against-fixtures, and Week 4 requires recording the
actual number — a measured 91% being more useful than an unmeasured 95%.

Handwriting is deferred: Tesseract does not reach 85% on handwriting, and quoting a
target the chosen engine cannot hit is a commitment nobody can keep.

### Templates could never bootstrap

Week 6's matching keyed on vendor identity — "compare against known vendor names in
templates" — but nothing extracts a vendor name before a template exists to extract
it. First invoice from a vendor: no template, so no vendor name, so no match, so no
template. The loop never starts.

**Resolved:** a two-stage match. Fingerprint the header region of page 1 — which works
on any document, template or not — then match the fingerprint. Numeric tokens are
excluded from the fingerprint, or two invoices from one vendor with different invoice
numbers would look like different vendors.

### Line items were never really specified

Both extraction modes produce one blob of text for `line_items`. Turning that into
rows needs table structure detection or a manual column-mapping UI, and Week 7 has to
export *something*.

**Not resolved** — recorded as an open question in the overview, to settle by Week 4.
It is a design decision, not an oversight to paper over.

### Other open questions recorded

- **Multi-page templates** — do field positions apply per page or per document?
  Week 6 takes the conservative reading; flagged for confirmation.
- **Currency** — the field list has `total` and `tax` but no currency. Adding it after
  export exists means changing the export schema.

---

## Suggestion adopted: text layer before OCR

The largest change to the plan, and the only one that alters what gets built rather
than how it is described.

The original order was OCR (Week 3), then text extraction (Week 4), described as
"parallel to Week 3".

Most invoices arriving as PDFs are digitally generated and carry an embedded text
layer — the exact characters, with positions, already in the file. Extracting it costs
nothing, cannot misrecognize a character, and produces no confidence score to review.
Running region OCR over those pages re-derives, worse and slower, text the file already
contains.

Built OCR-first, OCR becomes the default path and gets used on documents that never
needed it.

**Swapped.** Week 3 is now the text layer, Week 4 is OCR as the scan fallback. This
required one addition: a **page classifier** deciding text-layer vs OCR per page, on
extracted character count and glyph coverage. Without it there is no rule for which
mode a document lands in — the original's "dual-mode" framing left the choice entirely
to the user, including the choice to burn OCR on a machine-readable document and get a
worse result.

The classifier's thresholds are tuned against Week 4's fixtures rather than guessed,
and the user can always override.

---

## Repository

- `Week 1.1 Code` was byte-identical to `Week 1.1 Upload, PDF Viewer` — deleted.
- `filestructure` and `.agents/skills/project-planning/SKILL.md` were both 0 bytes.
  Deleted; an empty skill file is worse than none, advertising a capability that does
  nothing.
- Files had no extension (`Week 3.1`), so GitHub rendered none of them. All renamed to
  `.md`, via `git mv` so history follows.
- Three project names were in play — ClurkPdf (repo), Bookit (README), invoice-processor
  (package.json). Standardized on **ClurkPdf**; renaming the repo was the costlier
  option. Say so if you prefer another.
- The README was two lines. Rewritten with status, the doc map, and how to start.
- CI was the untouched GitHub "Hello, world!" template, running on `main` only and
  testing nothing. Replaced: runs on all branches, and actually checks the specs.
- `.scaffold/sections/tasks/backlog.md` read `_No tasks yet._`. Populated.

### The consistency checker

`npm run docs:check` (`scripts/check-docs.mjs`, no dependencies) fails the build when
a resolved contradiction reappears:

- the superseded 10 MB limit, or the pixel-based region minimum
- a rejected dependency named outside a rationale document
- a Prisma enum member without an `@map` — defect #1's regression test
- a decision cited but not defined, or defined but never cited by a week
- a week spec with no acceptance criteria
- a broken relative link, or a reference to the old file layout

Build and test steps are deliberately absent from CI until Week 1 code exists. A green
check that ran no tests is worse than an honest one that admits it only checks docs.

---

## What was not changed

- **The product concept.** Hybrid human-in-the-loop extraction with template learning
  is a good fit for the problem and the persona.
- **Vertical slices over horizontal layers.** Correct, and the reason each week ends
  with something that runs.
- **The seven-week shape**, apart from the 3/4 swap.
- **The UI layout**, field taxonomy, and colour groups.
- **Normalized coordinates** as the storage format — the right call, and the reason
  regions survive zoom. Only the validation rules around them changed.
- **The success metrics**, except where they were unmeasurable as stated.
