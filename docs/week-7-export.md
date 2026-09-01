# Week 7 — Validation & Export

> Governed by [`00-decisions.md`](00-decisions.md).

**Goal:** validate extracted data, then get it out as CSV, JSON or XLSX.

**Phase 7 of 7.** The last mile. Everything before this produced data inside the
application; this week makes it useful somewhere else.

**Applies:** D2, D3, D12

**Not in scope:** QuickBooks and Xero OAuth, and XML for ERP. See
[`99-appendix-future.md`](99-appendix-future.md). Each accounting integration is an
OAuth app registration, a token lifecycle, a chart-of-accounts mapping UI and vendor
reconciliation — one to two weeks each, not a fourth checkbox in a file-format list.

---

## Structure

```
client/src/
  components/
    ValidationPanel.tsx       # NEW
    ExportDialog.tsx          # NEW
    AuditTrail.tsx            # NEW
  hooks/
    useValidation.ts          # NEW
    useExport.ts              # NEW
server/src/
  services/
    validationService.ts      # NEW
    export/
      ExportFormatter.ts      # NEW: interface
      CsvFormatter.ts
      JsonFormatter.ts
      XlsxFormatter.ts
  controllers/exportController.ts
```

---

## Interface contracts

### Validation

```typescript
type Severity = 'error' | 'warning';

interface ValidationIssue {
  documentId: string;
  fieldType: FieldType | null;     // null for cross-field issues
  code: string;
  severity: Severity;
  message: string;
  actual?: string;
  expected?: string;
}

interface ValidationResult {
  documentId: string;
  valid: boolean;                  // no errors; warnings permitted
  issues: ValidationIssue[];
  unconfirmedLowConfidence: number;  // red-band fields not yet confirmed (Week 4)
}
```

`error` blocks export by default; `warning` does not. The distinction matters because
real invoices legitimately violate tidy rules — rounding of a fraction of a currency
unit, a discount line, a foreign-currency total.

### Export

```typescript
type ExportFormat = 'csv' | 'json' | 'xlsx';

interface ExportRequest {
  format: ExportFormat;
  documentIds?: string[];          // omit → whole batch
  includeLineItems?: boolean;      // default false
  includeUnconfirmed?: boolean;    // default false — see below
  fields?: FieldType[];            // omit → all
}

interface ExportRow {
  documentId: string;
  filename: string;
  vendorName: string | null;
  vendorAddress: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;      // ISO 8601
  dueDate: string | null;
  poNumber: string | null;
  subtotal: number | null;         // parsed numeric, not the raw string
  tax: number | null;
  total: number | null;
  lineItems: string | null;        // raw text unless includeLineItems
  confidence: number | null;       // minimum across the document's fields
  source: 'text_layer' | 'ocr' | 'mixed' | 'manual';
  confirmed: boolean;
  templateApplied: string | null;
  extractedAt: string;
}
```

`includeUnconfirmed` defaults to **false**, and exporting with unconfirmed low-
confidence fields requires setting it explicitly. Week 4 flags red-band fields for
confirmation and Week 6 marks template-populated values as suggested rather than
verified; silently exporting either into an accounting system is the failure mode the
entire human-in-the-loop design exists to prevent. The flag makes it a decision rather
than an accident.

### Endpoints

```
GET  /api/documents/:id/validate      → ValidationResult
GET  /api/batches/:id/validate        → { results, summary }
POST /api/batches/:id/export          → 200 file stream
GET  /api/documents/:id/audit         → { entries }
```

Export is `POST` — the request carries a body of options, and it records an audit
entry, which is not a safe or idempotent `GET`.

---

## Validation rules

### Field format

| Field | Rule | Severity |
|---|---|---|
| `invoice_date`, `due_date` | Parses to a real date; not more than 1 year ahead | error / warning |
| `subtotal`, `tax`, `total` | Parses to a number after currency-symbol strip | error |
| `invoice_number` | Non-empty; warn if it has no digit | warning |
| `vendor_name` | Non-empty | error |
| `due_date` | Not before `invoice_date` | error |

**Date parsing is the trap.** `03/04/2025` is 3 April or 4 March depending on locale,
and invoices carry no locale marker. Rules:

