import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Client } from 'pg';
import { assertWalletConsistency, findWalletInconsistencies } from '../../support/assert-wallet-consistency';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import {
  createMigratedDatabase,
  expectSqlError,
  insert,
  insertLedger,
  insertTransaction,
  insertWallet,
  ledgerRow,
  type MigratedDatabase,
  openingRow,
} from './schema-fixtures';

describe('wallet_ledger_entries schema', () => {
  let db: MigratedDatabase;
  let client: Client;
  let walletId: string;
  let transactionId: string;

  const insertEntry = (overrides = {}) => insert(client, 'wallet_ledger_entries', ledgerRow(walletId, transactionId, overrides));

  beforeAll(async () => {
    await ensureInfraUp();
    db = await createMigratedDatabase();
    client = db.client;
  });

  beforeEach(async () => {
    walletId = await insertWallet(client);
    transactionId = await insertTransaction(client, walletId);
  });

  afterAll(() => db?.close());

  it('accepts a balanced entry and assigns an increasing seq', async () => {
    await insertEntry();
    const other = await insertTransaction(client, walletId);
    await insertLedger(client, walletId, other, { balance_before: '10.00', balance_after: '0.00', direction: 'DEBIT', wallet_version: 2 });
    const { rows } = await client.query<{ seq: string }>(
      'SELECT seq FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY seq',
      [walletId],
    );
    expect(rows).toHaveLength(2);
    expect(BigInt(rows[1]!.seq) > BigInt(rows[0]!.seq)).toBe(true);
  });

  it.each([
    ['zero amount', { amount: '0.00', balance_after: '0.00' }, 'wallet_ledger_entries_amount_positive'],
    ['negative balance_before', { balance_before: '-10.00', balance_after: '0.00' }, 'wallet_ledger_entries_before_non_negative'],
    [
      'negative balance_after',
      { direction: 'DEBIT', balance_before: '5.00', balance_after: '-5.00' },
      'wallet_ledger_entries_after_non_negative',
    ],
    ['broken CREDIT arithmetic', { balance_after: '10.01' }, 'wallet_ledger_entries_arithmetic'],
    ['broken DEBIT arithmetic', { direction: 'DEBIT', balance_before: '20.00', balance_after: '30.00' }, 'wallet_ledger_entries_arithmetic'],
    ['unknown direction', { direction: 'BONUS', balance_before: '10.00', balance_after: '0.00' }, 'wallet_ledger_entries_direction_valid'],
    ['wallet_version 0', { wallet_version: 0 }, 'wallet_ledger_entries_wallet_version_positive'],
  ])('rejects %s', async (_case, overrides, constraint) => {
    await expectSqlError(insertEntry(overrides), '23514', constraint);
  });

  it('allows at most one entry per transaction', async () => {
    await insertEntry();
    await expectSqlError(insertEntry({ wallet_version: 2 }), '23505', 'wallet_ledger_entries_transaction_unique');
  });

  it('allows at most one entry per wallet version', async () => {
    await insertEntry();
    const other = await insertTransaction(client, walletId);
    await expectSqlError(
      insertLedger(client, walletId, other, { balance_before: '10.00', balance_after: '20.00' }),
      '23505',
      'wallet_ledger_entries_wallet_version_unique',
    );
  });

  it('rejects an entry whose transaction belongs to another wallet', async () => {
    const otherWallet = await insertWallet(client);
    await expectSqlError(
      insertLedger(client, otherWallet, transactionId),
      '23503',
      'wallet_ledger_entries_transaction_fk',
    );
  });

  it.each([
    ['REJECTED', { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: null }],
    ['FAILED', { status: 'FAILED', failure_code: 'WALLET_NOT_FOUND', processed_at: null }],
  ])('rejects an entry tied to a %s transaction', async (_status, overrides) => {
    const notProcessed = await insertTransaction(client, walletId, overrides);
    await expectSqlError(
      insert(client, 'wallet_ledger_entries', ledgerRow(walletId, notProcessed)),
      '23503',
      'wallet_ledger_entries_transaction_fk',
    );
  });

  it('rejects an entry in a currency other than the wallet currency', async () => {
    await expectSqlError(insertEntry({ currency: 'USD' }), '23503', 'wallet_ledger_entries_wallet_currency_fk');
  });

  it('is immutable: UPDATE, DELETE and TRUNCATE raise', async () => {
    const id = await insertLedger(client, walletId, transactionId);
    await expectSqlError(client.query('UPDATE wallet_ledger_entries SET amount = 1.00 WHERE id = $1', [id]), '23001');
    await expectSqlError(client.query('UPDATE wallet_ledger_entries SET created_at = created_at WHERE id = $1', [id]), '23001');
    await expectSqlError(client.query('DELETE FROM wallet_ledger_entries WHERE id = $1', [id]), '23001');
    await expectSqlError(client.query('TRUNCATE wallet_ledger_entries'), '23001');
    await expectSqlError(client.query('TRUNCATE wallet_ledger_entries CASCADE'), '23001');
    const { rows } = await client.query<{ amount: string }>('SELECT amount FROM wallet_ledger_entries WHERE id = $1', [id]);
    expect(rows[0]!.amount).toBe('10.00');
  });
});

