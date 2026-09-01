# Week 5 — Batch Queue & Progress

> Governed by [`00-decisions.md`](00-decisions.md).

**Goal:** upload many documents at once, process them in the background, and watch
progress in a grid.

**Phase 5 of 7.** Weeks 1–4 handle one document at a time. This is where the primary
persona's actual problem — 50 to 200 invoices a week — becomes addressable.

**Applies:** D2, D3, D6, D7, D10, D15

---

## Structure

```
client/src/
  store/
    batchStore.ts             # NEW: Zustand (D10)
  components/
    BatchUpload.tsx           # NEW
    DocumentGrid.tsx          # NEW
    QueueStatus.tsx           # NEW
  hooks/
    useBatchProgress.ts       # NEW: WebSocket subscription
server/src/
  queue/
    connection.ts             # NEW: Redis
    documentQueue.ts          # NEW: BullMQ queue + worker
    jobs/
      renderDocument.ts       # NEW: moved out of the upload handler
      classifyDocument.ts     # NEW
      ocrDocument.ts          # NEW
  ws/server.ts                # NEW
  controllers/batchController.ts
```

---

## Interface contracts

### Batch

```typescript
type BatchStatus = 'uploading' | 'processing' | 'review' | 'complete' | 'failed';

interface Batch {
  id: string;
  name: string;                // defaults to "Batch <local datetime>"
  status: BatchStatus;
  documentCount: number;
  completedCount: number;
  failedCount: number;
  userId: string | null;       // D12
  createdAt: string;
  updatedAt: string;
}
```

A batch is a first-class row, not a client-side grouping. The overview's pipeline —
Uploaded → Processing → Review → Exported — needs somewhere to live, and Week 7
exports per batch.

### Jobs

```typescript
type JobType = 'render' | 'classify' | 'ocr';

interface DocumentJob {
  documentId: string;
  batchId: string;
  type: JobType;
}

interface JobProgress {
  documentId: string;
  batchId: string;
  type: JobType;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;            // 0-100 within this job
  message?: string;
  error?: { code: string; message: string };
}
```

Three job types rather than one monolith. Render must finish before classify; classify
decides whether OCR runs at all. Separate jobs mean a failure is attributable, and a
retry re-runs only the failed stage.

### Endpoints

```
POST /api/batches                     → { batch }
POST /api/batches/:id/documents       → 202 { documents }   multipart, many files
GET  /api/batches/:id                 → { batch, documents }
GET  /api/batches                     → { batches, total }
POST /api/batches/:id/retry           → 202 { retriedCount }
DELETE /api/batches/:id               → 204
WS   /ws/batches/:id                  → JobProgress stream
```

### WebSocket protocol

Server → client:

```typescript
type ServerMessage =
  | { type: 'job.progress';  payload: JobProgress }
  | { type: 'batch.updated'; payload: Batch }
  | { type: 'document.ready'; payload: { documentId: string; pageCount: number } }
  | { type: 'error';         payload: { code: string; message: string } };
```

Client → server: `{ type: 'subscribe', batchId }` on open. Heartbeat ping every 30s;
a client missing two consecutive pongs is dropped.

**The WebSocket is an optimization, never the source of truth.** The client reconciles
against `GET /api/batches/:id` on connect, on reconnect, and every 30s while
connected. A dropped socket must not leave a permanently stale grid.

---

## Database

```prisma
model Batch {
  id        String   @id @default(uuid())
  name      String
  status    String   @default("uploading")
  userId    String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  documents Document[]

  @@map("batches")
  @@index([status])
  @@index([createdAt])
}
```

`Document` gains `batchId String?` (nullable — Weeks 1–4 documents have no batch) plus
an index, and `contentHash String?` for duplicate detection.

Batch counters are **derived, not stored as authoritative**. `completedCount` is
computed from document statuses on read and cached on the row for the grid. A counter
incremented by concurrent workers drifts; a count that can be recomputed cannot.

