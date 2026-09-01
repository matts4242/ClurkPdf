# Week 6 — Templates

> Governed by [`00-decisions.md`](00-decisions.md).

**Goal:** save an extraction pattern for a vendor, match it against new documents, and
apply it automatically.

**Phase 6 of 7.** This is where the product's economics change: the first invoice from
a vendor is manual, and every one after it is a review rather than a data-entry task.

**Applies:** D3, D8, D9, D12, D13

---

## The bootstrap problem

The original plan's template matching keyed on vendor identity — "compare against
known vendor names in templates". But nothing extracts a vendor name before a template
exists to extract it. First invoice from a vendor: no template, so no vendor name, so
no match, so no template. The loop never starts.

Resolved with a two-stage match that does not require a prior extraction:

1. **Fingerprint** the header region of page 1 — the top third, per the original's own
   Prompt 8. This works on any document, template or not.
2. **Match** the fingerprint against stored templates. Only after a match do
   vendor-specific field positions get used.

A template is created from a **confirmed** extraction — the user has reviewed the
fields — so its fingerprint is captured from a document whose vendor is known. The
first invoice from a vendor is manual by definition. That is correct, and it is what
the original plan obscured by describing matching as though templates already existed.

---

## Structure

```
client/src/
  components/
    TemplateSaveDialog.tsx    # NEW
    TemplateMatchBanner.tsx   # NEW: "Template suggested"
    TemplateManager.tsx       # NEW: list, edit, delete
  hooks/
    useTemplates.ts           # NEW
server/src/
  services/
    templateService.ts        # NEW
    fingerprintService.ts     # NEW
  queue/jobs/matchTemplate.ts # NEW: between classify and ocr
  controllers/templateController.ts
```

---

## Interface contracts

```typescript
interface Template {
  id: string;
  name: string;
  vendorIdentifier: string;        // display name; the fingerprint does the matching
  fingerprint: Fingerprint;
  regionMappings: RegionMapping[];
  sourceDocumentId: string | null; // provenance; null if the document was deleted
  matchCount: number;              // times applied — feeds ranking and pruning
  userId: string | null;           // D12
  createdAt: string;
  updatedAt: string;
  version: number;                 // D13
}

interface Fingerprint {
  headerTokens: string[];          // normalized tokens from the top third of page 1
  headerHash: string;              // SHA-256 of sorted tokens — exact-match fast path
  pageAspect: number;              // width / height, 3 dp
  textLayerPresent: boolean;
}

interface RegionMapping {
  pageNumber: number;
  x: number; y: number; width: number; height: number;  // normalized (D9)
  fieldType: FieldType;                                  // D8
  fieldLabel: string | null;
  source: 'text_layer' | 'ocr';    // which mode produced it originally
}

interface TemplateMatch {
  templateId: string;
  templateName: string;
  score: number;                   // 0-1
  matchedTokens: number;
  reason: 'exact_hash' | 'token_overlap';
}
```

### Endpoints

```
GET    /api/templates                        → { templates, total }
POST   /api/templates                        → { template }
GET    /api/templates/:id                    → { template }
PUT    /api/templates/:id                    → { template }    If-Match
DELETE /api/templates/:id                    → 204             If-Match
POST   /api/documents/:id/match-template     → { matches }
POST   /api/documents/:id/apply-template     → { regionsCreated, extractionsCreated }
POST   /api/batches/:id/apply-templates      → 202 { queued }
```

```typescript
interface CreateTemplateRequest {
  name: string;
  vendorIdentifier: string;
  sourceDocumentId: string;    // fingerprint + mappings derived from this document
}

interface ApplyTemplateRequest {
  templateId: string;
  runOcr?: boolean;            // default true for scanned pages
}
```

`CreateTemplateRequest` takes a document id, not a hand-built mapping array. The
server derives fingerprint and regions from the document's confirmed state — a
client-supplied mapping could disagree with the document it claims to come from.

---

## Database

