# Intelligent Invoice Batch Processor

A browser-based tool for digitising paper and PDF invoices. Accounting teams
upload a batch, mark up the fields they care about, and export structured data.

The build follows the seven-week plan in [`Project_Overview/`](./Project_Overview),
one vertical slice at a time. **Weeks 1 to 4 are implemented: upload a PDF,
view it rendered in the browser, mark up the fields you care about — either by
drawing regions and running OCR, or by highlighting the document's own text —
and edit the results.** Weeks 5 to 7 add batch queueing, templates, and export.

## Requirements

- Node.js 22.13 or newer (developed on 22.22; CI covers 22.x and 24.x)
- npm 10 or newer
- PostgreSQL 14 or newer — `docker compose up -d` provides one

The Node floor comes from `pdfjs-dist`, which requires 22.13. Node 20 cannot
run this project. PDF rendering needs no system packages; it runs entirely on
prebuilt npm packages.

## Setup

```bash
docker compose up -d          # PostgreSQL on :5432, dev and test databases
cp server/.env.example server/.env
npm install                   # root, server, and client dependencies
npm run db:migrate            # create the schema
npm run dev                   # start both servers
```

Then open <http://localhost:5173>.

`npm run dev` prints both startup banners:

```
Server      http://localhost:3001
Client      http://localhost:5173
Uploads     <repo>/server/uploads
Database    postgresql://invoice:***@127.0.0.1:5432/invoice_processor
```

Already have PostgreSQL? Skip `docker compose` and point `DATABASE_URL` and
`TEST_DATABASE_URL` in `server/.env` at your own server. The test database must
exist and its name must end in `_test`.

## Deployment

On any Linux host with Docker — a Hostinger VPS, for instance — the whole stack
comes up with one command:

```bash
git clone https://github.com/matts4242/ClurkPdf.git && cd ClurkPdf
./scripts/deploy.sh                        # http, on the machine's IP address
./scripts/deploy.sh invoices.example.com   # https, certificate from Caddy
```

That builds three containers — Caddy serving the client and proxying the API,
the Node server, and PostgreSQL — applies the migrations, and waits for the API
to report healthy. [`DEPLOY.md`](./DEPLOY.md) covers sizing, firewalls,
updates, backups and the settings in `deploy/env.example`.

## Layout

```
client/     React 19 + TypeScript + Vite + Tailwind front end
server/     Express + TypeScript API
  prisma/   Schema and migrations
  uploads/  Uploaded PDFs and rendered page images (gitignored)
deploy/     Production images, Caddy config, deployment settings
scripts/    Database bootstrap for docker-compose, deployment script
Project_Overview/  The week-by-week build specification
```

## Scripts

Run these from the repository root.

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the API and the Vite dev server together |
| `npm run build` | Type-checks and builds both packages |
| `npm test` | Runs both test suites (server needs the test database) |
| `npm run test:server` / `npm run test:client` | One suite at a time |
| `npm run typecheck` | Type-checks both packages without emitting |
| `npm run db:migrate` | Creates and applies a migration from the schema |
| `npm run db:deploy` | Applies existing migrations (use in deployment) |
| `npm start` | Runs the compiled API from `server/dist` |
| `npm run deploy` | Builds and starts the production stack (see [`DEPLOY.md`](./DEPLOY.md)) |

Each package also runs on its own with `npm run dev` inside `client/` or
`server/`.

## Configuration

