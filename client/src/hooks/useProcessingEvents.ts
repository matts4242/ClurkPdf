import { useEffect, useRef, useState } from 'react';
import { progressSocketUrl } from '../api/client';
import type { ProcessingEvent } from '../types';

/**
 * Subscribe to the server's processing events.
 *
 * Weeks 1-4 polled every document until it stopped saying `processing`, which
 * meant a request per document per second and a second of lag on every change.
 * The queue knows exactly when something happens, so it says so instead.
 *
 * The socket is the live channel, not the source of truth. A drop is a
 * reconnect plus a re-fetch — `onResync` — rather than a second code path
 * trying to reconstruct what was missed, because the REST endpoints already
 * return the whole picture.
 */

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface UseProcessingEventsOptions {
  /** Hear only about this batch. Omit to hear about everything. */
  batchId?: string;
  /** Called for every event. Must be stable or wrapped in `useCallback`. */
  onEvent: (event: ProcessingEvent) => void;
  /**
   * Called after a reconnect, so the caller can refetch what it missed while
   * the socket was down. Not called on the first connection.
   */
  onResync?: () => void;
  /** Set false to disconnect, e.g. while nothing is being processed. */
  enabled?: boolean;
}

const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

export function useProcessingEvents({
  batchId,
  onEvent,
  onResync,
  enabled = true,
}: UseProcessingEventsOptions): ConnectionState {
  const [state, setState] = useState<ConnectionState>('closed');

  // Handlers are read through refs so that a caller passing an inline arrow
  // function does not tear the socket down and rebuild it on every render.
  const onEventRef = useRef(onEvent);
  const onResyncRef = useRef(onResync);
  onEventRef.current = onEvent;
  onResyncRef.current = onResync;

  useEffect(() => {
    if (!enabled) {
      setState('closed');
      return;
    }

    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = INITIAL_RETRY_MS;
    let hasConnectedBefore = false;
    // Set on unmount so a socket closing during teardown does not schedule
    // another connection attempt against a component that is gone.
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      setState('connecting');

      socket = new WebSocket(progressSocketUrl(batchId));

      socket.onopen = () => {
        if (disposed) return;
        retryDelay = INITIAL_RETRY_MS;
        setState('open');
        // Anything that happened while the socket was down is still in the
        // database; ask for it rather than trying to replay it.
        if (hasConnectedBefore) onResyncRef.current?.();
        hasConnectedBefore = true;
      };

      socket.onmessage = (message: MessageEvent<string>) => {
        let parsed: ProcessingEvent | { type: 'connected' };
        try {
          parsed = JSON.parse(message.data) as ProcessingEvent | { type: 'connected' };
        } catch {
          return;
        }
        // The server's handshake frame, not a processing event.
        if (parsed.type === 'connected') return;
        onEventRef.current(parsed);
      };

      socket.onerror = () => {
        // 'close' always follows, and does the reconnecting.
        socket?.close();
      };

      socket.onclose = () => {
        if (disposed) return;
        setState('closed');
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (socket) {
        // Drop the handlers first: a close fired during teardown must not
        // reconnect or call back into an unmounted component.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [batchId, enabled]);

  return state;
}
