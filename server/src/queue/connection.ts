import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * Redis connections for BullMQ.
 *
 * BullMQ needs `maxRetriesPerRequest: null` on any connection a Worker
 * blocks on, because a blocking `BRPOPLPUSH` legitimately sits open for
 * longer than ioredis's default request timeout and would otherwise be torn
 * down mid-wait. Queues and Workers must not share one connection either — a
 * blocked worker connection cannot also serve an `add()` — so each caller
 * gets its own, and this module keeps track of them for shutdown.
 */

const connections = new Set<Redis>();

export function createRedisConnection(): Redis {
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    // Buffer commands issued while the socket is down rather than failing
    // them, so a reconnect blip does not lose an upload. `queueDocument`
    // bounds the wait, so a Redis that is properly down still answers 503
    // rather than holding the request open.
    enableOfflineQueue: true,
    lazyConnect: false,
  });

  // Without a listener, a connection error is an unhandled 'error' event and
  // takes the process down. The queue reports its own health separately.
  connection.on('error', (error: Error) => {
    if (!config.isTest) {
      console.error('[redis]', error.message);
    }
  });

  connections.add(connection);
  connection.once('end', () => connections.delete(connection));
  return connection;
}

/** Close every connection this module handed out. Called during shutdown. */
export async function closeRedisConnections(): Promise<void> {
  const open = [...connections];
  connections.clear();
  await Promise.all(open.map((connection) => connection.quit().catch(() => undefined)));
}

/**
 * Check that Redis answers, without leaving a connection behind.
 *
 * Called once at startup so a missing Redis fails loudly there rather than
 * silently swallowing every upload.
 */
export async function pingRedis(): Promise<void> {
  const probe = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    // Fail the startup check quickly instead of retrying for a minute.
    retryStrategy: () => null,
    connectTimeout: 3_000,
  });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
  } finally {
    probe.disconnect();
  }
}
