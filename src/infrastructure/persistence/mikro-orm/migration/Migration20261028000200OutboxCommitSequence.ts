import { Migration } from '@mikro-orm/migrations';

/*
 * A ordem de um aggregate na fila é a ordem de commit, não o occurred_at: o occurred_at é pego antes do lock da
 * wallet, então um commit posterior pode ter timestamp anterior, e empate de UUIDv7 dentro do mesmo milissegundo é
 * aleatório entre processos. O `seq` é gerado no INSERT, e todo evento de uma wallet é inserido com a wallet em
 * lock, então por aggregate ele cresce na ordem de commit. O claim head-of-line e o índice dele usam
 * (aggregate_id, seq).
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
