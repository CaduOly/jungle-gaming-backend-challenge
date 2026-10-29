import { Migration } from '@mikro-orm/migrations';

/*
 * The order of an aggregate on the wire is its commit order, not occurred_at: occurred_at is taken before the wallet
 * lock, so a later commit can carry an earlier timestamp, and UUIDv7 ties inside one millisecond are random across
 * processes. `seq` is drawn at INSERT time, and every event of a wallet is inserted while that wallet is locked, so
 * per aggregate it grows in commit order. The head-of-line claim and its index use (aggregate_id, seq).
 */
const UP = /* sql */ `
ALTER TABLE outbox_messages ADD COLUMN seq bigserial NOT NULL;
ALTER TABLE outbox_messages ADD CONSTRAINT outbox_messages_seq_unique UNIQUE (seq);
DROP INDEX outbox_messages_unpublished_by_aggregate;
CREATE INDEX outbox_messages_unpublished_by_aggregate
  ON outbox_messages (aggregate_id, seq)
  WHERE published_at IS NULL;
`;

const DOWN = /* sql */ `
DROP INDEX outbox_messages_unpublished_by_aggregate;
CREATE INDEX outbox_messages_unpublished_by_aggregate
  ON outbox_messages (aggregate_id, occurred_at, event_id)
  WHERE published_at IS NULL;
ALTER TABLE outbox_messages DROP COLUMN seq;
`;

export class Migration20261028000200OutboxCommitSequence extends Migration {
  override up(): void {
    this.addSql(UP);
  }

  override down(): void {
    this.addSql(DOWN);
  }
}
