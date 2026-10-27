import { Migration } from '@mikro-orm/migrations';

/*
 * Inbox: dedup of incoming SQS messages per consumer. Same message_id with another payload_hash is a
 * permanent contract violation (DLQ), decided by the application from the stored hash.
 * Outbox: one row per integration event (PK = event_id, the consumers' dedup key). The partial index keeps
 * the publisher's claim (`… WHERE published_at IS NULL … FOR UPDATE SKIP LOCKED`) cheap as the table grows.
 * lease_token fences writes: a claim sets (locked_until, lease_token) together, and a retry only applies with
 * `WHERE event_id = $1 AND published_at IS NULL AND lease_token = $2`, so a publisher whose lease expired and
 * was reclaimed cannot overwrite the new owner's state.
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
