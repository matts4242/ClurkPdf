import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BatchEvent } from '../types/index.js';

/**
 * Live batch progress, pushed rather than polled.
 *
 * A client opens one socket and names the batches it cares about; the worker
 * publishes as each document settles. The worker runs in this process, so
 * publishing is a function call — moving the worker to its own container later
 * means putting Redis pub/sub behind `publish` and nothing else changes.
 */

export const WS_PATH = '/api/ws';

/** Sockets by the batch id they asked for. */
const subscribers = new Map<string, Set<WebSocket>>();

let wss: WebSocketServer | null = null;

export function attachBatchEvents(server: Server): void {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Anything not addressed to us belongs to another handler, or nobody.
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== WS_PATH) return;

    wss?.handleUpgrade(request, socket, head, (client) => {
      wss?.emit('connection', client, request);
    });
  });

  wss.on('connection', (client: WebSocket) => {
    client.on('message', (raw) => {
      const batchId = parseSubscribe(raw.toString());
      if (batchId === null) return;

      let set = subscribers.get(batchId);
      if (!set) subscribers.set(batchId, (set = new Set()));
      set.add(client);
    });

    client.on('close', () => forget(client));
    client.on('error', () => forget(client));
  });
}

/** Send an event to everyone watching that batch. */
export function publish(event: BatchEvent): void {
  const listeners = subscribers.get(event.batchId);
  if (!listeners || listeners.size === 0) return;

  const payload = JSON.stringify(event);
  for (const client of listeners) {
    // 1 is OPEN. A socket closing between two events is ordinary.
    if (client.readyState === 1) client.send(payload);
  }
}

export async function closeBatchEvents(): Promise<void> {
  const open = wss;
  wss = null;
  subscribers.clear();
  if (!open) return;

  for (const client of open.clients) client.terminate();
  await new Promise<void>((resolve) => open.close(() => resolve()));
}

/** `{"subscribe":"<uuid>"}` and nothing else; anything odd is ignored. */
function parseSubscribe(raw: string): string | null {
  try {
    const message: unknown = JSON.parse(raw);
    if (typeof message !== 'object' || message === null) return null;
    const value = (message as { subscribe?: unknown }).subscribe;
    return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
  } catch {
    return null;
  }
}

function forget(client: WebSocket): void {
  for (const [batchId, listeners] of subscribers) {
    listeners.delete(client);
    if (listeners.size === 0) subscribers.delete(batchId);
  }
}
