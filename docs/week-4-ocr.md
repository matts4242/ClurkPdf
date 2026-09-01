# Week 4 — OCR Fallback

> Governed by [`00-decisions.md`](00-decisions.md).

**Goal:** read text from scanned pages by cropping regions and running OCR, with
confidence scoring and a correction workflow.

**Phase 4 of 7.** This was Week 3 in the original plan. It now runs *after* the text
layer, which changes what it is: not the primary extraction path, but the fallback for
pages that have no machine-readable text. The classifier from Week 3 decides which
pages those are.

This ordering matters for cost and accuracy. Built first, OCR becomes the default and
gets used on digital PDFs whose exact text was already available — slower, and worse.

**Applies:** D3, D5, D6, D9

---

## Structure

```
client/src/
  components/
    OcrReviewPanel.tsx        # NEW: side-by-side correction
    ConfidenceBadge.tsx       # NEW
  hooks/
    useOcr.ts                 # NEW
server/src/
  services/
    ocr/
      OcrProvider.ts          # NEW: interface
      TesseractProvider.ts    # NEW: the v1 implementation
      index.ts
    imageService.ts           # NEW: crop + preprocess
  controllers/ocrController.ts
  config/classifier.ts        # UPDATE: tune against fixtures
fixtures/                     # NEW: sample invoices + ground truth
```

---

## Fixtures

Introduced here because the overview commits to ">95% OCR accuracy for printed text"
and there is currently nothing to measure that against. Until this exists, the number
is aspiration.

```
fixtures/
  digital-simple.pdf          + .expected.json
  digital-multipage.pdf       + .expected.json
  scanned-clean.pdf           + .expected.json     # 300 DPI flatbed
  scanned-noisy.pdf           + .expected.json     # phone photo, skewed
  scanned-rotated.pdf         + .expected.json     # 90° rotation
  mixed-embedded-raster.pdf   + .expected.json
```

Each `.expected.json` holds ground-truth field values and their regions. A test
harness runs extraction across the set and reports per-field exact-match and
character-error rate. That number, not a quoted target, is what the accuracy claim
should reference.

Fixtures must be synthetic or redacted. Real invoices carry supplier bank details and
personal data, and this directory is committed.

---

## Interface contracts

### Provider (**deferred cloud OCR, see appendix**)

```typescript
interface OcrProvider {
  readonly name: string;
  recognize(image: Buffer, opts?: OcrOptions): Promise<OcrResult>;
  terminate(): Promise<void>;
}

interface OcrOptions {
  language?: string;              // default 'eng'
  pageSegmentation?: 'block' | 'line' | 'word' | 'sparse';
}

interface OcrResult {
  text: string;
  confidence: number;             // 0-100
  words: Array<{ text: string; confidence: number }>;
}
```

`TesseractProvider` is the only implementation in v1. The interface exists so Google
Vision or Textract is a second implementation rather than a rewrite — Textract in
particular returns table structure, which is the likely answer to line items.

### Requests

```typescript
interface OcrRequest {
  regionIds?: string[];           // omit → every region on the document
  force?: boolean;                // re-run regions already extracted
}

interface OcrRegionResult {
  regionId: string;
  status: 'success' | 'failed' | 'skipped';
  extractionId?: string;
  text?: string;
  confidence?: number;
  error?: { code: string; message: string };
}

interface OcrResponse {
  documentId: string;
  results: OcrRegionResult[];
  summary: { total: number; succeeded: number; failed: number; skipped: number };
}
```

Per-region status is the contract: one region failing must not fail the batch. The
response is `200` whenever the request was processed, even if every region failed —
the failures are in the body. A `500` would discard the successes alongside them.

### Endpoints

```
POST /api/documents/:id/ocr                 → OcrResponse
GET  /api/documents/:id/ocr/status          → { pending, running, completed }
GET  /api/documents/:id/pages/:n/class      → { pageClass, signals }
```

---

## Backend

### Image preparation (**D6**)

Crops come from `pages/{n}.png` — the 150 DPI render — never from `thumb.png`, which
is 150px wide and carries nowhere near enough detail to read.

```typescript
async function cropRegion(documentId: string, pageNumber: number,
                          region: NormalizedBox): Promise<Buffer>
async function preprocess(image: Buffer): Promise<Buffer>
```

Cropping converts normalized coordinates to pixels against the actual rendered
dimensions, then expands by a 2% padding margin on each side. Tesseract loses
characters that touch the crop edge, and users draw boxes tight to the glyphs.

Preprocessing, in order: greyscale, Otsu binarization, deskew if the detected angle
exceeds 0.5°. Upscale to an effective 300 DPI when the crop is small — Tesseract is
markedly better at 300 than 150, and small crops upscale cheaply.

**Re-render at higher DPI for OCR?** 150 DPI is adequate for clean scans. If fixture
measurement shows otherwise, add a 300 DPI variant cached at `pages/{n}@300.png`
rather than raising the default and doubling storage for every viewed page.

### OCR execution

Tesseract.js in a **worker pool**, size `min(4, cpus - 1)`, created once at startup
and reused. The original specified `Promise.all` over regions, which spawns an
unbounded number of workers — a 40-region page would attempt 40 concurrent WASM
instances and exhaust memory. `Promise.all` is the right shape only over a bounded
pool.

Per region:

1. Skip if an extraction exists and `force` is not set → `skipped`.
2. Crop and preprocess.
3. Recognize, with a **30-second timeout**. Timeout is a failure for that region only.
4. Write an `Extraction` with `source: 'ocr'`, the real confidence, and the region's
   geometry; set `Region.extractionId`.
