# Appendix: Deferred Scope

Everything here appeared in the original product overview and is **not** part of the
seven-week v1. It is kept because the intent is real and the constraints shape v1
design — not because any of it is scheduled.

The reason for splitting it out: the overview presented pricing tiers, a SOC 2
roadmap and OAuth accounting integrations alongside the week plan, which made the
seven weeks look like they delivered a sellable SaaS. They deliver a working
single-tenant extraction tool. That is a good outcome; it is just a different one.

---

## Authentication, accounts, multi-tenancy

Per **D12**, v1 has no auth. Deferred:

- User accounts, sessions, password reset
- RBAC roles — Admin, Booker, Viewer
- Per-user document scoping and quota enforcement
- Organization / team grouping

**What v1 does to prepare:** a nullable `userId String?` column with an index on
every table that would become user-scoped. Backfilling ownership onto ownerless rows
is the expensive migration; adding a nullable column is not.

**Rough size:** one week for accounts and sessions, a second for RBAC and scoping
every query. Realistically it should land before any deployment reachable from the
internet — the current design assumes every caller is trusted.

## Object storage (S3 / MinIO)

Per **D3**, v1 writes to local disk behind `StorageAdapter`.

Deferred: `S3StorageAdapter`, presigned URLs for direct browser upload, CDN in front
of rendered pages, lifecycle rules for expiry.

**Blocking constraint:** local disk means one server. Horizontal scaling of the
Week 5 workers is impossible until documents live somewhere every worker can read.
If scaling is wanted, this comes before more workers.

## Accounting integrations (QuickBooks, Xero)

Week 7 ships CSV, JSON and XLSX. OAuth integrations are deferred.

They are not a file format — each is an OAuth app registration, a token refresh
lifecycle, a chart-of-accounts mapping UI, vendor reconciliation against records
already in the target system, and sandbox credentials for testing. Putting them in
the same week as three file exports is what made Week 7 look small.

**Rough size:** one to two weeks per provider. XML for ERP systems is deferred with
them, since the payload shape depends on which ERP.

## Compliance and data protection

- SOC 2 Type II — an audit programme, not a feature. Months, and it presumes auth.
- GDPR retention with configurable auto-delete. `StorageAdapter.delete()` takes a
  prefix specifically so that a whole document erases in one call when this arrives.
- AES-256 encryption at rest. v1 relies on disk-level encryption; application-level
  encryption needs key management that does not exist yet.
- TLS 1.3 in transit — a deployment concern; v1 runs on localhost over HTTP.

## Pricing and billing

Freemium 50 pages/month, Pro $29/1000, Business $99/5000 + API, Enterprise custom.

Requires: accounts (D12), metered page counting, a payment processor, an invoicing
flow, plan enforcement, and a public API with its own keys and rate limits. None of
it is buildable before auth.

**What v1 does to prepare:** nothing beyond recording `pageCount` per document, which
it needs anyway. Page metering is a query over existing data when the time comes.

## Real-time and scale

- WebSocket progress arrives in **Week 5** — that one is scheduled, not deferred.
- Horizontal worker scaling is blocked on object storage (above).
- Redis is introduced in Week 5 for BullMQ. Using it as a general cache is deferred;
  there is no measured cache pressure to justify it.

## Document intelligence

- **Auto-classification** (invoice vs receipt vs other) — the overview lists it in
  the ingestion pipeline. Deferred: it needs a labelled corpus that does not exist,
  and every v1 path treats input as an invoice.
- **Duplicate detection** by content hash — cheap and genuinely useful; the natural
  home is Week 5, where batch upload makes accidental re-uploads likely. Deferred
  from v1 only to keep Week 5 focused. `SHA-256` of the original, unique index,
  warn-don't-block.
- **Handwriting recognition** — the overview targets >85% accuracy on handwritten
  text. Tesseract does not get there on handwriting; this needs a cloud vision API
  with a specialized model, and the target should not be quoted until measured.
- **Custom model endpoints** for specialized invoice formats.

## Cloud OCR

Week 4 uses Tesseract.js locally. Google Cloud Vision and AWS Textract are deferred:
better accuracy, particularly on scans and tables, at per-page cost and with document
contents leaving the machine.

The Week 4 OCR module is written behind an interface so a cloud provider is a second
implementation. Textract in particular returns table structure directly, which would
substantially simplify `LINE_ITEMS` extraction — worth revisiting if line items prove
painful.

---

## Rejected, with reasons

Recorded so these do not get re-proposed as improvements.

| Rejected | Reason | Decision |
|---|---|---|
| Python / FastAPI backend | One language shares API types with the client | D1 |
| Fabric.js, Konva.js | Axis-aligned rectangles over a static image do not need a scene graph, and both fight normalized coordinates | D11 |
| `pdf2pic`, `pdf-poppler` | Require poppler + ImageMagick system binaries; break CI and fresh clones | D5 |
| `pdf-parse` | Unmaintained, with a known debug-path trap in its published entry point | D5 |
| Redux Toolkit | No async middleware needed; Zustand is smaller for this store | D10 |
| Pixel-based minimum region size | Cannot agree with a normalized server rule at more than one zoom level | D9 |
| `express.static` for `uploads/` | No exclusion pattern exists; fails open while looking correct | D14 |
| MIME-type-only upload validation | `Content-Type` is client-controlled | D15 |