1. Prefer unambiguous formats — ISO, or a written month name.
2. When ambiguous, use the configured `DATE_LOCALE` (default `en-GB`, day-first).
3. **Always flag an ambiguous date as a warning** naming both readings.

Guessing silently produces confidently wrong dates in an accounting system. Flagging
costs one review click.

### Cross-field

| Rule | Severity |
|---|---|
| `subtotal + tax == total`, tolerance 0.01 | error |
| `sum(line items) == subtotal`, tolerance 0.01, only when parsed | warning |
| `tax / subtotal` within 0–30% | warning |
| `total > 0` | warning |

The tolerance is absolute, not relative — invoice arithmetic is fixed-point, and 0.01
covers rounding without masking real errors.

Amounts are parsed and compared as **integer minor units**, never floats.
`19.99 + 0.01 !== 20.00` in IEEE 754, and a cross-field check that fails on correct
data is worse than no check.

Currency is not in the field list — flagged as an open question in the overview. Until
it exists, all amounts within a document are assumed to share one currency, and mixed-
currency documents will validate incorrectly. Worth resolving before this ships.

---

## Backend

### Formatters

```typescript
interface ExportFormatter {
  readonly format: ExportFormat;
  readonly contentType: string;
  readonly extension: string;
  stream(rows: AsyncIterable<ExportRow>, opts: ExportRequest): NodeJS.ReadableStream;
}
```

Streaming, not buffering. A 50-document XLSX in memory is fine; the interface is
streaming because the batch limit is a product decision (**D2**) that may rise, and
retrofitting streaming later means rewriting all three formatters.

- **CSV** — `fast-csv`. UTF-8 BOM so Excel reads accented vendor names correctly.
  Values quoted; embedded newlines in `lineItems` preserved inside quotes.
- **JSON** — streamed array. Nested line items when `includeLineItems`.
- **XLSX** — `exceljs`, not `xlsx`. Streaming writer, typed cells (dates as dates,
  amounts as numbers with a currency format), a frozen header row, and a second sheet
  listing validation issues.

Amounts are written as numbers, not strings. A spreadsheet column of text that looks
numeric is a familiar and avoidable annoyance.

### Row assembly

Per document: load extractions, take the effective value (`correctedText ?? rawText`,
per Week 3), pivot field types into columns, parse amounts and dates, and compute
document-level confidence as the minimum across fields (consistent with Week 4's
aggregation).

`source` is `mixed` when a document's extractions have more than one source.

Documents with validation errors are excluded unless the request overrides, and the
response header reports how many were skipped.

### Audit trail

Every extraction create, update, delete, template application, confirmation and export
appends an entry:

```prisma
model AuditEntry {
  id         String   @id @default(uuid())
  documentId String?
  batchId    String?
  action     String   // extraction.created, extraction.corrected, template.applied, ...
  fieldType  String?
  oldValue   String?
  newValue   String?
  userId     String?  // D12 — null in v1
  createdAt  DateTime @default(now())

  @@map("audit_entries")
  @@index([documentId, createdAt])
  @@index([batchId, createdAt])
}
```

Append-only: no update or delete endpoint. An editable audit trail is not one. Entries
survive document deletion — `documentId` is nullable and not a cascading foreign key,
because "this document was deleted" is itself something the trail should record.

---

## Frontend

### `ValidationPanel`

Grouped by severity, errors first. Each issue names the field, the problem, the actual
value and the expectation. Clicking an issue opens that document and highlights the
field.

Batch view: a summary bar — "42 ready, 6 warnings, 2 errors" — with the errors as a
worklist. A quick-fix inline editor for format issues avoids a round trip through the
viewer for a mistyped date.

### `ExportDialog`

Format, scope (batch or selection), field selection, line-item toggle.

A pre-export summary states plainly what will happen: how many documents export, how
many are excluded for errors, and how many carry unconfirmed low-confidence fields.
Exporting unconfirmed data requires ticking `includeUnconfirmed`, with the count shown
next to it.

Download via a streamed response with `Content-Disposition`. Progress for large
batches; the dialog stays open until the download starts, so a failure is visible.

### `AuditTrail`