The server reads its settings from the environment. Copy
[`server/.env.example`](./server/.env.example) to `server/.env` to change any of
them; every value there is already the built-in default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | none, **required** | PostgreSQL connection string |
| `TEST_DATABASE_URL` | see `.env.example` | Database used by `npm test`; name must end in `_test` |
| `DATABASE_POOL_SIZE` | `10` | Maximum database connections |
| `PORT` | `3001` | API port |
| `UPLOADS_DIR` | `uploads` | Uploads root, relative to `server/` |
| `MAX_FILE_SIZE` | `10485760` | Largest accepted upload, in bytes |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Comma-separated allowed browser origins |
| `PAGE_DPI` | `150` | Resolution page images are rendered at |
| `THUMBNAIL_WIDTH` | `150` | Width of the page-1 preview, in pixels |
| `OCR_LANGUAGE` | `eng` | Tesseract language, e.g. `eng+deu` |
| `OCR_CACHE_DIR` | `.tesseract-cache` | Where the ~5MB language file is kept |
| `OCR_CONCURRENCY` | `2` | Regions recognised at once |
| `OCR_TIMEOUT_MS` | `30000` | Give up on one region after this long |
| `OCR_MIN_CROP_WIDTH` | `1000` | Narrower crops are upscaled before recognition |

The client reads `VITE_SERVER_ORIGIN`, defaulting to `http://localhost:3001`,
and `VITE_PAGE_DPI`, which must match the server's `PAGE_DPI` so that 100% zoom
shows the page at its true size.

## API

Every endpoint answers with the same envelope, success or failure.

```jsonc
{ "success": true,  "data": { } }
{ "success": false, "error": { "code": "FILE_TOO_LARGE", "message": "...", "details": { } } }
```

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/documents/upload` | Upload one PDF as `multipart/form-data` under the field `file` |
| `GET` | `/api/documents` | List stored documents, newest first |
| `GET` | `/api/documents/:id` | Document metadata |
| `GET` | `/api/documents/:id/pages/:n` | Page `n` as PNG, rendered on demand |
| `DELETE` | `/api/documents/:id` | Delete a document, its regions, and its rendered pages |
| `GET` | `/api/documents/:id/regions` | Every region on a document |
| `GET` | `/api/documents/:id/regions/page/:n` | Regions on page `n` |
| `POST` | `/api/documents/:id/regions` | Create a region |
| `PUT` | `/api/documents/:id/regions/:regionId` | Move, resize, or retype a region |
| `DELETE` | `/api/documents/:id/regions/:regionId` | Delete a region |
| `POST` | `/api/documents/:id/ocr` | Read the text inside the document's regions |
| `GET` | `/api/documents/:id/text-layer/:n` | The page's own text, with positions |
| `GET` | `/api/health` | Liveness check |

`GET /api/documents/:id` also returns `regionCount` and `pagesWithRegions`.

Error codes: `FILE_TOO_LARGE` (413), `INVALID_FILE_TYPE` (415),
`NO_FILE_UPLOADED` (400), `INVALID_PDF` (422), `INVALID_REQUEST` (400),
`DOCUMENT_NOT_FOUND` (404), `PAGE_NOT_FOUND` (404), `FORBIDDEN` (403),
`PROCESSING_ERROR` (500), `INTERNAL_ERROR` (500), `REGION_NOT_FOUND` (404),
`REGION_OUT_OF_BOUNDS` (400), `INVALID_DIMENSIONS` (400), `INVALID_PAGE` (400),
`INVALID_FIELD_TYPE` (400).

### OCR

`POST /api/documents/:id/ocr` recognises the text inside a document's regions.
With an empty body it processes every region; pass `regionIds` to redo a
subset, or `onlyPending: true` to skip regions that already have text.

```jsonc
{ "results": [ { "regionId": "...", "status": "DONE", "text": "INV-2026-0042", "confidence": 91 } ],
  "succeeded": 1, "failed": 0 }
