import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Client } from 'pg';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { uuidv7 } from '../../support/uuid';
import { createMigratedDatabase, expectSqlError, insert, insertWallet, type MigratedDatabase, walletRow } from './schema-fixtures';

describe('wallets schema', () => {
  let db: MigratedDatabase;
  let client: Client;

  beforeAll(async () => {
    await ensureInfraUp();
    db = await createMigratedDatabase();
    client = db.client;
  });

  afterAll(() => db?.close());

  it('accepts a valid wallet', async () => {
    const id = await insertWallet(client, { balance: '999999999999999999.99' });
    const { rows } = await client.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = $1', [id]);
    expect(rows[0]!.balance).toBe('999999999999999999.99');
  });

  it('rounds a third decimal place half up (documents why Money must reject it before the database)', async () => {
    const id = await insertWallet(client, { balance: '10.005' });
    const { rows } = await client.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = $1', [id]);
    expect(rows[0]!.balance).toBe('10.01');
  });

  it('rejects a negative balance on insert and on update', async () => {
    await expectSqlError(insert(client, 'wallets', walletRow({ balance: '-0.01' })), '23514', 'wallets_balance_non_negative');
    const id = await insertWallet(client, { balance: '10.00' });
    await expectSqlError(
      client.query('UPDATE wallets SET balance = balance - 10.01 WHERE id = $1', [id]),
      '23514',
      'wallets_balance_non_negative',
    );
  });

  it('rejects a version below 1', async () => {
    await expectSqlError(insert(client, 'wallets', walletRow({ version: 0 })), '23514', 'wallets_version_positive');
  });

  it('rejects an invalid currency', async () => {
    await expectSqlError(insert(client, 'wallets', walletRow({ currency: 'brl' })), '23514', 'wallets_currency_format');
  });

  it('allows one wallet per player and currency', async () => {
    const playerId = uuidv7();
    await insertWallet(client, { player_id: playerId, currency: 'BRL' });
    await insertWallet(client, { player_id: playerId, currency: 'USD' });
    await expectSqlError(
      insert(client, 'wallets', walletRow({ player_id: playerId, currency: 'BRL' })),
      '23505',
      'wallets_player_currency_unique',
    );
  });

  it('never deletes a wallet nor changes its identity, and never moves the version back', async () => {
    const id = await insertWallet(client, { version: 3 });
    await expectSqlError(client.query('DELETE FROM wallets WHERE id = $1', [id]), '23001');
    await expectSqlError(client.query("UPDATE wallets SET currency = 'USD' WHERE id = $1", [id]), '23001');
    await expectSqlError(client.query('UPDATE wallets SET player_id = $2 WHERE id = $1', [id, uuidv7()]), '23001');
    await expectSqlError(client.query('UPDATE wallets SET version = 2 WHERE id = $1', [id]), '23001');
    await client.query("UPDATE wallets SET balance = 5.00, version = 4 WHERE id = $1", [id]);
  });
});