Reverse-chronological per document: what changed, from what, to what, when, and by
what — text layer, OCR, template, or a person. Filterable by action.

---

## Errors

| Code | Status | When |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Export attempted with blocking errors and no override |
| `UNCONFIRMED_FIELDS` | 422 | Low-confidence fields without `includeUnconfirmed` |
| `NO_DOCUMENTS` | 400 | Nothing in scope to export |
| `UNSUPPORTED_FORMAT` | 400 | Format not one of the three |
| `EXPORT_FAILED` | 500 | Formatter error mid-stream |

`EXPORT_FAILED` mid-stream cannot change an already-sent status. The stream is
destroyed so the client sees a truncated download rather than a silently short file,
and the failure is logged with the audit entry.

---

## Acceptance criteria

Validation:
1. [ ] A document with all fields and consistent arithmetic validates clean
2. [ ] `subtotal + tax != total` raises an error
3. [ ] Amounts compare as integer minor units — `19.99 + 0.01 == 20.00` passes
4. [ ] A 0.01 discrepancy is within tolerance
5. [ ] A missing `vendor_name` is an error; a missing `po_number` is not
6. [ ] `due_date` before `invoice_date` is an error
7. [ ] `03/04/2025` is flagged ambiguous with both readings (**not** silently parsed)
8. [ ] `2025-04-03` parses without a warning
9. [ ] A currency-symbol amount (`$1,234.56`) parses to `1234.56`
10. [ ] Line items not summing to subtotal is a warning, not an error
11. [ ] Batch validation summarizes counts by severity

Export — CSV:
12. [ ] Downloads with correct headers
13. [ ] A UTF-8 BOM is present; accented vendor names open correctly in Excel
14. [ ] Embedded newlines and commas are quoted correctly
15. [ ] Empty fields are empty, not the string `null`

Export — JSON:
16. [ ] Valid JSON with one object per document
17. [ ] `includeLineItems` nests items; without it they are raw text
18. [ ] Numbers are numbers; dates are ISO 8601 strings

Export — XLSX:
19. [ ] Opens in Excel and in LibreOffice
20. [ ] Amounts are numeric cells with currency formatting, not text
21. [ ] Dates are date cells
22. [ ] The header row is frozen
23. [ ] A second sheet lists validation issues

Export behaviour:
24. [ ] Documents with errors are excluded and the count is reported
25. [ ] Unconfirmed low-confidence fields block export by default (**Week 4**)
26. [ ] `includeUnconfirmed: true` permits it and the audit records the choice
27. [ ] Template-suggested but unconfirmed values are treated as unconfirmed (**Week 6**)
28. [ ] Field selection limits the columns
29. [ ] A 50-document export completes and memory does not scale with row count
30. [ ] Mid-stream failure truncates visibly rather than delivering a short file

Audit:
31. [ ] Every extraction create, correction and delete is recorded
32. [ ] Template application is recorded with the template id
33. [ ] Export is recorded with format, scope and options
34. [ ] Corrections record both old and new values
35. [ ] There is no endpoint that modifies or deletes an entry
36. [ ] Entries survive deletion of their document

End-to-end — the whole product:
37. [ ] Upload a 20-invoice batch (Week 5)
38. [ ] Digital invoices extract via the text layer (Week 3)
39. [ ] Scanned invoices extract via OCR (Week 4)
40. [ ] Templates auto-populate repeat vendors (Week 6)
41. [ ] Validation flags the genuine problems
42. [ ] Review and correct the flagged fields
43. [ ] Export to XLSX with correct data
44. [ ] The audit trail reconstructs every value's provenance
45. [ ] Total elapsed time is measured against the <15 minute target for 50 invoices

---

## Where this leaves v1

Delivered: a working single-tenant invoice extraction tool. Upload, extract by text
layer or OCR, templates for repeat vendors, validated export, full audit trail.

Not delivered, and deliberately so (see the appendix): authentication, multi-tenancy,
object storage, accounting integrations, billing, compliance certification.

**The one thing to be clear about before deploying anywhere reachable:** there is no
authentication (**D12**). Every document is visible to every caller. This is a local
or internal tool until an auth phase is scheduled.
