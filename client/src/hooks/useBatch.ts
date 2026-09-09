import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, batchSocketUrl, fetchBatch } from '../api/client';
import type { Batch, BatchEvent, Document } from '../types';

/** Refetch interval used when the socket is not carrying events. */
const POLL_MS = 4_000;
/** Wait before reconnecting a dropped socket. */
const RECONNECT_MS = 2_000;

export interface UseBatchReturn {
  batch: Batch | null;
  error: string | null;
  /** True while the progress socket is open. */
  live: boolean;
  /** True between choosing a batch and having its documents. */
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Follow one batch as it processes.
 *
 * The socket is the fast path and the poll is the safety net: a proxy that
 * drops the upgrade, a sleeping laptop, or a missed message would otherwise
 * leave the grid showing work that finished minutes ago. Polling stops once
 * nothing is left running, so a settled batch costs nothing.
 */
export function useBatch(batchId: string | null, seed?: Batch | null): UseBatchReturn {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!batchId) return;
    try {
      const loaded = await fetchBatch(batchId);
      if (mountedRef.current) {
        setBatch(loaded);
        setError(null);
      }
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === 'CANCELLED') return;
      if (mountedRef.current) {
        setError(caught instanceof Error ? caught.message : 'Could not load the batch');
      }
    }
  }, [batchId]);

  // Load whenever the batch changes, and clear out the previous one first so
  // the grid never shows another batch's documents. A batch just created is
  // handed to us whole by the upload response, so it goes straight up rather
  // than blanking the grid for one round trip.
  useEffect(() => {
    setBatch(seed && seed.id === batchId ? seed : null);
    setError(null);
    void refresh();
    // `seed` is deliberately not a dependency: it is a starting point for this
    // batch, not a value that keeps overwriting live state as work arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, refresh]);

  // The socket. One per batch, reopened if it drops while work is outstanding.
  useEffect(() => {
    if (!batchId) return;

    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const open = (): void => {
      socket = new WebSocket(batchSocketUrl());

      socket.onopen = () => {
        socket?.send(JSON.stringify({ subscribe: batchId }));
        if (mountedRef.current) setLive(true);
        // Catch up on anything that settled between the last load and here.
        void refresh();
      };

      socket.onmessage = (message: MessageEvent<string>) => {
        const event = parseEvent(message.data);
        if (!event || event.batchId !== batchId || !mountedRef.current) return;

        if (event.type === 'document') {
          setBatch((current) => (current ? withDocument(current, event.document) : current));
        } else {
          setBatch((current) => (current ? { ...current, counts: event.counts } : current));
        }
      };

      socket.onclose = () => {
        if (mountedRef.current) setLive(false);
        if (!closed) reconnect = setTimeout(open, RECONNECT_MS);
      };

      // onclose follows an error, so reconnection is handled in one place.
      socket.onerror = () => socket?.close();
    };

    open();

    return () => {
      closed = true;
      if (reconnect !== null) clearTimeout(reconnect);
      socket?.close();
      setLive(false);
    };
  }, [batchId, refresh]);

  // The fallback poll, running only while documents are outstanding.
  const outstanding =
    batch !== null && (batch.counts.queued > 0 || batch.counts.processing > 0);

  useEffect(() => {
    if (!batchId || !outstanding) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [batchId, outstanding, refresh]);

  return { batch, error, live, loading: batchId !== null && batch === null && error === null, refresh };
}

/** Replace one document and recount, so the badges follow the grid exactly. */
function withDocument(batch: Batch, document: Document): Batch {
  const documents = batch.documents.some((existing) => existing.id === document.id)
    ? batch.documents.map((existing) => (existing.id === document.id ? document : existing))
    : [...batch.documents, document];

  const counts = { total: documents.length, queued: 0, processing: 0, ready: 0, error: 0 };
  for (const item of documents) counts[item.status] += 1;

  return { ...batch, documents, counts };
}

function parseEvent(raw: string): BatchEvent | null {
  try {
    const event: unknown = JSON.parse(raw);
    if (typeof event !== 'object' || event === null) return null;
    const type = (event as { type?: unknown }).type;
    return type === 'document' || type === 'batch-complete' ? (event as BatchEvent) : null;
  } catch {
    return null;
  }
}
