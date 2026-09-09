import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * The Redis connection the queue runs on.
 *
 * One connection is shared by the queue and the worker. BullMQ requires
 * `maxRetriesPerRequest: null` on a connection a worker blocks on, because a
 * blocking read is not a request it should give up on.
 */

let connection: Redis | null = null;

export function getRedis(): Redis {
  connection ??= new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  });
  return connection;
}

/** Verify Redis is reachable. Called at startup so a bad URL fails loudly. */
export async function connectRedis(): Promise<void> {
  await getRedis().ping();
}

export async function disconnectRedis(): Promise<void> {
  const open = connection;
  connection = null;
  if (open) await open.quit().catch(() => undefined);
}