```

Each region is cropped out of the rendered page and passed to Tesseract on its
own, rather than reading the whole page and matching text back to boxes. That
keeps neighbouring fields from bleeding into a result. Crops narrower than
`OCR_MIN_CROP_WIDTH` are upscaled first, because pages render at 150dpi and
Tesseract is tuned for roughly 300.

A failure is recorded against the one region that failed, as
`ocrStatus: "ERROR"` with a message; the rest of the run continues.

**Raw text and corrections are separate.** `rawText` is what OCR read and is
never overwritten by a person. An edit is stored as `correctedText`, so the
original stays available to compare against and revert to. Send
`correctedText` to `PUT .../regions/:regionId`; an empty string clears it.

**Moving or resizing a region discards its text.** The rectangle then covers
different pixels, so the stored reading — and any correction of it — no longer
describes it. An OCR region returns to `PENDING` and waits for another run; a
text-layer region re-reads itself immediately, since its words are already in
the PDF. Changing only the field type leaves the text alone either way.

### Text layer

`GET /api/documents/:id/text-layer/:n` returns the page's own text runs with
positions normalised the same way regions are, so the two line up exactly:

```jsonc
{ "pageNumber": 1, "pageWidth": 612, "pageHeight": 792, "hasText": true,
  "textItems": [ { "text": "Invoice No: INV-2026-0042",
                   "x": 0.6536, "y": 0.1073, "width": 0.2365, "height": 0.0152,
                   "fontSize": 12 } ] }
