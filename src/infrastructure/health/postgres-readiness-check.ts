import type { EntityManager } from '@mikro-orm/postgresql';
import type { IReadinessCheck } from './readiness-check.port';

/** `SELECT 1` on a pooled connection: proves the pool can hand out a connection and the server answers. */
export class PostgresReadinessCheck implements IReadinessCheck {
  readonly name = 'postgres';

  constructor(private readonly em: EntityManager) {}

  async check(): Promise<void> {
    await this.em.fork().execute('SELECT 1');
  }
}
