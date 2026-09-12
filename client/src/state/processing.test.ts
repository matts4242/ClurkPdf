import { describe, expect, it } from 'vitest';
import {
  applyProcessingEvent,
  firstReady,
  initialState,
  type ProcessingState,
} from './processing';
import type {
  BatchWithProgress,
  Document,
  DocumentStatus,
  ProcessingEvent,
} from '../types';

/**
 * The event fold, tested where it can be: as a pure function.
 *
 * These are the cases a live WebSocket produces and a happy-path click-through
 * never does — a reconnect replaying events, a progress frame overtaken by the
 * completion it precedes, an event about a document this client has not seen.
 */

const document = (over: Partial<Document> = {}): Document => ({
  id: 'd1',
  filename: 'invoice.pdf',
  originalName: 'invoice.pdf',
  mimeType: 'application/pdf',
  size: 1024,
  pageCount: 1,
  uploadPath: 'd1/original.pdf',
  createdAt: '2026-03-14T09:00:00.000Z',
  status: 'queued',
  progress: 0,
  ...over,
});

const batch = (over: Partial<BatchWithProgress> = {}): BatchWithProgress => ({
  id: 'b1',
  name: '2 files · 09:00',
  status: 'processing',
  createdAt: '2026-03-14T09:00:00.000Z',
  updatedAt: '2026-03-14T09:00:00.000Z',
  documentCount: 2,
  counts: { queued: 1, processing: 1, ready: 0, error: 0 },
  progress: 20,
  detectedFieldCount: 0,
  ...over,
});

const stateWith = (documents: Document[]): ProcessingState => ({
  ...initialState,
  documents,
});

/** Fold a run of events, as the socket delivers them. */
const applyAll = (start: ProcessingState, events: ProcessingEvent[]): ProcessingState =>
  events.reduce(applyProcessingEvent, start);

const statusOf = (state: ProcessingState, id: string): DocumentStatus | undefined =>
  state.documents.find((d: Document) => d.id === id)?.status;

const progressOf = (state: ProcessingState, id: string): number | undefined =>
  state.documents.find((d: Document) => d.id === id)?.progress;

describe('document.queued', () => {
  it('adds an unknown document at the front', () => {
    const state = applyProcessingEvent(stateWith([document({ id: 'old' })]), {
      type: 'document.queued',
      batchId: 'b1',
      document: document({ id: 'new' }),
    });

    expect(state.documents.map((d: Document) => d.id)).toEqual(['new', 'old']);
  });

  it('merges into a document already known, keeping its position', () => {
    const state = applyAll(stateWith([document({ id: 'a' }), document({ id: 'b' })]), [
      { type: 'document.queued', batchId: 'b1', document: document({ id: 'b' }) },
    ]);

    expect(state.documents.map((d: Document) => d.id)).toEqual(['a', 'b']);
    expect(state.documents).toHaveLength(2);
  });
});

describe('document.progress', () => {
  it('moves a queued document into processing', () => {
    const state = applyProcessingEvent(stateWith([document({ id: 'd1' })]), {
      type: 'document.progress',
      batchId: 'b1',
      documentId: 'd1',
      progress: 40,
    });

    expect(statusOf(state, 'd1')).toBe('processing');
    expect(progressOf(state, 'd1')).toBe(40);
  });

  it('ignores a frame that would move the bar backwards', () => {
    const state = applyAll(stateWith([document({ id: 'd1' })]), [
      { type: 'document.progress', batchId: 'b1', documentId: 'd1', progress: 80 },
      // Arrives late, from earlier in the same job.
      { type: 'document.progress', batchId: 'b1', documentId: 'd1', progress: 27 },
    ]);

    expect(progressOf(state, 'd1')).toBe(80);
  });

  it('does not reopen a document the queue has finished', () => {
    const state = applyAll(stateWith([document({ id: 'd1' })]), [
      {
        type: 'document.ready',
        batchId: 'b1',
        document: document({ id: 'd1', status: 'ready', progress: 100 }),
        detectedFields: 4,
      },
      { type: 'document.progress', batchId: 'b1', documentId: 'd1', progress: 80 },
    ]);

    expect(statusOf(state, 'd1')).toBe('ready');
    expect(progressOf(state, 'd1')).toBe(100);
  });

  it('does not reopen a document that failed', () => {
    const state = applyAll(stateWith([document({ id: 'd1' })]), [
      { type: 'document.error', batchId: 'b1', documentId: 'd1', message: 'boom' },
      { type: 'document.progress', batchId: 'b1', documentId: 'd1', progress: 90 },
    ]);

    expect(statusOf(state, 'd1')).toBe('error');
  });

  it('ignores a document it has never seen rather than inventing one', () => {
    const before = stateWith([document({ id: 'd1' })]);
    const after = applyProcessingEvent(before, {
      type: 'document.progress',
      batchId: 'b1',
      documentId: 'unknown',
      progress: 50,
    });

    // Identity, not just equality: nothing changed, so nothing re-renders.
    expect(after).toBe(before);
  });

  it('still starts a queued document on a 0% frame', () => {
    // The job's first announcement is 0%, and a queued document is also at 0.
    const state = applyProcessingEvent(stateWith([document({ id: 'd1', progress: 0 })]), {
      type: 'document.progress',
      batchId: 'b1',
      documentId: 'd1',
      progress: 0,
    });

    expect(statusOf(state, 'd1')).toBe('processing');
  });

  it('returns the same state when the progress has not moved', () => {
    const before = applyProcessingEvent(stateWith([document({ id: 'd1' })]), {
      type: 'document.progress',
      batchId: 'b1',
      documentId: 'd1',
      progress: 50,
    });
    const after = applyProcessingEvent(before, {
      type: 'document.progress',
      batchId: 'b1',
      documentId: 'd1',
      progress: 50,
    });

    expect(after).toBe(before);
  });
});

