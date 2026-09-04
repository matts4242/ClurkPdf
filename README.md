# Intelligent Invoice Batch Processor

A browser-based tool for digitising paper and PDF invoices. Accounting teams
upload a batch, mark up the fields they care about, and export structured data.

The build follows the seven-week plan in [`Project_Overview/`](./Project_Overview),
one vertical slice at a time. **Week 1 is implemented: upload a PDF and view it
rendered in the browser.** Weeks 2 to 7 add region drawing, OCR, text-layer
extraction, batch queueing, templates, and export.

## Requirements

- Node.js 20 or newer (developed on 22)
- npm 10 or newer

No database, Docker, or system packages are needed for Week 1. PDF rendering
runs entirely on prebuilt npm packages.

## Setup

```bash
npm install          # installs root, server, and client dependencies
npm run dev          # starts both servers
```

Then open <http://localhost:5173>.

`npm run dev` prints both startup banners:

```
Server      http://localhost:3001
Client      http://localhost:5173
Uploads     <repo>/server/uploads
```

## Layout

```
client/     React 19 + TypeScript + Vite + Tailwind front end
server/     Express + TypeScript API
  uploads/  Uploaded PDFs and rendered page images (gitignored)
Project_Overview/  The week-by-week build specification
```

## Scripts

Run these from the repository root.

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the API and the Vite dev server together |
| `npm run build` | Type-checks and builds both packages |
| `npm test` | Runs the server test suite |
| `npm run typecheck` | Type-checks both packages without emitting |
| `npm start` | Runs the compiled API from `server/dist` |

Each package also runs on its own with `npm run dev` inside `client/` or
`server/`.

## Configuration

The server reads its settings from the environment. Copy
[`server/.env.example`](./server/.env.example) to `server/.env` to change any of
them; every value there is already the built-in default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3001` | API port |
| `UPLOADS_DIR` | `uploads` | Uploads root, relative to `server/` |
| `MAX_FILE_SIZE` | `10485760` | Largest accepted upload, in bytes |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Comma-separated allowed browser origins |
| `PAGE_DPI` | `150` | Resolution page images are rendered at |
| `THUMBNAIL_WIDTH` | `150` | Width of the page-1 preview, in pixels |

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
| `DELETE` | `/api/documents/:id` | Delete a document and its rendered pages |
| `GET` | `/api/health` | Liveness check |

Error codes: `FILE_TOO_LARGE` (413), `INVALID_FILE_TYPE` (415),
`NO_FILE_UPLOADED` (400), `INVALID_PDF` (422), `INVALID_REQUEST` (400),
`DOCUMENT_NOT_FOUND` (404), `PAGE_NOT_FOUND` (404), `FORBIDDEN` (403),
`PROCESSING_ERROR` (500), `INTERNAL_ERROR` (500).

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
npm test               # 28 tests: HTTP endpoints, PDF rendering, path safety
```

The suite starts a real server on an ephemeral port against a temporary uploads
directory, so it never touches `server/uploads`. Test PDFs are generated
byte-by-byte in `server/src/test/fixtures.ts`, so no binary fixtures are stored
in the repository.

## Notes on the Week 1 specification

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
- **Documents survive a page refresh.** The spec expected state to reset,
  but metadata is written beside each upload at `uploads/{id}/document.json` and
  reloaded at startup, so the browser lists what the server still holds. This is
  the interim store; Week 2 replaces it with PostgreSQL and Prisma.

## Security

- Uploads are validated for type and size before anything is written to disk,
  and are held in memory until accepted, so a rejected upload leaves nothing
  behind.
- Filenames are reduced to a conservative alphabet, and every path built from
  request input is checked to resolve inside the uploads root.
- Only rendered images are served from `/uploads`. The original PDF and the
  metadata sidecar sit in the same directory and return 403.
- Route parameters must be well-formed UUIDs before they reach the filesystem.
- Error responses carry a code and a message; stack traces stay on the server.