---

## Backend

### Queue (BullMQ + Redis)

`docker-compose.yml` gains `redis:7-alpine`. Add `REDIS_URL` to `.env.example`.

```typescript
const documentQueue = new Queue<DocumentJob>('documents', { connection });

const worker = new Worker<DocumentJob>('documents', processJob, {
  connection,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
});
```

Job options:

- `attempts: 3`, exponential backoff from 2s
- `removeOnComplete: { age: 3600, count: 1000 }`, `removeOnFail: { age: 86400 }` —
  without these Redis grows without bound
- `jobId: '{documentId}:{type}'` — idempotent. A double-submitted upload does not
  render the same document twice.

**Concurrency is bounded twice.** BullMQ's `concurrency` limits documents in flight;
Week 4's worker pool limits OCR workers within a document. Without both, four
concurrent documents × four Tesseract workers is sixteen WASM instances.

### Job chain

`render` → `classify` → `ocr` (conditional):

1. **`render`** — page count, `thumb.png`, `pages/1.png` (**D6**). Sets `status:
   'ready'`. This is Week 1's post-response work (**D7**) moved into a job; the upload
   API contract is unchanged, which is why **D7** made upload async in Week 1.
2. **`classify`** — Week 3's classifier per page; stores `pageClass` per page.
3. **`ocr`** — enqueued only for pages classified `scanned` **and** only when the
   document has regions (from a template, Week 6). A scanned page with no regions has
   nothing to read yet and waits for the user.

Progress is emitted at each transition and on meaningful sub-steps within render.

### Batch upload (**D2**, **D15**)

`POST /api/batches/:id/documents`:

1. Reject if `files.length > MAX_BATCH_FILES` → `BATCH_TOO_LARGE`
2. Reject if total bytes > `MAX_BATCH_BYTES` → `BATCH_TOO_LARGE`
3. Per file, per-file validation from Week 1 (magic bytes, size, parseability)
4. **Invalid files do not fail the batch.** They are recorded as `status: 'error'`
   with a reason and reported in the response. Rejecting 50 files because one is
   corrupt is the wrong behaviour for the primary use case.
5. Compute SHA-256; if a document with that hash exists in the batch, mark
   `duplicate` and skip the job — warn, do not block
6. Enqueue `render` per accepted document
7. Respond `202` with every document row, valid and invalid alike

Uploads stream to storage rather than buffering — 50 × 25 MB in memory at once is
1.25 GB. Multer uses disk storage here, not memory storage as in Week 1's single-file
path.

### WebSocket server

`ws` on the same HTTP server. One connection per batch view; the queue's event
listeners fan out to subscribers of that batch. No per-document sockets — 50 documents
would mean 50 connections.

On the last document reaching a terminal state, the batch moves to `review` (or
`failed` if all failed) and a `batch.updated` is emitted.

---

## Frontend

### Zustand (**D10**)

The trigger from **D10** arrives here: queue state is read by the grid, the queue
status bar, the viewer header and the export button, which do not share a parent.

```typescript
interface BatchState {
  batch: Batch | null;
  documents: Map<string, Document>;
  progress: Map<string, JobProgress>;
  connected: boolean;

  setBatch: (b: Batch) => void;
  applyProgress: (p: JobProgress) => void;
  reconcile: (b: Batch, docs: Document[]) => void;   // authoritative REST refresh
}
```

One store, one batch at a time. `reconcile` overwrites optimistic socket state with
server truth.

### `BatchUpload`

Multi-file dropzone showing the limits from shared config (**D2**). Per-file rows with
progress. Client-side pre-checks for count and total size, so 60 files are rejected
before uploading any. Rejected files listed inline with reasons, accepted ones
proceeding regardless.

### `DocumentGrid`

Thumbnail grid (**D6** — `thumb.png`, which is what it exists for):

