import type { EntityManager } from '@mikro-orm/postgresql';
import { translateDatabaseError } from '../database-error';

/**
 * Readiness do PostgreSQL para os workers: `SELECT 1` numa conexão do pool. Rejeita com o erro traduzido enquanto
 * o banco (ou o pool) não consegue atender uma query, e o consumer SQS alimenta o circuit breaker com isso.
 */
export const createPostgresReadiness =
  (em: EntityManager): (() => Promise<void>) =>
  async () => {
    try {
      await em.fork().execute('SELECT 1');
    } catch (error) {
      throw translateDatabaseError(error);
    }
  };