describe('assertWalletConsistency on the real schema', () => {
  let db: MigratedDatabase;
  let client: Client;

  beforeAll(async () => {
    await ensureInfraUp();
    db = await createMigratedDatabase();
    client = db.client;
  });

  afterAll(() => db?.close());

  const openWithHistory = async (): Promise<string> => {
    const walletId = await insertWallet(client, { balance: '0.00', version: 1 });
    const opening = openingRow(walletId, '100.00');
    await insert(client, 'wager_transactions', opening);
    await insertLedger(client, walletId, opening.id as string, {
      amount: '100.00',
      balance_before: '0.00',
      balance_after: '100.00',
      wallet_version: 1,
    });
    const bet = await insertTransaction(client, walletId, { amount: '30.00', observed_balance: '70.00' });
    await insertLedger(client, walletId, bet, {
      direction: 'DEBIT',
      amount: '30.00',
      balance_before: '100.00',
      balance_after: '70.00',
      wallet_version: 2,
    });
    await insertTransaction(client, walletId, { kind: 'LOSS', amount: '0.00', observed_balance: '70.00' });
    const win = await insertTransaction(client, walletId, { kind: 'WIN', amount: '12.50', observed_balance: '82.50' });
    await insertLedger(client, walletId, win, {
      amount: '12.50',
      balance_before: '70.00',
      balance_after: '82.50',
      wallet_version: 3,
    });
    await client.query('UPDATE wallets SET balance = 82.50, version = 3 WHERE id = $1', [walletId]);
    return walletId;
  };

  it('accepts an OPENING + BET + LOSS + WIN history written through the real constraints', async () => {
    const walletId = await openWithHistory();
    await assertWalletConsistency(client, walletId);
  });

  it('flags a wallet balance that drifted from its ledger', async () => {
    const walletId = await openWithHistory();
    await client.query('UPDATE wallets SET balance = 90.00 WHERE id = $1', [walletId]);

    expect(await findWalletInconsistencies(client, walletId)).toEqual([
      'balance 90.00 differs from ledger sum 82.50',
      'last balance_after 82.50 differs from wallet.balance 90.00',
    ]);
    await expect(assertWalletConsistency(client, walletId)).rejects.toThrow('is inconsistent');
  });

  it('flags a version bump without a ledger entry', async () => {
    const walletId = await openWithHistory();
    await client.query('UPDATE wallets SET version = 4 WHERE id = $1', [walletId]);

    expect(await findWalletInconsistencies(client, walletId)).toEqual([
      'last wallet_version 3 differs from wallet.version 4',
    ]);
  });
});
