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
type ConnectCallback = (error: Error | undefined, client: PoolClient | undefined, done: (release?: Error | boolean) => void) => void;

const noop = (): void => undefined;

/*
 * pg-pool's own pool.query() acquires through the callback form, connect((error, client, done) => …), so the
 * guarded connect has to honour it as well: ignoring the callback would leave that query hanging with its slot
 * checked out for good.
 */
export const guardPool = (pool: Pool): void => {
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  const acquire = async (): Promise<PoolClient> => {
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
  const guardedConnect = (callback?: ConnectCallback): Promise<PoolClient> | undefined => {
    if (callback === undefined) return acquire();
    acquire().then(
      (client) => queueMicrotask(() => callback(undefined, client, (destroy) => client.release(destroy))),
      (error: unknown) =>
        queueMicrotask(() => callback(error instanceof Error ? error : new Error(String(error)), undefined, noop)),
    );
    return undefined;
  };
  pool.connect = guardedConnect as Pool['connect'];
};
