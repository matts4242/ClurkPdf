import type { BatchWithProgress, Document, ProcessingEvent } from '../types';

/**
 * Folding processing events into the view's state.
 *
 * Kept apart from the component because this is the part that can actually be
 * wrong: events arrive out of order, describe documents the client has never
 * seen, or repeat after a reconnect. A pure function over a plain object can
 * be tested against all of that directly; the same logic written inline in
 * three `setState` callbacks cannot.
 */

export interface ProcessingState {
  /** Newest first, which is the order the grid draws. */
  documents: Document[];
  /** The batch being watched, if any. */
  batch: BatchWithProgress | null;
  /** Fields the processing job found, by document id. */
  detectedFields: Record<string, number>;
}

export const initialState: ProcessingState = {
  documents: [],
  batch: null,
  detectedFields: {},
};

/**
 * Apply one event.
 *
 * Returns the state unchanged — by identity — when the event says nothing new,
 * so React can skip the re-render. That matters here because
 * `document.progress` fires several times per document per batch.
 */
export function applyProcessingEvent(
  state: ProcessingState,
  event: ProcessingEvent,
): ProcessingState {
  switch (event.type) {
    case 'document.queued':
      return { ...state, documents: upsert(state.documents, event.document) };

    case 'document.progress': {
      const documents = patch(state.documents, event.documentId, (document) => {
        // Nothing reopens a document the queue has already finished with.
        if (document.status === 'ready' || document.status === 'error') return document;
        // A frame from earlier in the job, overtaken in flight, must not drag
        // the bar backwards.
        if (document.progress > event.progress) return document;
        // A repeat of the frame already showing. Note the status check: the
        // job's first frame is 0%, and a queued document sitting at 0 does
        // have something to change.
        if (document.status === 'processing' && document.progress === event.progress) {
          return document;
        }
        return { ...document, status: 'processing', progress: event.progress };
      });
      return documents === state.documents ? state : { ...state, documents };
    }

    case 'document.ready':
      return {
        ...state,
        documents: upsert(state.documents, event.document),
        detectedFields: {
          ...state.detectedFields,
          [event.document.id]: event.detectedFields,
        },
      };

    case 'document.error': {
      const documents = patch(state.documents, event.documentId, (document) => ({
        ...document,
        status: 'error' as const,
        progress: 100,
        errorMessage: event.message,
      }));
      return documents === state.documents ? state : { ...state, documents };
    }

    case 'batch.progress':
    case 'batch.complete':
      // A client watching one batch ignores another's; one watching everything
      // follows whichever batch is currently reporting.
      if (state.batch !== null && state.batch.id !== event.batchId) return state;
      return { ...state, batch: event.batch };

    default:
      return state;
  }
}

/** Replace a document if it is known, otherwise add it at the front. */
function upsert(documents: Document[], incoming: Document): Document[] {
  const index = documents.findIndex((document) => document.id === incoming.id);
  if (index === -1) return [incoming, ...documents];

  const next = [...documents];
  next[index] = { ...next[index], ...incoming } as Document;
  return next;
}

/**
 * Apply `change` to one document.
 *
 * Returns the original array when the document is unknown or `change` gave
 * back what it was handed, so an event that changes nothing costs no render.
 */
function patch(
  documents: Document[],
  id: string,
  change: (document: Document) => Document,
): Document[] {
  const index = documents.findIndex((document) => document.id === id);
  if (index === -1) return documents;

  const current = documents[index] as Document;
  const updated = change(current);
  if (updated === current) return documents;

  const next = [...documents];
  next[index] = updated;
  return next;
}

/**
 * The document to open by default: the first one that can actually be shown.
 *
 * A queued or failed document has no rendered page behind it, so selecting one
 * would only give the viewer something to fail on.
 */
export const firstReady = (documents: Document[]): string | null =>
  documents.find((document) => document.status === 'ready')?.id ?? null;
