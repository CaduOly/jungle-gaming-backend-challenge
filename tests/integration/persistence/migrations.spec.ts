import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { migrateDown, migrateUp } from '../../../src/infrastructure/persistence/mikro-orm/migrator';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const MIGRATIONS = [
  'Migration20261027000000WageringSchema',
  'Migration20261027000100MessagingSchema',
  'Migration20261028000000OutboxHeadOfLine',
  'Migration20261028000100BalanceLimitExceeded',
  'Migration20261028000200OutboxCommitSequence',
] as const;
const [WAGERING, MESSAGING, HEAD_OF_LINE, BALANCE_LIMIT, COMMIT_SEQUENCE] = MIGRATIONS;
const TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];

const SCHEMA_FINGERPRINT_SQL = `
SELECT 'table:' || table_name || '.' || column_name || ':' || data_type || ':' || COALESCE(numeric_precision::text, '')
       || ',' || COALESCE(numeric_scale::text, '') || ':' || is_nullable AS item
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'
UNION ALL
SELECT 'constraint:' || conrelid::regclass || '.' || conname || ':' || pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> 'mikro_orm_migrations'
UNION ALL
SELECT 'index:' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'
UNION ALL
SELECT 'trigger:' || tgrelid::regclass || '.' || tgname FROM pg_trigger WHERE NOT tgisinternal
UNION ALL
SELECT 'function:' || proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
ORDER BY 1`;

describe('schema migrations', () => {
  let database: TestDatabase;
  let client: Client;

  const fingerprint = async (): Promise<string[]> =>
    (await client.query<{ item: string }>(SCHEMA_FINGERPRINT_SQL)).rows.map((row) => row.item);

  const tables = async (): Promise<string[]> =>
    (
      await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations' ORDER BY 1`,
      )
    ).rows.map((row) => row.table_name);

  beforeAll(async () => {
    await ensureInfraUp();
    database = await createTestDatabase();
    client = new Client({ connectionString: database.url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await database?.drop();
  });

  it('goes up, down and up again, leaving the same schema', async () => {
    expect((await migrateUp(database.url)).applied).toEqual([...MIGRATIONS]);
    expect(await tables()).toEqual(TABLES);
    const first = await fingerprint();
    expect((await migrateUp(database.url)).applied).toEqual([]);

    expect((await migrateDown(database.url)).applied).toEqual([COMMIT_SEQUENCE]);
    expect(await fingerprint()).not.toContainEqual(expect.stringContaining('outbox_messages.seq'));
    expect(await fingerprint()).toContainEqual(expect.stringContaining('(aggregate_id, occurred_at, event_id)'));

    expect((await migrateDown(database.url)).applied).toEqual([BALANCE_LIMIT]);
    expect(await fingerprint()).not.toContainEqual(expect.stringContaining('BALANCE_LIMIT_EXCEEDED'));

    expect((await migrateDown(database.url)).applied).toEqual([HEAD_OF_LINE]);
    expect(await fingerprint()).not.toContainEqual(expect.stringContaining('outbox_messages_unpublished_by_aggregate'));

    expect((await migrateDown(database.url)).applied).toEqual([MESSAGING]);
    expect(await tables()).toEqual(['wager_transactions', 'wallet_ledger_entries', 'wallets']);

    expect((await migrateDown(database.url, { all: true })).applied).toEqual([WAGERING]);
    expect(await fingerprint()).toEqual([]);

    expect((await migrateUp(database.url)).applied).toEqual([...MIGRATIONS]);
    expect(await fingerprint()).toEqual(first);
  });

  it('stores every monetary column as numeric(20,2)', async () => {
    await migrateUp(database.url);
    const { rows } = await client.query<{ column: string; type: string }>(
      `SELECT table_name || '.' || column_name AS column,
              data_type || '(' || numeric_precision || ',' || numeric_scale || ')' AS type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('balance', 'amount', 'balance_before', 'balance_after', 'observed_balance')
        ORDER BY 1`,
    );
    expect(rows).toEqual(
      [
        'wager_transactions.amount',
        'wager_transactions.observed_balance',
        'wallet_ledger_entries.amount',
        'wallet_ledger_entries.balance_after',
        'wallet_ledger_entries.balance_before',
        'wallets.balance',
      ].map((column) => ({ column, type: 'numeric(20,2)' })),
    );
  });

  it('creates the partial indexes the workers rely on', async () => {
    await migrateUp(database.url);
    const { rows } = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
    );
    const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('outbox_messages_unpublished')).toContain('WHERE (published_at IS NULL)');
    expect(byName.get('outbox_messages_unpublished_by_aggregate')).toContain('(aggregate_id, seq) WHERE (published_at IS NULL)');
    expect(byName.get('outbox_messages_unpublished_by_occurrence')).toContain(
      '(occurred_at, event_id) WHERE (published_at IS NULL)',
    );
    expect(byName.get('wager_transactions_pending_reference_due')).toContain("WHERE (status = 'PENDING_REFERENCE'::text)");
    expect(byName.get('wager_transactions_single_reversal_per_reference')).toMatch(/^CREATE UNIQUE INDEX .*WHERE/);
  });
});
