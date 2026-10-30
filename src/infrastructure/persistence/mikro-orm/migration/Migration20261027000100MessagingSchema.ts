import { Migration } from '@mikro-orm/migrations';

/*
 * Inbox: dedup das mensagens SQS que chegam, por consumer. Mesmo message_id com outro payload_hash é violação
 * permanente de contrato (DLQ), decidida pela aplicação a partir do hash gravado.
 * Outbox: uma linha por evento de integração (PK = event_id, a chave de dedup dos consumers). Os índices parciais
 * deixam o claim do publisher (`… WHERE published_at IS NULL … ORDER BY occurred_at, event_id … FOR UPDATE SKIP
 * LOCKED`) barato conforme a tabela cresce, seja o planner filtrando por next_attempt_at ou seguindo a ordem de
 * ocorrência. O lease_token protege as escritas: o claim define (locked_until, lease_token) junto, e o retry só
 * aplica com `WHERE event_id = $1 AND published_at IS NULL AND lease_token = $2`, então um publisher cujo lease
 * expirou e foi pego de volta não consegue sobrescrever o estado do novo dono.
 */
const UP = /* sql */ `
CREATE TABLE inbox_messages (
  consumer_name text        NOT NULL,
  message_id    text        NOT NULL,
  payload_hash  text        NOT NULL,
  received_at   timestamptz NOT NULL,
  processed_at  timestamptz,
  CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id),
  CONSTRAINT inbox_messages_not_blank CHECK (
    btrim(consumer_name) <> '' AND btrim(message_id) <> '' AND btrim(payload_hash) <> ''
  )
);

CREATE TABLE outbox_messages (
  event_id         uuid        NOT NULL,
  aggregate_type   text        NOT NULL,
  aggregate_id     text        NOT NULL,
  event_type       text        NOT NULL,
  payload          jsonb       NOT NULL,
  occurred_at      timestamptz NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  locked_until     timestamptz,
  lease_token      uuid,
  published_at     timestamptz,
  CONSTRAINT outbox_messages_pkey PRIMARY KEY (event_id),
  CONSTRAINT outbox_messages_not_blank CHECK (
    btrim(aggregate_type) <> '' AND btrim(aggregate_id) <> '' AND btrim(event_type) <> ''
  ),
  CONSTRAINT outbox_messages_payload_is_envelope CHECK (
    jsonb_typeof(payload) = 'object' AND payload ->> 'eventId' = event_id::text
  ),
  CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT outbox_messages_lease_coherent CHECK ((locked_until IS NULL) = (lease_token IS NULL)),
  CONSTRAINT outbox_messages_published_releases_lease CHECK (published_at IS NULL OR lease_token IS NULL)
);

CREATE INDEX outbox_messages_unpublished
  ON outbox_messages (next_attempt_at, occurred_at, event_id)
  WHERE published_at IS NULL;

CREATE INDEX outbox_messages_unpublished_by_occurrence
  ON outbox_messages (occurred_at, event_id)
  WHERE published_at IS NULL;
`;

const DOWN = /* sql */ `
DROP TABLE outbox_messages;
DROP TABLE inbox_messages;
`;

export class Migration20261027000100MessagingSchema extends Migration {
  override up(): void {
    this.addSql(UP);
  }

  override down(): void {
    this.addSql(DOWN);
  }
}
