import type { Pool, PoolClient } from 'pg';

/**
 * Frees the pool slot of a client whose connection died while checked out.
 *
 * Kysely (under MikroORM) releases a transaction's client only after a successful COMMIT/ROLLBACK. When the
 * backend dies mid-transaction the ROLLBACK fails too, `release()` is never called, and the slot leaks for
 * good: after `max` such deaths every acquire hangs. Here each checked-out client releases itself with the
 * error (pg-pool then destroys it instead of reusing it) as soon as it emits `error` or `end`, and a later
 * release by its holder becomes a no-op instead of pg-pool's "Release called on client which has already
 * been released" throw.
 */
export const guardPool = (pool: Pool): void => {
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  const guardedConnect = async (): Promise<PoolClient> => {
    const client = await connect();
    const release = client.release;
    let released = false;
    const onBroken = (error?: Error): void => {
      client.release(error ?? new Error('Connection ended while checked out'));
    };
    const onEnd = (): void => onBroken();
    client.release = (destroy?: Error | boolean): void => {
      if (released) return;
      released = true;
      client.removeListener('error', onBroken);
      client.removeListener('end', onEnd);
      client.release = release;
      release(destroy);
    };
    client.once('error', onBroken);
    client.once('end', onEnd);
    return client;
  };
  pool.connect = guardedConnect as Pool['connect'];
};
