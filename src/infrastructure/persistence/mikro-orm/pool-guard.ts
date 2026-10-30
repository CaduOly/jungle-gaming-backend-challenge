import type { Pool, PoolClient } from 'pg';

/**
 * Libera o slot do pool de um client cuja conexão morreu enquanto estava em uso.
 *
 * O Kysely (por baixo do MikroORM) só libera o client da transação depois de um COMMIT/ROLLBACK com sucesso. Quando
 * o backend morre no meio da transação o ROLLBACK também falha, o `release()` nunca é chamado e o slot vaza de vez:
 * depois de `max` mortes assim todo acquire trava. Aqui cada client em uso se libera sozinho com o erro (aí o
 * pg-pool destrói ele em vez de reusar) assim que emite `error` ou `end`, e um release posterior de quem segura ele
 * vira no-op em vez do throw "Release called on client which has already been released" do pg-pool.
 */
type ConnectCallback = (error: Error | undefined, client: PoolClient | undefined, done: (release?: Error | boolean) => void) => void;

const noop = (): void => undefined;

/*
 * O próprio pool.query() do pg-pool faz acquire pela forma com callback, connect((error, client, done) => …), então
 * o connect protegido tem que respeitar isso também, ignorar o callback deixaria essa query travada com o slot
 * preso para sempre.
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