- Status badge per card: queued, processing, ready, review, error, duplicate
- Progress ring during processing
- Extraction count once ready
- Click to open the viewer for that document
- Filter by status; sort by name, upload time, or status
- Virtualized — 50 cards at 150px is fine, but this list grows

Error cards show the reason and a retry. Duplicate cards are visually distinct and
still openable.

### `QueueStatus`

Persistent bar: "12 of 50 complete, 3 failed", overall progress, connection state, and
a retry-failed action. Connection state matters — a user watching a stalled bar should
be able to see the socket dropped.

### `useBatchProgress`

Subscribes on mount, applies messages to the store, reconciles via REST on connect and
every 30s. Reconnects with exponential backoff, capped at 30s, and reconciles on every
successful reconnect. Unsubscribes on unmount.

---

## Errors

| Code | Status | When |
|---|---|---|
| `BATCH_TOO_LARGE` | 413 | > 50 files or > 100 MB (**D2**) |
| `BATCH_NOT_FOUND` | 404 | No such batch |
| `BATCH_NOT_READY` | 409 | Action requires a terminal state |
| `QUEUE_UNAVAILABLE` | 503 | Redis unreachable |
| `NO_FAILED_DOCUMENTS` | 400 | Retry with nothing to retry |

`QUEUE_UNAVAILABLE` is explicit: when Redis is down, uploads must fail loudly rather
than accepting files that will never be processed.

---

## Acceptance criteria

Setup:
1. [ ] `docker-compose up -d` starts Postgres and Redis
2. [ ] Worker starts and logs its concurrency
3. [ ] Redis down → uploads return `QUEUE_UNAVAILABLE`, not a silent accept

Upload:
4. [ ] 50 PDFs upload in one action (**D2**)
5. [ ] 51 files are rejected client-side before any transfer
6. [ ] Total over 100 MB is rejected with `BATCH_TOO_LARGE`
7. [ ] One corrupt file among 20 does not fail the other 19
8. [ ] Invalid files appear as error cards with reasons
9. [ ] The same file twice is flagged `duplicate`, not processed twice
10. [ ] Uploads stream to disk; memory does not grow with batch size

Queue:
11. [ ] Each document enqueues `render`
12. [ ] Jobs run at the configured concurrency, not all at once
13. [ ] `classify` runs after `render`
14. [ ] `ocr` is enqueued only for scanned pages with regions
15. [ ] A failed job retries 3 times with backoff, then marks the document `error`
16. [ ] Re-submitting the same document does not duplicate the job (idempotent id)
17. [ ] Completed jobs are cleaned from Redis

Progress:
18. [ ] The grid updates live without a refresh
19. [ ] Progress rings advance during processing
20. [ ] Thumbnails appear as each render completes
21. [ ] The status bar counts complete and failed correctly
22. [ ] The batch moves to `review` when the last document finishes

Resilience:
23. [ ] Killing the socket shows a disconnected indicator
24. [ ] It reconnects with backoff and reconciles missed state (**not** a stale grid)
25. [ ] Restarting the server mid-batch resumes queued jobs from Redis
26. [ ] Batch counters recomputed from documents match the displayed values
27. [ ] Retry-failed re-enqueues only failed documents

Integration:
28. [ ] Clicking a card opens the viewer for that document
29. [ ] Extraction from Weeks 3–4 works on batch-uploaded documents
30. [ ] Single-document upload from Week 1 still works with no batch (**nullable
        `batchId`**)
31. [ ] 50 documents process without exhausting memory
32. [ ] Throughput is recorded — documents per minute at the configured concurrency

---

## Notes for Week 6

- Templates apply at the `classify` stage: a matched template's regions are created
  before `ocr` is enqueued, which is what makes fully unattended processing possible
- The job chain gains a `match-template` stage between classify and ocr
- Batch-level "apply template to all" reuses the queue rather than looping in the
  client
- The store already holds every document in the batch, which is what the similarity
  grouping UI needs
