import { afterAll, beforeAll, describe, it } from 'bun:test';
import type { Client } from 'pg';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { uuidv7 } from '../../support/uuid';
import { createMigratedDatabase, expectSqlError, insert, type MigratedDatabase, type Row } from './schema-fixtures';

const NOW = '2026-07-29T15:00:00.000Z';

const inboxRow = (overrides: Row = {}): Row => ({
  consumer_name: 'wager-transactions',
  message_id: `msg-${uuidv7()}`,
  payload_hash: 'hash',
  received_at: NOW,
  ...overrides,
});

const outboxRow = (overrides: Row = {}): Row => {
  const eventId = uuidv7();
  return {
    event_id: eventId,
    aggregate_type: 'Wallet',
    aggregate_id: uuidv7(),
    event_type: 'WalletBalanceChanged',
    payload: JSON.stringify({ eventId, eventType: 'WalletBalanceChanged', version: 1, data: {} }),
    occurred_at: NOW,
    next_attempt_at: NOW,
    ...overrides,
  };
};

describe('messaging schema', () => {
  let db: MigratedDatabase;
  let client: Client;

  beforeAll(async () => {
    await ensureInfraUp();
    db = await createMigratedDatabase();
    client = db.client;
  });

  afterAll(() => db?.close());

  describe('inbox_messages', () => {
    it('deduplicates by (consumer_name, message_id)', async () => {
      const row = inboxRow();
      await insert(client, 'inbox_messages', row);
      await expectSqlError(insert(client, 'inbox_messages', { ...row, payload_hash: 'other' }), '23505', 'inbox_messages_pkey');
      await insert(client, 'inbox_messages', { ...row, consumer_name: 'another-consumer' });
    });

    it('rejects blank identifiers', async () => {
      await expectSqlError(insert(client, 'inbox_messages', inboxRow({ message_id: ' ' })), '23514', 'inbox_messages_not_blank');
    });
  });

  describe('outbox_messages', () => {
    it('keys messages by event_id', async () => {
      const row = outboxRow();
      await insert(client, 'outbox_messages', row);
      await expectSqlError(insert(client, 'outbox_messages', row), '23505', 'outbox_messages_pkey');
    });

    it('requires the payload to be the envelope of the same event', async () => {
      await expectSqlError(
        insert(client, 'outbox_messages', outboxRow({ payload: JSON.stringify({ eventId: uuidv7() }) })),
        '23514',
        'outbox_messages_payload_is_envelope',
      );
      await expectSqlError(
        insert(client, 'outbox_messages', outboxRow({ payload: JSON.stringify([1]) })),
        '23514',
        'outbox_messages_payload_is_envelope',
      );
    });

    it('sets locked_until and lease_token together', async () => {
      await expectSqlError(
        insert(client, 'outbox_messages', outboxRow({ locked_until: NOW })),
        '23514',
        'outbox_messages_lease_coherent',
      );
      await expectSqlError(
        insert(client, 'outbox_messages', outboxRow({ lease_token: uuidv7() })),
        '23514',
        'outbox_messages_lease_coherent',
      );
      await insert(client, 'outbox_messages', outboxRow({ locked_until: NOW, lease_token: uuidv7() }));
    });

    it('releases the lease when published', async () => {
      await expectSqlError(
        insert(client, 'outbox_messages', outboxRow({ locked_until: NOW, lease_token: uuidv7(), published_at: NOW })),
        '23514',
        'outbox_messages_published_releases_lease',
      );
    });

    it('rejects negative attempts', async () => {
      await expectSqlError(
        insert(client, 'outbox_messages', outboxRow({ attempts: -1 })),
        '23514',
        'outbox_messages_attempts_non_negative',
      );
    });
  });
});
