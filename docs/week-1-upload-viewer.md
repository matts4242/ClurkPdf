# Week 1 — Upload, Storage, Database, Viewer

> Governed by [`00-decisions.md`](00-decisions.md). Decisions are referenced by ID
> and not restated here.

**Goal:** upload a PDF, persist it, render a page, view it in the browser.

**Phase 1 of 7.** No extraction yet — this week validates the ingest path and the
storage/database shape everything else builds on.

**Applies:** D1, D2, D3, D4, D5, D6, D7, D12, D14, D15

---

## What changed from the original Week 1

Four corrections, because building the original as written produces a broken week:

1. **Postgres is in scope now** (**D4**). The original had no database but specified
   a metadata endpoint and a status poll loop, which need server-side state.
2. **Upload is asynchronous** (**D7**). The original returned a finished document
   *and* documented a poll loop; only one of those can be true.
3. **10 MB → 25 MB** (**D2**), matching the product requirement.
4. **`pdf2pic` / `pdf-parse` → `pdfjs-dist` / `pdf-lib`** (**D5**), removing the
   undocumented system-binary prerequisites.

---

## Project structure

```
clurkpdf/
├── client/
│   ├── src/
│   │   ├── components/
│   │   │   ├── DocumentViewer.tsx
│   │   │   ├── FileDropzone.tsx
│   │   │   └── UploadProgress.tsx
│   │   ├── hooks/
│   │   │   └── useDocumentUpload.ts
│   │   ├── api/client.ts
│   │   ├── types/index.ts
│   │   └── App.tsx
│   ├── package.json
│   └── vite.config.ts
├── server/
│   ├── prisma/
│   │   └── schema.prisma          # Prisma default location
│   ├── src/
│   │   ├── config/limits.ts       # D2 — the only place limits are defined
│   │   ├── db/client.ts           # Prisma singleton
│   │   ├── storage/
│   │   │   ├── StorageAdapter.ts  # D3 — interface
│   │   │   └── LocalStorageAdapter.ts
│   │   ├── routes/documents.ts
│   │   ├── controllers/documentController.ts
│   │   ├── services/
│   │   │   ├── pdfService.ts
│   │   │   └── documentService.ts
│   │   ├── utils/errors.ts
│   │   ├── types/index.ts
│   │   └── index.ts
│   ├── docker-compose.yml         # local Postgres
│   ├── package.json
│   └── tsconfig.json
└── package.json                   # root, workspace scripts
```

Note `server/prisma/schema.prisma`, not `server/src/prisma/`. The original gave both
paths in different sections; this is Prisma's default and `prisma generate` finds it
with no configuration.

---

## Interface contracts

### API envelope

Every endpoint, success or failure:

```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

### Document

```typescript
type DocumentStatus = 'processing' | 'ready' | 'error';

interface Document {
  id: string;                 // UUID v4
  filename: string;           // storage name — always `${id}.pdf` (D15)
  originalName: string;       // as uploaded; display only, escape at render
  mimeType: string;
  size: number;               // bytes
  pageCount: number;          // 0 until rendering completes
  uploadPath: string;         // storage key, not a filesystem path (D3)
  status: DocumentStatus;
  errorMessage?: string;      // populated when status === 'error'
  userId: string | null;      // reserved, always null in v1 (D12)
  createdAt: string;          // ISO 8601
  updatedAt: string;
}
```

`'uploaded'` is gone from the original status union. It was indistinguishable from
`'processing'` — a row exists only after the upload succeeded, at which point
rendering has begun.

### Endpoints

```
POST   /api/documents/upload              → 202  { document }
GET    /api/documents/:id                 → 200  { document }
GET    /api/documents                     → 200  { documents, total }
GET    /api/documents/:id/pages/:n        → 200  image/png
GET    /api/documents/:id/thumbnail       → 200  image/png
GET    /api/documents/:id/original        → 200  application/pdf   (D14)
DELETE /api/documents/:id                 → 204
```

`DELETE` is here rather than deferred: without it, testing the upload path leaves
permanent junk on disk and in the database. It removes the row and the whole
`uploads/{id}/` prefix via `StorageAdapter.delete()`.

### Component props

```typescript
interface FileDropzoneProps {
  onFilesSelected: (files: File[]) => void;
  maxFileSize?: number;        // default: MAX_FILE_BYTES from shared config (D2)
  acceptedTypes?: string[];    // default: ['application/pdf']
  disabled?: boolean;
}

interface DocumentViewerProps {
  documentId: string;
  onError?: (error: Error) => void;
}

