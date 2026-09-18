import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '../config.js';
import type { ProcessingEvent } from '../types/index.js';
import { subscribeToEvents } from './bus.js';

/**
 * Live processing progress, pushed to the browser.
 *
 * Before Week 5 the client polled each document until it left `processing`,
 * which is both chatty and slow to notice. The queue knows exactly when
 * something changes, so it says so.
 *
 * One endpoint, `/ws`, carrying the same `ProcessingEvent` union the bus
 * publishes. A client may name a batch in the query string to hear only about
 * that upload; connecting without one hears everything, which is what the
 * document list wants.
 */

const WS_PATH = '/ws';

interface Client {
  socket: WebSocket;
  /** Null means "every batch". */
  batchId: string | null;
  alive: boolean;
}

const clients = new Set<Client>();

let wss: WebSocketServer | null = null;
let unsubscribe: (() => void) | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

/**
 * Attach the WebSocket endpoint to the HTTP server.
 *
 * `noServer` plus an explicit upgrade handler rather than `{ server }`, so a
 * request to any other path is refused instead of being silently held open by
 * a second listener.
 */
export function attachWebSocketServer(server: Server): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ noServer: true, clientTracking: false });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname, searchParams } = parseUrl(request);
    if (pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Same origin rule as the REST API: a page the user did not open must not
    // be able to watch their uploads.
    const origin = request.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss?.handleUpgrade(request, socket, head, (ws) => {
      register(ws, searchParams.get('batchId'));
    });
  });

  unsubscribe = subscribeToEvents(broadcast);

  // A browser that closes without a FIN leaves a socket that looks connected
  // forever. Ping, and drop anything that missed the last round.
  heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, config.wsHeartbeatMs);
  heartbeat.unref();

  return wss;
}

function register(socket: WebSocket, batchId: string | null): void {
  const client: Client = { socket, batchId, alive: true };
  clients.add(client);

  socket.on('pong', () => {
    client.alive = true;
  });
  socket.on('close', () => clients.delete(client));
  socket.on('error', () => {
    clients.delete(client);
    socket.terminate();
  });

  // Tell the client what it connected to, so it can confirm the filter it
  // asked for rather than assuming.
  send(socket, { type: 'connected', batchId });
}

/** Deliver one event to every client that asked for it. */
function broadcast(event: ProcessingEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.batchId !== null && client.batchId !== event.batchId) continue;
    if (client.socket.readyState !== client.socket.OPEN) continue;
    client.socket.send(payload, (error) => {
      if (error) {
        clients.delete(client);
        client.socket.terminate();
      }
    });
  }
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/** Close every socket and stop listening. Called during shutdown. */
export async function closeWebSocketServer(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  unsubscribe?.();
  unsubscribe = null;

  for (const client of clients) client.socket.terminate();
  clients.clear();

  const open = wss;
  wss = null;
  await new Promise<void>((resolve) => {
    if (!open) {
      resolve();
      return;
    }
    open.close(() => resolve());
  });
}

/** How many clients are currently connected. Reported by the health endpoint. */
export const connectedClients = (): number => clients.size;

function parseUrl(request: IncomingMessage): URL {
  // The host only has to be syntactically valid; nothing here reads it.
  return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
}
