import type { Redis } from 'ioredis';
import { config } from '../config.js';
import { createRedisConnection } from '../queue/connection.js';
import type { ProcessingEvent } from '../types/index.js';

/**
 * Fan-out of processing events, over Redis pub/sub.
 *
 * A plain EventEmitter would be enough while the worker shares a process with
 * the API, but the whole point of the queue is that it need not: a second
 * worker process must still be able to push progress to a browser connected to
 * the first. Redis is already a hard dependency here, so its pub/sub is the
 * cheapest way to keep that true.
 *
 * Publishing is fire-and-forget. A dropped progress frame costs a slightly
 * stale bar until the next one, so it must never fail a job.
 */

const channel = (): string => `${config.queuePrefix}:events`;

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

type Listener = (event: ProcessingEvent) => void;
const listeners = new Set<Listener>();

export function publishEvent(event: ProcessingEvent): void {
  publisher ??= createRedisConnection();
  publisher.publish(channel(), JSON.stringify(event)).catch(() => {
    // Progress is advisory; clients reconcile from the REST endpoints.
  });
}

/**
 * Receive every event published by any process.
 *
 * Returns an unsubscribe function. The Redis subscription itself is opened
 * once, on the first listener, and stays open for the life of the process.
 */
export function subscribeToEvents(listener: Listener): () => void {
  listeners.add(listener);

  if (!subscriber) {
    subscriber = createRedisConnection();
    void subscriber.subscribe(channel()).catch((error: unknown) => {
      console.error(
        '[events] could not subscribe to progress events:',
        error instanceof Error ? error.message : error,
      );
    });
    subscriber.on('message', (_channel: string, payload: string) => {
      let event: ProcessingEvent;
      try {
        event = JSON.parse(payload) as ProcessingEvent;
      } catch {
        return;
      }
      for (const each of listeners) each(event);
    });
  }

  return () => listeners.delete(listener);
}

/** Drop the pub/sub connections. Called during shutdown. */
export async function closeEventBus(): Promise<void> {
  listeners.clear();
  const open = [publisher, subscriber].filter((c): c is Redis => c !== null);
  publisher = null;
  subscriber = null;
  await Promise.all(open.map((connection) => connection.quit().catch(() => undefined)));
}