interface UploadProgressProps {
  fileName: string;
  progress: number;            // 0-100
  status: 'uploading' | 'processing' | 'complete' | 'error';
  errorMessage?: string;
  onCancel?: () => void;
}
```

`onPageChange` is removed from `DocumentViewerProps` — Week 1 renders page 1 only.
Page navigation arrives in Week 2 and the prop comes with it.

---

## Backend

### 1. Dependencies

```
express cors helmet morgan multer uuid zod
@prisma/client prisma
pdfjs-dist @napi-rs/canvas pdf-lib
typescript tsx nodemon @types/*
```

No system packages. `npm ci` is the complete setup (**D5**).

### 2. Limits (`config/limits.ts`)

```typescript
export const MAX_FILE_BYTES  = 26_214_400;   // 25 MiB  (D2)
export const MAX_BATCH_FILES = 50;
export const MAX_BATCH_BYTES = 104_857_600;  // 100 MiB
export const RENDER_DPI      = 150;          // D6
export const THUMB_WIDTH_PX  = 150;          // D6
```

The single source. Multer config, the validation layer and the client dropzone all
import from here — nothing hard-codes a limit.

### 3. Errors (`utils/errors.ts`)

```typescript
class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}
```

| Code | Status | When |
|---|---|---|
| `FILE_TOO_LARGE` | 413 | Exceeds `MAX_FILE_BYTES` |
| `INVALID_FILE_TYPE` | 415 | Extension or magic bytes fail (D15) |
| `INVALID_PDF` | 422 | `pdf-lib` cannot parse it |
| `DOCUMENT_NOT_FOUND` | 404 | No row, or `id` is not a UUID |
| `PAGE_NOT_FOUND` | 404 | `n < 1` or `n > pageCount` |
| `DOCUMENT_NOT_READY` | 409 | Page requested while `status === 'processing'` |
| `PROCESSING_ERROR` | 500 | Render failed |
| `STORAGE_ERROR` | 500 | Storage adapter failed |

Error messages never include filesystem paths or stack traces. Those go to the log
with a correlation ID; the response carries the ID.

### 4. Storage (`storage/`) — D3

```typescript
interface StorageAdapter {
  put(key: string, data: Buffer | NodeJS.ReadableStream): Promise<void>;
  get(key: string): Promise<NodeJS.ReadableStream>;
  delete(keyPrefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
```

`LocalStorageAdapter` roots at `UPLOADS_DIR`, creating it on startup. Keys are
`{documentId}/original.pdf`, `{documentId}/thumb.png`, `{documentId}/pages/{n}.png`.

Every key is resolved and then checked to be inside the root before any filesystem
call. No route, controller or service touches `fs` directly.

### 5. Database (**D4**)

```prisma
generator client { provider = "prisma-client-js" }
datasource db    { provider = "postgresql"; url = env("DATABASE_URL") }

model Document {
  id           String   @id @default(uuid())
  filename     String
  originalName String
  mimeType     String
  size         Int
  pageCount    Int      @default(0)
  uploadPath   String
  status       String   @default("processing")
  errorMessage String?
  userId       String?                        // D12 — reserved, null in v1
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@map("documents")
  @@index([status])
  @@index([createdAt])
  @@index([userId])
}
```

`docker-compose.yml` for local Postgres 14-alpine, and `DATABASE_URL` in
`server/.env`. `.env` is already gitignored; commit a `.env.example`.

Prisma client is a singleton in `db/client.ts` with a disconnect hook on shutdown.

### 6. PDF service (**D5**, **D6**)

```typescript
// Page count + structural validation. Throws INVALID_PDF.
async function inspectPdf(buffer: Buffer): Promise<{ pageCount: number }>

// Render one page at RENDER_DPI. Returns the storage key.
async function renderPage(documentId: string, pageNumber: number): Promise<string>

// Render page 1 at THUMB_WIDTH_PX. Returns the storage key.
async function renderThumbnail(documentId: string): Promise<string>
```

`renderPage` and `renderThumbnail` are separate functions producing separate files.
They were conflated in the original, which asked for 150px width and 150 DPI from the
same call.

Rendering uses `pdfjs-dist` into an `@napi-rs/canvas` surface, encoded as PNG.
Failures are caught, the document is marked `error` with a message, and partial
output is deleted.

### 7. Upload flow (**D7**, **D15**)

`POST /api/documents/upload`, `multipart/form-data`, field `file`:

1. Multer, memory storage, `limits.fileSize = MAX_FILE_BYTES`.
2. Extension check → `INVALID_FILE_TYPE`.
3. **Magic bytes** — buffer must start with `%PDF-` → `INVALID_FILE_TYPE`. This is
   the authoritative check; the declared MIME type is never trusted (**D15**).
4. `inspectPdf()` → page count, or `INVALID_PDF`.
5. Generate UUID. Store at `{id}/original.pdf`.
6. Insert row, `status: 'processing'`, `pageCount` from step 4.
7. **Respond `202 Accepted`** with the document.
8. *After the response:* render thumbnail and page 1, then set `status: 'ready'`.
   On failure, set `status: 'error'` with `errorMessage` and delete partial output.

Step 8 is a plain async call in Week 1. Week 5 replaces it with a BullMQ job. The API
contract does not change — that is the point of making upload async now rather than
retrofitting it later.

### 8. Page serving (**D14**)

`express.static` is **not** used for `uploads/`. `GET /api/documents/:id/pages/:n`:

1. Validate `:id` is a UUID and `:n` is a positive integer — reject before any I/O.
2. Load the document. Not found → 404. `status === 'processing'` → 409
   `DOCUMENT_NOT_READY`. `n > pageCount` → 404 `PAGE_NOT_FOUND`.
3. If the page is not rendered, render it now and cache it (lazy generation).
4. Stream with `Content-Type: image/png` and
   `Cache-Control: private, max-age=31536000, immutable` — page renders are immutable
   for a given document.

`/original` is a separate deliberate route. When auth arrives it is one route to
protect (**D12**).

### 9. Server (`index.ts`)

- JSON body parsing, CORS for `http://localhost:5173`, Helmet, Morgan
- Request IDs on every request, included in logs and error responses
- Global error handler: `AppError` → its status; anything else → 500 with a generic
  message, full detail logged
- Graceful shutdown: stop accepting connections, disconnect Prisma, exit
- Startup log: port, database connection state, uploads directory

---

## Frontend

### 1. Dependencies

`react react-dom typescript vite @vitejs/plugin-react tailwindcss postcss
autoprefixer axios react-dropzone lucide-react`

### 2. API client

Axios instance, base `http://localhost:3001/api`, 30s timeout. Response interceptor
unwraps `ApiResponse<T>` and throws a typed error on `success: false`, so callers see
either data or an exception — never a union to unpack at each call site.

### 3. `useDocumentUpload`

```typescript
interface UseDocumentUploadReturn {
  upload: (file: File) => Promise<string>;   // resolves to documentId
  progress: number;                          // 0-100
  status: 'idle' | 'uploading' | 'processing' | 'success' | 'error';
  error: string | null;
  cancel: () => void;
  reset: () => void;
}
```

- `onUploadProgress` drives `progress` during transfer
- On `202`, status becomes `processing` and polling begins
- Poll `GET /api/documents/:id`, backoff 500ms → 5000ms, giving up after 60s with a
  timeout error
- `AbortController` cancels both the upload and the poll; cleanup on unmount

This is the loop the original documented but made unreachable by returning a finished
document from upload (**D7**).

### 4. Components

**`FileDropzone`** — drag-active styling, accepted types and size shown from shared
config, selected file with remove, disabled during upload, inline rejection messages.

**`UploadProgress`** — progress bar; status badges (uploading blue, processing amber,
complete green, error red); cancel during upload; retry on error.

**`DocumentViewer`** — fetch metadata on mount; render page 1 from
`/pages/1`; loading skeleton; error state with retry; zoom 50/100/150/200%; drag-to-pan
when zoomed; metadata sidebar with original name, formatted size, page count and
upload date.

**`App`** — header, two columns: upload left, viewer right. Uploaded documents held
in an array; click to select which is displayed (**D10** — local state is correct
here; the store arrives in Week 5).

---

## Error handling

**Client:**
- Toast on failure; the message from `error.code`, never a raw exception
- Retry with backoff, max 3, on network errors only — not on 4xx
- Offline indicator via `navigator.onLine`
- Submit disabled while a request is in flight
- Poll timeout surfaces as a real error, not an indefinite spinner

**Server:** every handler wrapped so rejected promises reach the error middleware
rather than crashing the process.

---

## Acceptance criteria

Environment:
1. [ ] `docker-compose up -d` starts Postgres
2. [ ] `npx prisma migrate dev` creates the `documents` table
3. [ ] `npm run dev` from root starts both client and server
4. [ ] `npm ci` on a clean machine needs no system packages (**D5**)

Upload:
5. [ ] Drag-drop a PDF; progress bar advances
6. [ ] Response is `202` with `status: 'processing'`
7. [ ] Viewer shows "Processing", then the page appears without a manual refresh
8. [ ] A row exists in `documents` with the correct `pageCount`
9. [ ] `uploads/{id}/` contains `original.pdf`, `thumb.png`, `pages/1.png`
10. [ ] Restart the server — the document is still listed and viewable (**D4**)

Viewing:
11. [ ] Page 1 renders legibly at 150 DPI
12. [ ] Zoom controls work; pan works when zoomed
13. [ ] Metadata sidebar shows the correct original name, size and page count
14. [ ] Upload several PDFs and switch between them

Validation:
15. [ ] A 26 MB file is rejected with `FILE_TOO_LARGE` (**D2**)
16. [ ] A 20 MB file is accepted (**D2** — the original would have rejected it)
17. [ ] A `.txt` renamed to `.pdf` is rejected with `INVALID_FILE_TYPE` (**D15**)
18. [ ] A truncated PDF is rejected with `INVALID_PDF`

Security:
19. [ ] `GET /uploads/{id}/original.pdf` returns 404 — no static mount (**D14**)
20. [ ] `GET /api/documents/../../etc/passwd` returns 404 on UUID validation
21. [ ] `GET /api/documents/{id}/pages/9999` returns `PAGE_NOT_FOUND`
22. [ ] A file named `../../evil.pdf` is stored as `{uuid}.pdf` (**D15**)

Cleanup:
23. [ ] `DELETE /api/documents/:id` removes the row and the whole directory

---

## Notes for Week 2

- The `Region` model joins `Document`; no migration guide is needed because the
  database already exists (**D4**)
- `DocumentViewerProps` gains `onPageChange` when page navigation arrives
- Page renders are already lazy and cached — multi-page navigation needs no new
  server work
- `StorageAdapter` stays the only filesystem access path