```prisma
model Template {
  id               String   @id @default(uuid())
  name             String
  vendorIdentifier String
  headerHash       String
  headerTokens     String[]
  pageAspect       Float
  textLayerPresent Boolean
  regionMappings   Json                       // RegionMapping[]
  sourceDocumentId String?
  matchCount       Int      @default(0)
  version          Int      @default(1)
  userId           String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@map("document_templates")
  @@index([headerHash])
  @@index([userId])
}
```

`headerTokens` is a Postgres text array with a GIN index for overlap queries;
`regionMappings` is JSONB, since it is read and written whole and never queried into.
`headerHash` is indexed for the exact-match fast path.

`Document` gains `appliedTemplateId String?` — which template produced its regions,
needed for the audit trail and to avoid re-applying.

---

## Backend

### Fingerprinting

```typescript
async function fingerprintDocument(documentId: string): Promise<Fingerprint>
```

1. Take the top third of page 1 (`y < 0.33`).
2. Get its text — Week 3's text layer for digital pages; OCR for scanned. If neither
   is available, fingerprinting fails and the document is simply not matched. Not an
   error; it just processes manually.
3. Normalize: lowercase, strip punctuation, collapse whitespace.
4. Drop tokens that are pure digits or shorter than 3 characters. Invoice numbers,
   dates and totals differ on every invoice from the same vendor — including them
   makes two invoices from one vendor look like different vendors. Retaining vendor
   name, address and label words is the whole point.
5. Deduplicate, sort, hash.

### Matching

```typescript
async function matchTemplates(documentId: string): Promise<TemplateMatch[]>
```

1. **Exact hash** — identical `headerHash` scores 1.0, `reason: 'exact_hash'`. Common,
   since invoices from one vendor share a header layout.
2. **Token overlap** — Jaccard similarity between token sets, over candidates whose
   `pageAspect` is within 2%.
3. Threshold **0.8**, per the original spec.
4. Sort by score, then `matchCount` descending. Return the top 5.

Aspect ratio is a cheap prefilter: a Letter template should not match an A4 document,
and the coordinate mapping would be subtly wrong if it did.

### Applying

```typescript
async function applyTemplate(documentId: string, templateId: string,
                             runOcr: boolean): Promise<ApplyResult>
```

1. Validate the template exists and the document is `ready`.
2. Refuse if the document already has an `appliedTemplateId` unless forced — applying
   twice would double every region.
3. For each mapping: skip if `pageNumber > document.pageCount`; create a `Region` with
   the normalized coordinates, re-validated by Week 2's rules (**D9**). Coordinates
   from a template are input like any other and are not trusted because they were
   stored.