describe('document.ready', () => {
  it('records the document and how many fields were found', () => {
    const state = applyProcessingEvent(stateWith([document({ id: 'd1' })]), {
      type: 'document.ready',
      batchId: 'b1',
      document: document({ id: 'd1', status: 'ready', progress: 100 }),
      detectedFields: 6,
    });

    expect(statusOf(state, 'd1')).toBe('ready');
    expect(state.detectedFields.d1).toBe(6);
  });

  it('is idempotent when a reconnect replays it', () => {
    const event: ProcessingEvent = {
      type: 'document.ready',
      batchId: 'b1',
      document: document({ id: 'd1', status: 'ready', progress: 100 }),
      detectedFields: 6,
    };
    const state = applyAll(stateWith([document({ id: 'd1' })]), [event, event]);

    expect(state.documents).toHaveLength(1);
    expect(state.detectedFields.d1).toBe(6);
  });
});

describe('document.error', () => {
  it('records the message and counts the document as finished', () => {
    const state = applyProcessingEvent(stateWith([document({ id: 'd1', progress: 40 })]), {
      type: 'document.error',
      batchId: 'b1',
      documentId: 'd1',
      message: 'Failed to convert PDF to image',
    });

    const failed = state.documents[0]!;
    expect(failed.status).toBe('error');
    expect(failed.errorMessage).toBe('Failed to convert PDF to image');
    // Finished, not stalled at 40%.
    expect(failed.progress).toBe(100);
  });
});

describe('batch events', () => {
  it('adopts the batch when none is being watched', () => {
    const state = applyProcessingEvent(initialState, {
      type: 'batch.progress',
      batchId: 'b1',
      batch: batch(),
    });

    expect(state.batch?.id).toBe('b1');
  });

  it('ignores another batch while one is being watched', () => {
    const watching = applyProcessingEvent(initialState, {
      type: 'batch.progress',
      batchId: 'b1',
      batch: batch(),
    });

    const after = applyProcessingEvent(watching, {
      type: 'batch.progress',
      batchId: 'b2',
      batch: batch({ id: 'b2', name: 'someone else' }),
    });

    expect(after).toBe(watching);
  });

  it('takes the completion of the batch it is watching', () => {
    const watching = applyProcessingEvent(initialState, {
      type: 'batch.progress',
      batchId: 'b1',
      batch: batch(),
    });

    const done = applyProcessingEvent(watching, {
      type: 'batch.complete',
      batchId: 'b1',
      batch: batch({
        status: 'complete',
        progress: 100,
        counts: { queued: 0, processing: 0, ready: 2, error: 0 },
      }),
    });

    expect(done.batch?.status).toBe('complete');
    expect(done.batch?.progress).toBe(100);
  });
});

describe('a whole batch, event by event', () => {
  it('ends with both documents ready and the batch complete', () => {
    const state = applyAll(initialState, [
      { type: 'document.queued', batchId: 'b1', document: document({ id: 'a' }) },
      { type: 'document.queued', batchId: 'b1', document: document({ id: 'b' }) },
      { type: 'batch.progress', batchId: 'b1', batch: batch() },
      { type: 'document.progress', batchId: 'b1', documentId: 'a', progress: 40 },
      { type: 'document.progress', batchId: 'b1', documentId: 'a', progress: 95 },
      {
        type: 'document.ready',
        batchId: 'b1',
        document: document({ id: 'a', status: 'ready', progress: 100 }),
        detectedFields: 7,
      },
      { type: 'document.progress', batchId: 'b1', documentId: 'b', progress: 80 },
      { type: 'document.error', batchId: 'b1', documentId: 'b', message: 'bad pdf' },
      {
        type: 'batch.complete',
        batchId: 'b1',
        batch: batch({
          status: 'complete',
          progress: 100,
          counts: { queued: 0, processing: 0, ready: 1, error: 1 },
        }),
      },
    ]);

    expect(statusOf(state, 'a')).toBe('ready');
    expect(statusOf(state, 'b')).toBe('error');
    expect(state.detectedFields.a).toBe(7);
    expect(state.batch?.status).toBe('complete');
  });
});

describe('firstReady', () => {
  it('picks the first document that can actually be opened', () => {
    const chosen = firstReady([
      document({ id: 'a', status: 'queued' }),
      document({ id: 'b', status: 'error' }),
      document({ id: 'c', status: 'ready' }),
      document({ id: 'd', status: 'ready' }),
    ]);

    expect(chosen).toBe('c');
  });

  it('returns null when nothing is ready', () => {
    expect(firstReady([document({ status: 'processing' })])).toBeNull();
    expect(firstReady([])).toBeNull();
  });
});
