import { expect } from 'bun:test';
import { Client } from 'pg';
import { migrateUp } from '../../../src/infrastructure/persistence/mikro-orm/migrator';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { uuidv7 } from '../../support/uuid';

export type Row = Readonly<Record<string, unknown>>;

export interface MigratedDatabase {
  readonly database: TestDatabase;
  readonly client: Client;
  close(): Promise<void>;
}

export const createMigratedDatabase = async (): Promise<MigratedDatabase> => {
  const database = await createTestDatabase();
  await migrateUp(database.url);
  const client = new Client({ connectionString: database.url });
  await client.connect();
  return {
    database,
    client,
    close: async () => {
      await client.end();
      await database.drop();
    },
  };
};

export const insert = async (client: Client, table: string, row: Row): Promise<void> => {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, Object.values(row));
};

export const expectSqlError = async (
  work: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> => {
  const error = (await work.then(
    () => undefined,
    (reason: unknown) => reason,
  )) as { code?: string; constraint?: string; message?: string } | undefined;
  expect(error).toBeDefined();
  expect({ code: error?.code, ...(constraint ? { constraint: error?.constraint } : {}) }).toEqual({
    code,
    ...(constraint ? { constraint } : {}),
  });
};

const NOW = '2026-07-29T15:00:00.000Z';

const playerOfWallet = new Map<string, string>();

/** O player de uma wallet montada por walletRow, para as linhas de transação usarem ele por padrão (FK wallet_id, player_id). */
export const playerOf = (walletId: string): string | undefined => playerOfWallet.get(walletId);

export const walletRow = (overrides: Row = {}): Row => {
  const row = {
    id: uuidv7(),
    player_id: uuidv7(),
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  playerOfWallet.set(row.id as string, row.player_id as string);
  return row;
};

export const insertWallet = async (client: Client, overrides: Row = {}): Promise<string> => {
  const row = walletRow(overrides);
  await insert(client, 'wallets', row);
  return row.id as string;
};

export const transactionRow = (walletId: string, overrides: Row = {}): Row => ({
  id: uuidv7(),
  provider_id: 'provider-a',
  external_transaction_id: `ext-${uuidv7()}`,
  idempotency_key: `key-${uuidv7()}`,
  payload_hash: 'hash',
  wallet_id: walletId,
  player_id: playerOf(walletId) ?? uuidv7(),
  round_id: 'round-1',
  game_id: 'game-1',
  kind: 'BET',
  status: 'PROCESSED',
  amount: '10.00',
  currency: 'BRL',
  observed_balance: '0.00',
  created_at: NOW,
  updated_at: NOW,
  processed_at: NOW,
  ...overrides,
});

export const insertTransaction = async (client: Client, walletId: string, overrides: Row = {}): Promise<string> => {
  const row = transactionRow(walletId, overrides);
  await insert(client, 'wager_transactions', row);
  return row.id as string;
};

export const openingRow = (walletId: string, amount: string, overrides: Row = {}): Row =>
  transactionRow(walletId, {
    provider_id: 'system',
    external_transaction_id: `opening:${walletId}`,
    idempotency_key: `opening:${walletId}`,
    kind: 'OPENING',
    round_id: null,
    game_id: null,
    amount,
    observed_balance: amount,
    ...overrides,
  });

export const ledgerRow = (walletId: string, transactionId: string, overrides: Row = {}): Row => ({
  id: uuidv7(),
  wallet_id: walletId,
  transaction_id: transactionId,
  direction: 'CREDIT',
  amount: '10.00',
  currency: 'BRL',
  balance_before: '0.00',
  balance_after: '10.00',
  wallet_version: 1,
  created_at: NOW,
  ...overrides,
});

export const insertLedger = async (
  client: Client,
  walletId: string,
  transactionId: string,
  overrides: Row = {},
): Promise<string> => {
  const row = ledgerRow(walletId, transactionId, overrides);
  await insert(client, 'wallet_ledger_entries', row);
  return row.id as string;
};