4. For pages with a text layer, extract directly from the mapped box — the region's
   text is already available, and running OCR over it would be strictly worse
   (Week 3's ordering argument applies here too).
5. For scanned pages, enqueue OCR (Week 4/5) when `runOcr`.
6. Set `appliedTemplateId`, increment `matchCount`.

**Multi-page templates.** Mappings carry a page number, so a template applies its
page-1 mappings to page 1 and so on. Templates do not repeat across pages of variable-
length invoices — a 3-page template applied to a 7-page invoice covers the first 3.
Recorded as an open question in the overview; this is the conservative resolution.

### Queue integration

`match-template` sits between `classify` and `ocr` (Week 5):

1. Fingerprint the document.
2. Match. Above threshold and unambiguous → apply automatically, flag
   `template-suggested` for review.
3. Multiple matches above threshold → apply none, surface the choice.
4. No match → continue to manual extraction.

Auto-apply is a **suggestion**, always visible and always reversible. Silently
populated fields that a user assumes were verified is exactly the failure this
product's human-in-the-loop design exists to prevent.

---

## Frontend

### `TemplateSaveDialog`

Offered after a document's extractions are confirmed — not before. A template built
from unreviewed extractions propagates its errors to every future document.

Shows the vendor name it inferred (from the `vendor_name` extraction, editable), a
template name, and a preview of the regions being captured. Warns when fewer than
three fields are mapped, since a two-field template rarely saves work.

### `TemplateMatchBanner`

Above the viewer when a template was applied: which one, the score, "Undo" and "Use a
different template". Undo removes template-created regions and clears
`appliedTemplateId`, leaving anything the user added.

### `TemplateManager`

List with vendor, field count, match count and last used. Rename, delete, and preview
regions over the source document thumbnail. Sort by match count so the useful ones
surface and the one-offs are easy to prune.

### Batch application

From the grid: "Apply templates to all". Enqueues a `match-template` job per
unprocessed document (**not** a client-side loop — 50 sequential requests from the
browser is the wrong shape and blocks on the first failure). Results stream back over
the Week 5 socket.

Summary afterwards: matched, ambiguous, unmatched — with the ambiguous ones as a
review queue.

---

## Errors

| Code | Status | When |
|---|---|---|
| `TEMPLATE_NOT_FOUND` | 404 | No such template |
| `TEMPLATE_ALREADY_APPLIED` | 409 | Already has `appliedTemplateId` |
| `FINGERPRINT_FAILED` | 422 | No extractable header text |
| `NO_CONFIRMED_EXTRACTIONS` | 400 | Save attempted before review |
| `TEMPLATE_MODIFIED` | 409 | Version mismatch (**D13**) |
| `INVALID_MAPPING` | 400 | A mapping fails Week 2 coordinate validation (**D9**) |

---

## Acceptance criteria

Fingerprinting:
1. [ ] A digital invoice fingerprints from its text layer
2. [ ] A scanned invoice fingerprints from OCR
3. [ ] Numeric tokens are excluded — two invoices from one vendor with different
       numbers and dates produce the same hash
4. [ ] A document with no header text returns `FINGERPRINT_FAILED`, not a crash

Creation:
5. [ ] Save is offered only after extractions are confirmed
6. [ ] `NO_CONFIRMED_EXTRACTIONS` when saved too early
7. [ ] The template captures every confirmed region with normalized coordinates
8. [ ] A fewer-than-three-field template warns but is allowed
9. [ ] The dialog pre-fills the vendor from the `vendor_name` extraction

Matching:
10. [ ] A second invoice from the same vendor matches at score 1.0 via hash
11. [ ] A vendor whose header changed slightly matches via token overlap above 0.8
12. [ ] A different vendor scores below threshold and does not match
13. [ ] A Letter template does not match an A4 document (aspect prefilter)
14. [ ] Multiple matches above threshold surface a choice rather than auto-applying
15. [ ] Matches are ranked by score, then match count

Applying:
16. [ ] Regions are created at the correct positions on the new document
17. [ ] Coordinates are re-validated; an invalid mapping is rejected (**D9**)
18. [ ] Digital pages extract from the text layer without running OCR
19. [ ] Scanned pages enqueue OCR
20. [ ] Mappings beyond the document's page count are skipped, not errored
21. [ ] Applying twice returns `TEMPLATE_ALREADY_APPLIED`
22. [ ] `matchCount` increments
23. [ ] The banner shows the template and score
24. [ ] Undo removes template regions and preserves user-added ones

Batch:
25. [ ] "Apply to all" enqueues jobs; the browser does not loop requests
26. [ ] Progress streams over the Week 5 socket
27. [ ] The summary counts matched, ambiguous and unmatched
28. [ ] A failure on one document does not stop the rest

Round trip — the week's real test:
29. [ ] Extract invoice A manually, confirm, save a template
30. [ ] Upload invoice B from the same vendor
31. [ ] B is matched and populated automatically
32. [ ] B's values are correct and marked as template-suggested, not confirmed
33. [ ] Confirming B takes materially less time than A did

---

## Notes for Week 7

- `appliedTemplateId` and the confirmed/suggested distinction feed the audit trail
- Export must distinguish confirmed from merely suggested values — this is precisely
  the case where exporting unreviewed data is dangerous
- `matchCount` gives export a per-vendor grouping for free
