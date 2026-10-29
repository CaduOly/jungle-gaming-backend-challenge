import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { uuidv7 } from '../../support/uuid';
import {
  createMigratedDatabase,
  expectSqlError,
  insert,
  insertTransaction,
  insertWallet,
  type MigratedDatabase,
  openingRow,
  playerOf,
  transactionRow,
} from './schema-fixtures';

describe('wager_transactions schema', () => {
  let db: MigratedDatabase;
  let client: Client;
  let walletId: string;

  const insertTx = (overrides = {}) => insert(client, 'wager_transactions', transactionRow(walletId, overrides));

  beforeAll(async () => {
    await ensureInfraUp();
    db = await createMigratedDatabase();
    client = db.client;
    walletId = await insertWallet(client, { balance: '100.00' });
  });

  afterAll(() => db?.close());

  describe('uniqueness', () => {
    it('rejects the same idempotency key twice for a provider', async () => {
      await insertTx({ idempotency_key: 'key-dup' });
      await expectSqlError(insertTx({ idempotency_key: 'key-dup' }), '23505', 'wager_transactions_provider_idempotency_key_unique');
      await insertTx({ idempotency_key: 'key-dup', provider_id: 'provider-b' });
    });

    it('rejects the same external transaction id twice for a provider', async () => {
      await insertTx({ external_transaction_id: 'ext-dup' });
      await expectSqlError(insertTx({ external_transaction_id: 'ext-dup' }), '23505', 'wager_transactions_provider_external_id_unique');
    });
  });

  describe('wallet and currency', () => {
    it('rejects an unknown wallet', async () => {
      await expectSqlError(
        insert(client, 'wager_transactions', transactionRow(uuidv7())),
        '23503',
        'wager_transactions_wallet_fk',
      );
    });

    it('rejects a currency different from the wallet currency', async () => {
      await expectSqlError(insertTx({ currency: 'USD' }), '23503', 'wager_transactions_wallet_currency_fk');
    });

    it('still persists a CURRENCY_MISMATCH rejection in the requested currency', async () => {
      await insertTx({ currency: 'USD', status: 'REJECTED', failure_code: 'CURRENCY_MISMATCH', processed_at: null });
    });

    it('rejects a player other than the wallet player', async () => {
      await expectSqlError(insertTx({ player_id: uuidv7() }), '23503', 'wager_transactions_wallet_player_fk');
      await expectSqlError(
        insertTx({ player_id: uuidv7(), status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: null }),
        '23503',
        'wager_transactions_wallet_player_fk',
      );
    });

    it('still persists a WALLET_PLAYER_MISMATCH rejection with the player the provider sent', async () => {
      const strangerId = uuidv7();
      const id = await insertTransaction(client, walletId, {
        player_id: strangerId,
        status: 'REJECTED',
        failure_code: 'WALLET_PLAYER_MISMATCH',
        processed_at: null,
      });
      const { rows } = await client.query<{ player_id: string; wallet_player_id: string | null }>(
        'SELECT player_id, wallet_player_id FROM wager_transactions WHERE id = $1',
        [id],
      );
      expect(rows[0]).toEqual({ player_id: strangerId, wallet_player_id: null });
      expect(playerOf(walletId)).not.toBe(strangerId);
    });
  });

  describe('amount, kind and reference', () => {
    it('requires amount > 0 except for LOSS, which accepts 0.00', async () => {
      await expectSqlError(insertTx({ amount: '0.00' }), '23514', 'wager_transactions_amount_by_kind');
      await expectSqlError(insertTx({ kind: 'LOSS', amount: '-1.00' }), '23514', 'wager_transactions_amount_by_kind');
      await insertTx({ kind: 'LOSS', amount: '0.00' });
    });

    it('rejects unknown kinds and the in-memory PENDING status', async () => {
      await expectSqlError(insertTx({ kind: 'BONUS' }), '23514', 'wager_transactions_kind_valid');
      await expectSqlError(insertTx({ status: 'PENDING', processed_at: null }), '23514', 'wager_transactions_status_valid');
    });

    it.each(['REFUND', 'ROLLBACK'])('requires a reference for %s', async (kind) => {
      await expectSqlError(
        insertTx({ kind, status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', processed_at: null }),
        '23514',
        'wager_transactions_reversal_requires_reference',
      );
    });

    it.each(['BET', 'OPENING'])('rejects a reference on %s', async (kind) => {
      const id = await insertWallet(client);
      const row =
        kind === 'OPENING'
          ? openingRow(id, '5.00', { reference_external_transaction_id: 'ext-1' })
          : transactionRow(id, { reference_external_transaction_id: 'ext-1' });
      await expectSqlError(
        insert(client, 'wager_transactions', row),
        '23514',
        kind === 'OPENING' ? 'wager_transactions_opening_without_reference' : 'wager_transactions_reference_only_on_referencing_kinds',
      );
    });

    it.each(['WIN', 'LOSS'])('accepts a reference on %s', async (kind) => {
      const betId = await insertTransaction(client, walletId, { external_transaction_id: `bet-${kind}` });
      await insertTx({ kind, reference_external_transaction_id: `bet-${kind}`, reference_transaction_id: betId });
    });

    it('never keeps a BET in PENDING_REFERENCE', async () => {
      await expectSqlError(
        insertTx({ status: 'PENDING_REFERENCE', processed_at: null, observed_balance: null, next_attempt_at: '2026-07-29T15:00:02Z' }),
        '23514',
        'wager_transactions_bet_never_pending',
      );
    });

    it('rejects a resolved reference to an unknown transaction', async () => {
      await expectSqlError(
        insertTx({ kind: 'WIN', reference_external_transaction_id: 'ext-x', reference_transaction_id: uuidv7() }),
        '23503',
        'wager_transactions_reference_fk',
      );
    });
  });

  describe('status coherence', () => {
    it('requires processed_at exactly when PROCESSED', async () => {
      await expectSqlError(insertTx({ processed_at: null }), '23514', 'wager_transactions_processed_has_processed_at');
      await expectSqlError(
        insertTx({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }),
        '23514',
        'wager_transactions_processed_has_processed_at',
      );
    });

    it.each(['REJECTED', 'FAILED'])('requires a failure code when %s', async (status) => {
      await expectSqlError(insertTx({ status, processed_at: null }), '23514', 'wager_transactions_failure_code_by_status');
    });

    it('rejects a failure code on a PROCESSED transaction', async () => {
      await expectSqlError(insertTx({ failure_code: 'INSUFFICIENT_FUNDS' }), '23514', 'wager_transactions_failure_code_by_status');
    });

    it('accepts only the known failure codes', async () => {
      await expectSqlError(
        insertTx({ status: 'REJECTED', failure_code: 'SOMETHING_ELSE', processed_at: null }),
        '23514',
        'wager_transactions_failure_code_valid',
      );
      await insertTx({ status: 'REJECTED', failure_code: 'REFERENCE_MISMATCH', processed_at: null });
    });

    it('records the observed balance on every outcome', async () => {
      await expectSqlError(insertTx({ observed_balance: null }), '23514', 'wager_transactions_observed_balance_on_outcome');
    });
  });

  describe('OPENING', () => {
    it('accepts one OPENING per wallet, from the reserved system provider', async () => {
      const id = await insertWallet(client);
      await insert(client, 'wager_transactions', openingRow(id, '50.00'));
      await expectSqlError(
        insert(client, 'wager_transactions', openingRow(id, '50.00', { id: uuidv7() })),
        '23505',
        'wager_transactions_provider_idempotency_key_unique',
      );
    });

    it('rejects an OPENING with a reference', async () => {
      const id = await insertWallet(client);
      await expectSqlError(
        insert(client, 'wager_transactions', openingRow(id, '5.00', { reference_external_transaction_id: 'ext-1' })),
        '23514',
        'wager_transactions_opening_without_reference',
      );
    });

    it('rejects an OPENING with another provider or key, and the system provider for other kinds', async () => {
      const id = await insertWallet(client);
      await expectSqlError(
        insert(client, 'wager_transactions', openingRow(id, '5.00', { provider_id: 'provider-a' })),
        '23514',
        'wager_transactions_system_provider_only_for_opening',
      );
      await expectSqlError(
        insert(client, 'wager_transactions', openingRow(id, '5.00', { idempotency_key: 'opening:other' })),
        '23514',
        'wager_transactions_opening_shape',
      );
      await expectSqlError(insertTx({ provider_id: 'system' }), '23514', 'wager_transactions_system_provider_only_for_opening');
    });
  });

  describe('single reversal per reference', () => {
    it('blocks a PROCESSED ROLLBACK after a PROCESSED REFUND of the same reference', async () => {
      const betId = await insertTransaction(client, walletId, { external_transaction_id: 'bet-reversed' });
      const reversal = { reference_external_transaction_id: 'bet-reversed', reference_transaction_id: betId };
      await insertTx({ kind: 'REFUND', ...reversal });
      await expectSqlError(insertTx({ kind: 'ROLLBACK', ...reversal }), '23505', 'wager_transactions_single_reversal_per_reference');
      await insertTx({
        kind: 'ROLLBACK',
        ...reversal,
        status: 'REJECTED',
        failure_code: 'ALREADY_REVERSED',
        processed_at: null,
      });
    });

    it('never lets a reversal in wallet B take the slot of a BET in wallet A', async () => {
      const otherWalletId = await insertWallet(client, { balance: '100.00' });
      const betId = await insertTransaction(client, walletId, { external_transaction_id: 'bet-of-a' });
      const reversal = { kind: 'REFUND', reference_external_transaction_id: 'bet-of-a', reference_transaction_id: betId };

      await expectSqlError(
        insert(client, 'wager_transactions', transactionRow(otherWalletId, reversal)),
        '23503',
        'wager_transactions_reference_fk',
      );
      await insertTx(reversal);
    });

    it('lets exactly one of two concurrent reversals of the same BET commit', async () => {
      const betId = await insertTransaction(client, walletId, { external_transaction_id: 'bet-raced' });
      const reversal = (kind: string) =>
        transactionRow(walletId, { kind, reference_external_transaction_id: 'bet-raced', reference_transaction_id: betId });
      const [first, second] = [new Client({ connectionString: db.database.url }), new Client({ connectionString: db.database.url })];
      await Promise.all([first.connect(), second.connect()]);
      try {
        await first.query('BEGIN');
        await second.query('BEGIN');
        await insert(first, 'wager_transactions', reversal('REFUND'));
        const racing = insert(second, 'wager_transactions', reversal('ROLLBACK')).then(
          () => 'inserted',
          (error: { code?: string; constraint?: string }) => `${error.code}:${error.constraint}`,
        );
        await Bun.sleep(100);
        await first.query('COMMIT');
        expect(await racing).toBe('23505:wager_transactions_single_reversal_per_reference');
        await second.query('ROLLBACK');
      } finally {
        await Promise.all([first.end(), second.end()]);
      }
      const { rows } = await client.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM wager_transactions WHERE reference_transaction_id = $1 AND status = 'PROCESSED'",
        [betId],
      );
      expect(rows[0]!.total).toBe('1');
    });

    it('requires a PROCESSED reversal to point to the resolved reference', async () => {
      await expectSqlError(
        insertTx({ kind: 'REFUND', reference_external_transaction_id: 'ext-1' }),
        '23514',
        'wager_transactions_processed_reversal_resolved',
      );
    });
  });

  describe('transitions (trigger)', () => {
    const pendingReference = () =>
      insertTransaction(client, walletId, {
        kind: 'ROLLBACK',
        status: 'PENDING_REFERENCE',
        reference_external_transaction_id: `missing-${uuidv7()}`,
        processed_at: null,
        observed_balance: null,
        next_attempt_at: '2026-07-29T15:00:02.000Z',
      });

    it('lets PENDING_REFERENCE be retried and then PROCESSED', async () => {
      const id = await pendingReference();
      const referenceId = await insertTransaction(client, walletId);
      await client.query(
        "UPDATE wager_transactions SET attempts = 1, next_attempt_at = '2026-07-29T15:00:06Z', locked_until = now() WHERE id = $1",
        [id],
      );
      await client.query(
        `UPDATE wager_transactions
            SET status = 'PROCESSED', processed_at = now(), observed_balance = 90.00,
                reference_transaction_id = $2, locked_until = NULL
          WHERE id = $1`,
        [id, referenceId],
      );
    });

    it('lets PENDING_REFERENCE be REJECTED', async () => {
      const id = await pendingReference();
      await client.query(
        "UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', observed_balance = 0 WHERE id = $1",
        [id],
      );
    });

    it('requires PENDING_REFERENCE to wait for a reference with a next attempt', async () => {
      await expectSqlError(
        insertTx({ status: 'PENDING_REFERENCE', processed_at: null, kind: 'WIN', reference_external_transaction_id: 'x' }),
        '23514',
        'wager_transactions_pending_reference_waits_for_reference',
      );
    });

    it('never leaves a terminal status', async () => {
      const processed = await insertTransaction(client, walletId);
      await expectSqlError(
        client.query(
          "UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', processed_at = NULL WHERE id = $1",
          [processed],
        ),
        '23001',
      );
      const rejected = await insertTransaction(client, walletId, {
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
        processed_at: null,
      });
      await expectSqlError(
        client.query(
          "UPDATE wager_transactions SET status = 'PROCESSED', failure_code = NULL, processed_at = now() WHERE id = $1",
          [rejected],
        ),
        '23001',
      );
      const failed = await insertTransaction(client, walletId, { status: 'FAILED', failure_code: 'WALLET_NOT_FOUND', processed_at: null });
      await expectSqlError(client.query('UPDATE wager_transactions SET locked_until = now() WHERE id = $1', [failed]), '23001');
    });

    it('never changes immutable columns, even while pending', async () => {
      const id = await pendingReference();
      await expectSqlError(client.query('UPDATE wager_transactions SET amount = 1.00 WHERE id = $1', [id]), '23001');
      await expectSqlError(client.query("UPDATE wager_transactions SET payload_hash = 'other' WHERE id = $1", [id]), '23001');
      await expectSqlError(client.query("UPDATE wager_transactions SET idempotency_key = 'other' WHERE id = $1", [id]), '23001');
    });

    it('never deletes nor truncates transactions', async () => {
      const id = await insertTransaction(client, walletId);
      await expectSqlError(client.query('DELETE FROM wager_transactions WHERE id = $1', [id]), '23001');
      await expectSqlError(client.query('TRUNCATE wager_transactions CASCADE'), '23001');
      await expectSqlError(client.query('TRUNCATE wallets CASCADE'), '23001');
      await expectSqlError(client.query('TRUNCATE wallets'), '0A000');
      await expectSqlError(client.query('TRUNCATE wallets, wager_transactions, wallet_ledger_entries CASCADE'), '23001');
      const { rows } = await client.query<{ found: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM wager_transactions WHERE id = $1) AS found',
        [id],
      );
      expect(rows[0]!.found).toBe(true);
    });
  });
});
