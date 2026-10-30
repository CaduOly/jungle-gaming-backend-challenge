import type { EntityManager } from '@mikro-orm/postgresql';
import type { IReadinessCheck } from './readiness-check.port';

/** `SELECT 1` numa conexão do pool: prova que o pool consegue entregar conexão e que o servidor responde. */
export class PostgresReadinessCheck implements IReadinessCheck {
  readonly name = 'postgres';

  constructor(private readonly em: EntityManager) {}

  async check(): Promise<void> {
    await this.em.fork().execute('SELECT 1');
  }
}