5. Catch everything — a thrown error becomes a `failed` result, never an unhandled
   rejection.

Page segmentation is chosen by field type: `line_items` uses `block`, everything else
uses `line`. Single-line fields read materially better with the line mode.

### Confidence

Tesseract's 0–100 word confidences, aggregated to the region as the **minimum** word
confidence, not the mean. One badly misread character in an invoice number invalidates
the field, and a mean hides it behind a run of confident words.

| Band | Colour | Treatment |
|---|---|---|
| > 90 | green | Accept, no prompt |
| 70–90 | amber | Flagged for review |
| < 70 | red | Requires confirmation before export |

Thresholds live in `config/ocr.ts`.

Week 7's export refuses to run while any red field is unconfirmed, unless explicitly
overridden. Silently exporting text the system knows is probably wrong is the failure
mode this whole review workflow exists to prevent.

---

## Frontend

### `useOcr`

```typescript
interface UseOcrReturn {
  runOcr: (regionIds?: string[]) => Promise<void>;
  running: boolean;
  progress: { done: number; total: number };
  results: Map<string, OcrRegionResult>;
  error: string | null;
}
```

Week 4 is request/response with a progress estimate. Week 5 replaces it with real
WebSocket progress; the hook's shape does not change.

### `OcrReviewPanel`

Side-by-side: the cropped region image on the left, the extracted text on the right,
editable.

- Sorted worst-confidence-first — the review queue should start where the work is
- Word-level confidence shading within the text, so the suspect word is visible
  rather than the whole field being suspect
- Editing writes `correctedText`; `rawText` is preserved for the audit trail
- Keyboard: `Enter` accept and advance, `Tab` next field, `Esc` revert
- A confirm control for red fields, recording that a human looked

### `ConfidenceBadge`

Colour plus the numeric score plus a text label. Never colour alone — red/green is
the single worst pairing for the most common colour vision deficiency, and this badge
carries the signal the user is meant to act on.

### Viewer integration

- "Run OCR" on the toolbar, and a per-region re-run in the region list
- Regions render an inline confidence badge once extracted
- Scanned pages surface OCR mode by default (Week 3's classifier)
- Regions with a failed OCR show a distinct error state with a retry

---

## Errors

| Code | Status | When |
|---|---|---|
| `NO_REGIONS` | 400 | OCR requested with no regions defined |
| `DOCUMENT_NOT_READY` | 409 | `status !== 'ready'` |
| `PAGE_NOT_RENDERED` | 409 | Page image missing and re-render failed |
| `OCR_TIMEOUT` | — | Per-region, in the result body |
| `OCR_FAILED` | — | Per-region, in the result body |
| `CROP_FAILED` | — | Per-region: region resolves to zero pixels |

The last three are never HTTP statuses. They are per-region entries in a `200`
response.

---

## Acceptance criteria

Setup:
1. [ ] Tesseract.js initializes without a system Tesseract install (**D5**)
2. [ ] The worker pool is created once at startup, not per request
3. [ ] `fixtures/` contains all six documents with `.expected.json`

Cropping:
4. [ ] Crops come from `pages/{n}.png`, never `thumb.png` (**D6**)
5. [ ] Normalized coordinates map to the correct pixel area
6. [ ] Padding is applied and edge characters survive
7. [ ] Cropping is correct at every zoom the region was drawn at (**D9**)
8. [ ] A landscape page crops correctly

Recognition:
9. [ ] A clean scan yields legible text at >90% confidence
10. [ ] A noisy scan yields text with a correspondingly lower score
11. [ ] Confidence is the minimum word confidence, not the mean
12. [ ] `line_items` uses block segmentation and preserves line breaks
13. [ ] A 40-region page does not spawn 40 workers
14. [ ] A region that exceeds 30s fails alone; the others complete

Resilience:
15. [ ] One failing region returns `failed` for it and `success` for the rest
16. [ ] The response is `200` even when every region fails
17. [ ] A zero-area crop returns `CROP_FAILED`, not a crash
18. [ ] Re-running without `force` skips already-extracted regions
19. [ ] `force: true` re-runs and overwrites `rawText`, preserving `correctedText`

Review:
20. [ ] The panel sorts worst-confidence-first
21. [ ] Badges are green >90, amber 70–90, red <70
22. [ ] Badges show a number and a label, not colour alone
23. [ ] Editing writes `correctedText` and preserves `rawText`
24. [ ] Red fields require explicit confirmation
25. [ ] Keyboard review advances without the mouse

Integration:
26. [ ] OCR extractions land in `extractions` with `source: 'ocr'`
27. [ ] `Region.extractionId` links to the result
28. [ ] Text-layer and OCR extractions coexist on one document
29. [ ] The Data tab shows both with correct source badges
30. [ ] A digital page still defaults to text-layer mode (Week 3)

Measurement:
31. [ ] The fixture harness runs and reports per-field accuracy
32. [ ] Classifier thresholds are tuned against fixtures, not guessed
33. [ ] Measured accuracy on `scanned-clean` is recorded in the README — whatever the
       number is. A measured 91% is more useful than an unmeasured 95%.

---

## Notes for Week 5

- The worker pool moves behind BullMQ; per-region logic is unchanged
- `useOcr`'s progress switches from estimated to real WebSocket events
- OCR is the slowest step and sets the batch throughput ceiling — measure it here so
  Week 5's concurrency has a basis
- The fixture harness becomes the regression suite for every later change