```

`hasText: false` means the page is a scan; there is nothing to highlight and
the OCR path is the one to use.

**Two ways to capture a field, one kind of region.** Draw a box and run OCR, or
highlight the document's own text. Highlighting sets `textSource: "TEXT_LAYER"`
and the server fills the text immediately at 100% confidence, because it is the
document's text rather than a guess. Everything downstream — the sidebar, the
correction panel, and the export Week 7 adds — treats both identically.

**Highlighting snaps to whole runs.** pdf.js reports a line as a single run, so
a selection of a few characters covers only a fraction of it. A run counts as
selected when the rectangle covers most of its height and overlaps it
horizontally at all, which is the "expand to word and line boundaries" the spec
asks for: touch a line anywhere and you capture the whole field, while the line
above and the neighbouring column stay out. The stored rectangle is then snapped
onto the text it captured, so the box matches the value.

Because the text comes from the rectangle rather than from the browser, moving a
text-layer region simply **re-reads** it at its new position instead of dropping
back to `PENDING` the way an OCR region must.

### Regions

A region is a rectangle over part of a page, tagged with what it contains
(`INVOICE_NUMBER`, `TOTAL`, `CUSTOM`, and so on). Coordinates are normalised to
0-1 against the page rather than stored in pixels, so a region drawn at 50% zoom
covers exactly the same content at 400% and survives any change to
`PAGE_DPI`.

Writes are validated on both axes: the rectangle must have positive area, and
its far edge as well as its origin must lie within the page. An update
validates the rectangle *after* the merge, so sending only a wider `width`
cannot push a region off the page. A region id is always looked up together
with its document id, so one document's URL can never reach another's regions.

### Upload lifecycle

The upload responds as soon as the PDF is stored and parsed, with
`status: "processing"`. Page 1 renders in the background and the status becomes
`ready`. The client polls `GET /api/documents/:id` with exponential backoff,
starting at 500ms and capping at 5s.

A PDF that will not parse is rejected synchronously with `INVALID_PDF` and
nothing is written to disk. A PDF that parses but fails to render leaves the
document at `status: "error"` with a message, since the upload itself succeeded.

## Testing

```bash
npm test               # 95 tests
```

- **Server (80)** — HTTP endpoints, PDF rendering, region validation and
  ownership, OCR, text-layer extraction and snapping, cascade deletes, and
  path-traversal defences. Each test runs against a real server on an ephemeral
  port and a real database.
- **Client (15)** — the coordinate maths, including that a region covers the
  same content at every zoom level.

The OCR tests run Tesseract for real against a generated invoice whose text the
fixture chooses, so recognition is measured rather than stubbed. The first run
downloads the language data; CI caches it.

The server suite starts from an empty schema: migrations are applied once, then
every test truncates. Two guards keep that away from real data. `DATABASE_URL`
is set explicitly for the run, and `process.loadEnvFile` never overrides an
already-set variable, so `server/.env` cannot redirect a test run onto the
development database. On top of that the suite refuses to start unless the
database name ends in `_test`. The uploads root is likewise a fresh temp
directory per run, so `server/uploads` is never touched.

Test PDFs are generated byte-by-byte in `server/src/test/fixtures.ts`, so no
binary fixtures are stored in the repository.

## Notes on the specification

### Week 4

- **Highlighting stores a region, not a separate entity.** The spec sketches a
  `DocumentAttribute` alongside regions. Using one `Region` with a `textSource`
  of `OCR` or `TEXT_LAYER` means the sidebar, corrections and export all work
  the same whichever mode produced the value, instead of two parallel paths.
- **The server derives the text from the rectangle rather than trusting the
  browser's selection string.** That is what lets a moved region re-read itself,
  and it removes any chance of the stored text drifting from the stored box.
- **Snapping falls out of the native caret.** Because the overlay holds real
  selectable text, double-click for a word and triple-click for a line come from
  the browser, so no bespoke snapping code was needed.

### Week 3

- **The OCR endpoint takes region ids, not raw rectangles.** The spec's version
  accepted `{ regions: [{pageNumber, x, y, ...}] }`, but since Week 2 the
  regions already live in the database, and the same spec asks for results to be
  saved back to those rows. Taking ids makes that unambiguous.
- **Recognition is bounded, not an unbounded `Promise.all`.** Each job holds a
  WASM instance, so a large batch would otherwise try to start one per region at
  once. Regions run `OCR_CONCURRENCY` at a time against a shared worker pool.

### Week 2

- **Prisma 7 no longer takes the connection URL in `schema.prisma`.** The
  spec's schema block sets `url = env("DATABASE_URL")`, which Prisma 7 rejects.
  Migration commands now read it from [`server/prisma.config.ts`](./server/prisma.config.ts),
  and the runtime client connects through the `@prisma/adapter-pg` driver
  adapter in [`server/src/db/client.ts`](./server/src/db/client.ts).
- **Documents moved into PostgreSQL.** Week 1's JSON sidecars are gone;
  uploads created before this change are not carried over. The PDFs and
  rendered pages still live on disk under `uploads/{id}/` — only metadata moved.
- **`.env` is now actually loaded**, via Node's built-in `process.loadEnvFile`.
  Week 1 documented the file but nothing read it.

### Week 1

Three deliberate departures from [`Project_Overview/Week 1.1 Code`](./Project_Overview):

- **PDF rendering uses `pdfjs-dist` and `@napi-rs/canvas`, not `pdf2pic` or
  `pdf-poppler`.** Both suggested libraries shell out to GraphicsMagick,
  Ghostscript, or the poppler binaries, which means a system dependency outside
  npm, and `pdf-poppler` ships no working Linux build. The pdf.js path renders
  the same pages from prebuilt npm packages alone, so `npm install` is the whole
  setup story, and it reuses the engine Week 4's text extraction needs anyway.
  `pdf-parse` is likewise unnecessary, since pdf.js already reports page counts.
- **Document IDs come from `node:crypto`'s `randomUUID`, not the `uuid`
  package.** It is the same UUID v4 with one fewer dependency.
- **Documents survive a page refresh.** The spec expected state to reset. Week 1
  achieved this with a JSON sidecar beside each upload; Week 2 replaced that
  with PostgreSQL, and the browser still lists what the server holds.

## Security

- Uploads are validated for type and size before anything is written to disk,
  and are held in memory until accepted, so a rejected upload leaves nothing
  behind.
- Filenames are reduced to a conservative alphabet, and every path built from
  request input is checked to resolve inside the uploads root.
- Only rendered images are served from `/uploads`. The original PDF and the
  metadata sidecar sit in the same directory and return 403.
- Route parameters must be well-formed UUIDs before they reach the filesystem.
- Region reads and writes are scoped by document id, so one document's URL
  cannot reach another's regions.
- Error responses carry a code and a message; stack traces stay on the server.
