import { Migration } from '@mikro-orm/migrations';

/*
 * The outbox claim is head-of-line per aggregate: a message is eligible only when no older unpublished message
 * of the same aggregate exists (`NOT EXISTS … p.aggregate_id = o.aggregate_id AND p.published_at IS NULL AND
 * (p.occurred_at, p.event_id) < (o.occurred_at, o.event_id)`). This index answers that probe with one short
 * range scan per candidate, and only over unpublished rows.
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
