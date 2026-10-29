import type { EntityManager } from '@mikro-orm/postgresql';
import { translateDatabaseError } from '../database-error';

/**
 * Readiness of PostgreSQL for the workers: `SELECT 1` on a pooled connection. Rejects with the translated error
 * while the database (or the pool) cannot serve a query; the SQS consumer feeds its circuit breaker with it.
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
