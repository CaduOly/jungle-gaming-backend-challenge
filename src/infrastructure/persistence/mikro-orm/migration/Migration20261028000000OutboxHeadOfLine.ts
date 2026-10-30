import { Migration } from '@mikro-orm/migrations';

/*
 * O claim do outbox é head-of-line por aggregate: uma mensagem só é elegível quando não existe mensagem mais antiga
 * não publicada do mesmo aggregate (`NOT EXISTS … p.aggregate_id = o.aggregate_id AND p.published_at IS NULL AND
 * (p.occurred_at, p.event_id) < (o.occurred_at, o.event_id)`). Esse índice responde essa checagem com um range
 * scan curto por candidato, e só em cima das linhas não publicadas.
 */
const UP = /* sql */ `
CREATE INDEX outbox_messages_unpublished_by_aggregate
  ON outbox_messages (aggregate_id, occurred_at, event_id)
  WHERE published_at IS NULL;
`;

const DOWN = /* sql */ `
DROP INDEX outbox_messages_unpublished_by_aggregate;
`;

export class Migration20261028000000OutboxHeadOfLine extends Migration {
  override up(): void {
    this.addSql(UP);
  }

  override down(): void {
    this.addSql(DOWN);
  }
}
